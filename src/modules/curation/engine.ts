import {
  ContentEnvelopeSchema,
  DecisionTraceSchema,
  EditionRequestSchema,
  type ContentEnvelope,
  type DecisionTrace,
  type FramedRecommendation,
  type Provenance,
} from "../../contracts";
import type {
  CandidateDecision,
  CurationOptions,
  CurationProfile,
  CurationResult,
  EditionInput,
  ExclusionReason,
  WeightedCandidate,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

interface PreparedCandidate {
  item: ContentEnvelope;
  format: string;
  energy: number;
  matchedInterests: string[];
  score: number;
  exploration: boolean;
  inputIndex: number;
}

interface CandidateWithReason {
  item?: ContentEnvelope;
  contentId: string;
  canonicalUri?: string;
  reason: ExclusionReason;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function asArray(value: readonly string[] | undefined): string[] {
  return (value ?? []).map(normalize).filter(Boolean);
}

function mapValues(value: CurationProfile["learnedAdjustments"]): Map<string, number> {
  if (!value) return new Map();
  const output = new Map<string, number>();
  if (value instanceof Map) {
    for (const [key, adjustment] of value.entries() as Iterable<[string, number]>) {
      output.set(normalize(key), Number.isFinite(adjustment) ? adjustment : 0);
    }
    return output;
  }
  const entries = Object.entries(value) as Array<[string, number]>;
  for (const [key, adjustment] of entries) {
    output.set(normalize(key), Number.isFinite(adjustment) ? adjustment : 0);
  }
  return output;
}

function lookupDates(value: CurationProfile["notNow"]): Map<string, string> {
  if (!value) return new Map();
  const output = new Map<string, string>();
  if (value instanceof Map) {
    for (const [key, date] of value.entries() as Iterable<[string, string]>)
      output.set(normalize(key), date);
    return output;
  }
  if (isNotNowList(value)) {
    for (const entry of value) {
      const keys = [entry.contentId, entry.canonicalUri].filter((key): key is string =>
        Boolean(key),
      );
      for (const key of keys) output.set(normalize(key), entry.until);
    }
    return output;
  }
  const entries = Object.entries(value) as Array<[string, string]>;
  for (const [key, date] of entries) output.set(normalize(key), date);
  return output;
}

function isNotNowList(
  value: CurationProfile["notNow"],
): value is NonNullable<CurationProfile["notNow"]> &
  readonly { until: string; contentId?: string; canonicalUri?: string }[] {
  return Array.isArray(value);
}

function lookupShown(value: CurationProfile["recentlyShown"]): Map<string, string> {
  if (!value) return new Map();
  return new Map(
    value.flatMap((entry) => {
      const keys = [entry.contentId, entry.canonicalUri].filter((key): key is string =>
        Boolean(key),
      );
      return keys.map((key) => [normalize(key), entry.shownAt] as const);
    }),
  );
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function stableSeed(
  ownerId: string,
  requestedAt: string,
  explicitSeed?: string | number,
): number {
  return hashSeed(
    explicitSeed === undefined ? `${ownerId}\u0000${requestedAt}` : String(explicitSeed),
  );
}

function randomSequence(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick<T>(
  items: readonly WeightedCandidate<T>[],
  next: () => number,
): T | undefined {
  if (!items.length) return undefined;
  const weights = items.map((item) =>
    Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 0,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return items[0]?.value;
  let target = next() * total;
  for (let index = 0; index < items.length; index += 1) {
    target -= weights[index] ?? 0;
    if (target < 0) return items[index]?.value;
  }
  return items.at(-1)?.value;
}

export function weightedSample<T>(
  items: readonly WeightedCandidate<T>[],
  seed: string | number = 0,
): T | undefined {
  return weightedPick(items, randomSequence(hashSeed(String(seed))));
}

export function mapCuriosityToExplorationSlots(curiosity: number): number {
  const bounded = Math.max(0, Math.min(100, Math.trunc(curiosity)));
  return 1 + Math.floor((bounded * 4) / 100);
}

export function formatOf(item: ContentEnvelope): string {
  const media = item.media[0]?.kind;
  if (media) return media;
  const block = item.blocks[0];
  if (!block) return "text";
  if (block.kind === "heading" || block.kind === "paragraph") return "text";
  return block.kind;
}

/** Structural energy uses only renderable shape, not semantic sentiment. */
export function estimateStructuralEnergy(item: ContentEnvelope): number {
  const format = formatOf(item);
  const base: Record<string, number> = {
    text: 18,
    quote: 24,
    link: 30,
    code: 42,
    image: 52,
    audio: 68,
    video: 82,
  };
  const characters = item.blocks.reduce((total, block) => {
    if ("text" in block) return total + block.text.length;
    if ("code" in block) return total + block.code.length;
    return total;
  }, 0);
  const density = Math.min(16, Math.max(0, item.blocks.length - 1) * 4);
  const length = Math.min(20, characters / 300);
  const media = Math.min(20, item.media.length * 10);
  return Math.round(Math.max(0, Math.min(100, (base[format] ?? 35) + density + length + media)));
}

function referenceFor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//.test(value) || /^at:\/\/did:/.test(value)) return value;
  return undefined;
}

function provenance(requestedAt: string, source: string, reference?: string): Provenance {
  const value: Provenance = { source, observedAt: requestedAt };
  const safeReference = referenceFor(reference);
  if (safeReference) value.reference = safeReference;
  return value;
}

function trace(
  requestedAt: string,
  source: string,
  factors: Array<{ factor: string; weight: number; reference?: string }>,
  reference?: string,
): DecisionTrace {
  return DecisionTraceSchema.parse({
    generatedAt: requestedAt,
    factors: factors.map((factor) => ({
      factor: factor.factor,
      weight: Number.isFinite(factor.weight) ? factor.weight : 0,
      provenance: provenance(requestedAt, source, factor.reference ?? reference),
    })),
  });
}

function profileInterests(options: CurationOptions): string[] {
  return [
    ...new Set([...asArray(options.manualInterests), ...asArray(options.confirmedInterests)]),
  ];
}

function scoreCandidate(
  item: ContentEnvelope,
  format: string,
  energy: number,
  interests: readonly string[],
  adjustments: ReadonlyMap<string, number>,
  targetEnergy: number,
  requestedAt: string,
): { score: number; matchedInterests: string[] } {
  const tags = item.tags.map((tag) => normalize(tag.value));
  const matchedInterests = interests.filter((interest) => tags.includes(interest));
  const interestScore = matchedInterests.length * 36;
  const age = Math.max(0, new Date(requestedAt).getTime() - new Date(item.publishedAt).getTime());
  const freshness = Math.max(0, 20 - Math.min(20, age / (7 * DAY_MS)));
  const energyFit = Math.max(0, 30 - Math.abs(energy - targetEnergy) * 0.3);
  const tagAdjustment = tags.reduce(
    (total, tag) => total + (adjustments.get(`tag:${tag}`) ?? 0),
    0,
  );
  const sourceAdjustment = adjustments.get(`source:${normalize(item.sourceId)}`) ?? 0;
  const formatAdjustment = adjustments.get(`format:${normalize(format)}`) ?? 0;
  const contentAdjustment = adjustments.get(`content:${normalize(item.id)}`) ?? 0;
  return {
    matchedInterests,
    score:
      interestScore +
      freshness +
      energyFit +
      tagAdjustment +
      sourceAdjustment +
      formatAdjustment +
      contentAdjustment,
  };
}

function isBeforeBoundary(value: string, nowMs: number, durationMs: number): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && nowMs - timestamp < durationMs && timestamp <= nowMs;
}

function isSuppressedUntil(value: string, nowMs: number): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

function exclusionDecision(requestedAt: string, candidate: CandidateWithReason): CandidateDecision {
  return {
    contentId: candidate.contentId,
    canonicalUri: candidate.canonicalUri,
    selected: false,
    reason: candidate.reason,
    decisionTrace: trace(
      requestedAt,
      "policy",
      [{ factor: `excluded:${candidate.reason}`, weight: 0, reference: candidate.canonicalUri }],
      candidate.canonicalUri,
    ),
  };
}

function selectedTrace(
  requestedAt: string,
  candidate: PreparedCandidate,
  targetEnergy: number,
  exploration: boolean,
): DecisionTrace {
  return trace(
    requestedAt,
    "curation",
    [
      ...(candidate.matchedInterests.length
        ? [{ factor: "interest-match", weight: candidate.matchedInterests.length }]
        : []),
      { factor: "freshness", weight: 1 },
      { factor: "energy-fit", weight: Math.round(100 - Math.abs(candidate.energy - targetEnergy)) },
      { factor: exploration ? "exploration" : "exploitation", weight: 1 },
    ],
    candidate.item.canonicalUri,
  );
}

function frameFor(format: string): string {
  return format === "heading" ? "text" : format;
}

function idForSlate(ownerId: string, requestedAt: string, seed: number): string {
  return `edition-${hashSeed(`${ownerId}\u0000${requestedAt}\u0000${seed}`).toString(16).padStart(8, "0")}`;
}

export class CurationEngine {
  generate(
    request: EditionInput,
    candidates: readonly ContentEnvelope[],
    options: CurationOptions = {},
  ): CurationResult {
    const parsedRequest = EditionRequestSchema.parse({ ...request, limit: request.limit ?? 12 });
    const requestedAt = parsedRequest.requestedAt;
    const nowMs = new Date(requestedAt).getTime();
    const interests = profileInterests(options);
    const learned = mapValues(options.learnedAdjustments);
    const configuredLabels = new Set(
      asArray([
        ...(options.configuredLabels ?? []),
        ...(options.excludedLabels ?? []),
        ...(options.blockedLabels ?? []),
      ]),
    );
    const mutedSources = new Set(asArray(options.mutedSources));
    const notNow = lookupDates(options.notNow);
    const shown = lookupShown(options.recentlyShown ?? options.shown);
    const excluded: CandidateDecision[] = [];
    const prepared: PreparedCandidate[] = [];
    const rejected: CandidateWithReason[] = [];
    const seenIds = new Set<string>();
    const eligibleByCanonical = new Map<string, { item: ContentEnvelope; index: number }>();
    const seed = stableSeed(parsedRequest.ownerId, requestedAt, options.seed ?? request.seed);
    const explicitExploration = new Set((options.explorationIds ?? []).map(normalize));

    candidates.forEach((candidate, inputIndex) => {
      const parsed = ContentEnvelopeSchema.safeParse(candidate);
      if (!parsed.success) {
        const raw = (
          candidate && typeof candidate === "object" ? candidate : {}
        ) as Partial<ContentEnvelope>;
        const rejectedCandidate = {
          contentId: String(raw.id ?? `candidate-${inputIndex}`),
          canonicalUri: raw.canonicalUri,
        };
        rejected.push({ ...rejectedCandidate, reason: "unsafe-content" });
        return;
      }
      const item = parsed.data;
      const id = normalize(item.id);
      const canonical = normalize(item.canonicalUri);
      if (seenIds.has(id)) {
        rejected.push({
          item,
          contentId: item.id,
          canonicalUri: item.canonicalUri,
          reason: "duplicate-content",
        });
        return;
      }
      seenIds.add(id);
      const addRejected = (reason: ExclusionReason): void => {
        rejected.push({ item, contentId: item.id, canonicalUri: item.canonicalUri, reason });
      };
      if (!item.blocks.length) {
        addRejected("missing-content");
        return;
      }
      if (item.labels.some((label) => configuredLabels.has(normalize(label.value)))) {
        addRejected("configured-label");
        return;
      }
      if (mutedSources.has(normalize(item.sourceId))) {
        addRejected("muted-source");
        return;
      }
      const suppression = notNow.get(id) ?? notNow.get(canonical);
      if (suppression && isSuppressedUntil(suppression, nowMs)) {
        addRejected("not-now");
        return;
      }
      const shownAt = shown.get(id) ?? shown.get(canonical);
      if (shownAt && isBeforeBoundary(shownAt, nowMs, THIRTY_DAYS_MS)) {
        addRejected("already-shown");
        return;
      }
      const existing = eligibleByCanonical.get(canonical);
      if (existing) {
        const winner = [existing, { item, index: inputIndex }].sort((left, right) => {
          const byId = left.item.id.localeCompare(right.item.id);
          return byId || left.index - right.index;
        })[0];
        if (winner.item.id !== existing.item.id) {
          rejected.push({
            item: existing.item,
            contentId: existing.item.id,
            canonicalUri: existing.item.canonicalUri,
            reason: "duplicate-canonical",
          });
          eligibleByCanonical.set(canonical, { item, index: inputIndex });
        } else {
          addRejected("duplicate-canonical");
        }
        return;
      }
      eligibleByCanonical.set(canonical, { item, index: inputIndex });
    });

    for (const { item, index } of eligibleByCanonical.values()) {
      const format = formatOf(item);
      const energy = estimateStructuralEnergy(item);
      const scored = scoreCandidate(
        item,
        format,
        energy,
        interests,
        learned,
        parsedRequest.energy,
        requestedAt,
      );
      const exploration =
        explicitExploration.has(normalize(item.id)) ||
        (options.isExploration
          ? options.isExploration(item, scored.matchedInterests)
          : scored.matchedInterests.length === 0);
      prepared.push({
        item,
        format,
        energy,
        matchedInterests: scored.matchedInterests,
        score: scored.score,
        exploration,
        inputIndex: index,
      });
    }
    prepared.sort(
      (left, right) =>
        left.item.id.localeCompare(right.item.id) || left.inputIndex - right.inputIndex,
    );

    const next = randomSequence(seed);
    const selected: PreparedCandidate[] = [];
    const selectedIds = new Set<string>();
    const sourceCounts = new Map<string, number>();
    const selectedFormats = new Set<string>();
    const maxItems = Math.min(12, parsedRequest.limit);
    let explorationRemaining = Math.min(
      mapCuriosityToExplorationSlots(parsedRequest.curiosity),
      maxItems,
    );

    const available = (pool: readonly PreparedCandidate[]): PreparedCandidate[] =>
      pool.filter(
        (candidate) =>
          !selectedIds.has(candidate.item.id) &&
          (sourceCounts.get(normalize(candidate.item.sourceId)) ?? 0) < 2,
      );
    const choose = (
      pool: readonly PreparedCandidate[],
      forceExploration: boolean,
    ): PreparedCandidate | undefined => {
      let candidatesForChoice = available(pool).filter(
        (candidate) => !forceExploration || candidate.exploration,
      );
      if (!candidatesForChoice.length && forceExploration) return undefined;
      const alternativeFormat = candidatesForChoice.some(
        (candidate) => !selectedFormats.has(candidate.format),
      );
      if (alternativeFormat)
        candidatesForChoice = candidatesForChoice.filter(
          (candidate) => !selectedFormats.has(candidate.format),
        );
      candidatesForChoice.sort(
        (left, right) =>
          left.item.id.localeCompare(right.item.id) || left.inputIndex - right.inputIndex,
      );
      const minimum = Math.min(...candidatesForChoice.map((candidate) => candidate.score), 0);
      return weightedPick(
        candidatesForChoice.map((candidate) => ({
          value: candidate,
          weight: Math.max(0.01, candidate.score - minimum + 1),
        })),
        next,
      );
    };

    while (selected.length < maxItems) {
      const candidate = choose(prepared, explorationRemaining > 0);
      if (!candidate) {
        explorationRemaining = 0;
        const fallback = choose(prepared, false);
        if (!fallback) break;
        selected.push(fallback);
        selectedIds.add(fallback.item.id);
        sourceCounts.set(
          normalize(fallback.item.sourceId),
          (sourceCounts.get(normalize(fallback.item.sourceId)) ?? 0) + 1,
        );
        selectedFormats.add(fallback.format);
        continue;
      }
      selected.push(candidate);
      selectedIds.add(candidate.item.id);
      sourceCounts.set(
        normalize(candidate.item.sourceId),
        (sourceCounts.get(normalize(candidate.item.sourceId)) ?? 0) + 1,
      );
      selectedFormats.add(candidate.format);
      explorationRemaining = Math.max(0, explorationRemaining - (candidate.exploration ? 1 : 0));
    }

    const slateId = idForSlate(parsedRequest.ownerId, requestedAt, seed);
    const selectedItems: FramedRecommendation[] = selected.map((candidate, position) => ({
      id: `${slateId}:${candidate.item.id}`,
      contentId: candidate.item.id,
      frame: frameFor(candidate.format),
      position,
      decisionTrace: selectedTrace(
        requestedAt,
        candidate,
        parsedRequest.energy,
        candidate.exploration,
      ),
    }));
    const slate = {
      id: slateId,
      ownerId: parsedRequest.ownerId,
      createdAt: requestedAt,
      curiosity: parsedRequest.curiosity,
      energy: parsedRequest.energy,
      items: selectedItems,
      decisionTrace: trace(requestedAt, "curation", [
        { factor: "eligible-candidates", weight: prepared.length },
        { factor: "selected-items", weight: selected.length },
        {
          factor: "reserved-exploration-slots",
          weight: mapCuriosityToExplorationSlots(parsedRequest.curiosity),
        },
      ]),
    };

    const traces = new Map<string, DecisionTrace>();
    for (const decision of rejected) {
      const value = exclusionDecision(requestedAt, decision);
      excluded.push(value);
      traces.set(value.contentId, value.decisionTrace);
    }
    for (const candidate of prepared) {
      const isSelected = selectedIds.has(candidate.item.id);
      const decision: CandidateDecision = isSelected
        ? {
            contentId: candidate.item.id,
            canonicalUri: candidate.item.canonicalUri,
            selected: true,
            decisionTrace: selectedTrace(
              requestedAt,
              candidate,
              parsedRequest.energy,
              candidate.exploration,
            ),
          }
        : {
            contentId: candidate.item.id,
            canonicalUri: candidate.item.canonicalUri,
            selected: false,
            reason:
              sourceCounts.get(normalize(candidate.item.sourceId)) === 2
                ? "source-cap"
                : "not-selected",
            decisionTrace: trace(
              requestedAt,
              "curation",
              [
                {
                  factor: `excluded:${sourceCounts.get(normalize(candidate.item.sourceId)) === 2 ? "source-cap" : "not-selected"}`,
                  weight: 0,
                },
              ],
              candidate.item.canonicalUri,
            ),
          };
      traces.set(candidate.item.id, decision.decisionTrace);
      if (!decision.selected) excluded.push(decision);
    }

    return { slate, selected: selected.map((candidate) => candidate.item), excluded, traces, seed };
  }
}

export function createDeterministicEdition(
  request: EditionInput,
  candidates: readonly ContentEnvelope[],
  options: CurationOptions = {},
): CurationResult {
  return new CurationEngine().generate(request, candidates, options);
}

export const generateEdition = createDeterministicEdition;
export const buildEdition = createDeterministicEdition;
export const curate = createDeterministicEdition;
