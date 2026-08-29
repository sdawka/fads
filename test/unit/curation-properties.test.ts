import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CurationEngine,
  mapCuriosityToExplorationSlots,
  type CurationOptions,
} from "../../src/modules/curation";
import type { ContentEnvelope } from "../../src/contracts";

const requestedAt = "2026-08-28T12:00:00.000Z";

function item(id: string, sourceId: string, canonicalUri: string): ContentEnvelope {
  return {
    id,
    sourceId,
    canonicalUri,
    publishedAt: requestedAt,
    capturedAt: requestedAt,
    blocks: [{ kind: "paragraph", text: id }],
    media: [],
    tags: [{ value: "known", provenance: { source: "test", observedAt: requestedAt } }],
    labels: [],
  };
}

function generatedItem(
  index: number,
  sourceIndex: number,
  canonicalIndex: number,
  formatIndex: number,
  labelled: boolean,
): ContentEnvelope {
  const format = ["text", "quote", "code", "image"][formatIndex % 4] ?? "text";
  const block: ContentEnvelope["blocks"][number] =
    format === "quote"
      ? { kind: "quote", text: `quote-${index}` }
      : format === "code"
        ? { kind: "code", code: `const item${index} = true;` }
        : format === "image"
          ? { kind: "image", src: `https://example.com/image-${index}.jpg`, alt: `image-${index}` }
          : { kind: "paragraph", text: `item-${index}` };
  return {
    id: `generated-${index}`,
    sourceId: `source-${sourceIndex}`,
    canonicalUri: `https://example.com/canonical-${canonicalIndex}`,
    publishedAt: requestedAt,
    capturedAt: requestedAt,
    blocks: [block],
    media: [],
    tags: [
      {
        value: index % 2 ? "known" : "novel",
        provenance: { source: "test", observedAt: requestedAt },
      },
    ],
    labels: labelled
      ? [{ value: "blocked", provenance: { source: "moderation", observedAt: requestedAt } }]
      : [],
  };
}

describe("curation invariants", () => {
  it("keeps every generated edition within hard structural invariants", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/), { minLength: 0, maxLength: 30 }),
        (ids) => {
          const candidates = ids.map((id, index) =>
            item(id, `source-${index % 5}`, `https://example.com/${id}`),
          );
          const result = new CurationEngine().generate(
            { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 12 },
            candidates,
            { seed: "property" },
          );
          const sourceCounts = new Map<string, number>();
          for (const recommendation of result.slate.items) {
            const source = candidates.find(
              (candidate) => candidate.id === recommendation.contentId,
            )?.sourceId;
            if (source) sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
          }
          expect(result.slate.items.length).toBeLessThanOrEqual(12);
          expect(
            new Set(result.slate.items.map((recommendation) => recommendation.contentId)).size,
          ).toBe(result.slate.items.length);
          expect([...sourceCounts.values()].every((count) => count <= 2)).toBe(true);
          expect(
            result.slate.items.filter((recommendation) =>
              recommendation.decisionTrace.factors.some(
                (factor) => factor.factor === "exploration",
              ),
            ).length,
          ).toBeLessThanOrEqual(mapCuriosityToExplorationSlots(100));
          expect(result.slate.items.map((recommendation) => recommendation.position)).toEqual(
            result.slate.items.map((_, position) => position),
          );
          expect(
            result.slate.items.every((recommendation) =>
              result.traces.has(recommendation.contentId),
            ),
          ).toBe(true);
        },
      ),
    );
  });

  it("allows different seeds to vary eligible choices while preserving invariants", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      item(`item-${index}`, `source-${index}`, `https://example.com/${index}`),
    );
    const outputs = new Set(
      ["seed-a", "seed-b", "seed-c", "seed-d"].map((seed) =>
        new CurationEngine()
          .generate(
            { ownerId: "owner", requestedAt, curiosity: 0, energy: 50, limit: 1 },
            candidates,
            { seed, manualInterests: ["known"] },
          )
          .slate.items.map((recommendation) => recommendation.contentId)
          .join(","),
      ),
    );

    expect(outputs.size).toBeGreaterThan(1);
  });

  it("preserves deterministic hard-gate, quota, and diversity invariants over generated pools", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            format: fc.integer({ min: 0, max: 7 }),
            labelled: fc.boolean(),
          }),
          { minLength: 18, maxLength: 30 },
        ),
        (specs) => {
          const candidates = specs.map((spec, index) =>
            generatedItem(index, index % 6, Math.floor(index / 2), spec.format, spec.labelled),
          );
          const mutedSource = "source-5";
          const activeNotNow = candidates.find((candidate) => candidate.id === "generated-1");
          const activeShown = candidates.find((candidate) => candidate.id === "generated-2");
          const notNow = [
            ...(activeNotNow
              ? [{ canonicalUri: activeNotNow.canonicalUri, until: "2026-09-01T12:00:00.000Z" }]
              : []),
            ...(activeShown ? [{ contentId: activeShown.id, until: requestedAt }] : []),
          ];
          const recentlyShown = [
            ...(activeShown
              ? [{ canonicalUri: activeShown.canonicalUri, shownAt: "2026-08-20T12:00:00.000Z" }]
              : []),
            ...(activeNotNow
              ? [{ contentId: activeNotNow.id, shownAt: "2026-07-29T12:00:00.000Z" }]
              : []),
          ];
          const options: CurationOptions = {
            seed: "property-generated",
            configuredLabels: ["blocked"],
            mutedSources: [mutedSource],
            notNow,
            recentlyShown,
          };
          const request = {
            ownerId: "owner",
            requestedAt,
            curiosity: 100,
            energy: 50,
            limit: 12,
          } as const;
          const engine = new CurationEngine();
          const first = engine.generate(request, candidates, options);
          const second = engine.generate(request, candidates, options);

          expect(first).toEqual(second);
          expect(first.slate.items.length).toBeLessThanOrEqual(12);
          expect(first.slate.items.map((entry) => entry.position)).toEqual(
            first.slate.items.map((_, position) => position),
          );
          expect(new Set(first.slate.items.map((entry) => entry.contentId)).size).toBe(
            first.slate.items.length,
          );
          const scoredFormats = new Set(
            first.decisions
              .filter((decision) =>
                decision.decisionTrace.factors.some((factor) => factor.factor === "freshness"),
              )
              .map(
                (decision) =>
                  first.slate.items.find((entry) => entry.contentId === decision.contentId)
                    ?.frame ??
                  candidates.find((candidate) => candidate.id === decision.contentId)?.blocks[0]
                    ?.kind,
              ),
          );
          if (first.slate.items.length > 1 && scoredFormats.size > 1)
            expect(new Set(first.slate.items.map((entry) => entry.frame)).size).toBeGreaterThan(1);

          const sourceCounts = new Map<string, number>();
          for (const recommendation of first.slate.items) {
            const source = candidates.find(
              (candidate) => candidate.id === recommendation.contentId,
            )?.sourceId;
            if (source) sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
          }
          expect([...sourceCounts.values()].every((count) => count <= 2)).toBe(true);

          for (const candidate of candidates) {
            const blockedByLabel = candidate.labels.some((label) => label.value === "blocked");
            const blockedBySource = candidate.sourceId === mutedSource;
            const blockedByNotNow = [candidate.id, candidate.canonicalUri].some((alias) =>
              notNow.some(
                (entry) =>
                  (entry.contentId === alias || entry.canonicalUri === alias) &&
                  new Date(entry.until).getTime() > new Date(requestedAt).getTime(),
              ),
            );
            const blockedByShown = [candidate.id, candidate.canonicalUri].some((alias) =>
              recentlyShown.some(
                (entry) =>
                  (entry.contentId === alias || entry.canonicalUri === alias) &&
                  new Date(requestedAt).getTime() - new Date(entry.shownAt).getTime() <
                    30 * 24 * 60 * 60 * 1000,
              ),
            );
            if (blockedByLabel || blockedBySource || blockedByNotNow || blockedByShown)
              expect(first.slate.items.some((entry) => entry.contentId === candidate.id)).toBe(
                false,
              );
          }
        },
      ),
      { numRuns: 30, seed: 4012 },
    );
  });

  it("reaches twelve recommendations from six sources without padding or gate bypass", () => {
    const candidates = Array.from({ length: 24 }, (_, index) =>
      generatedItem(index, index % 6, index, index, false),
    );
    const result = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 12 },
      candidates,
      { seed: "twelve-six-sources", manualInterests: ["known", "novel"] },
    );

    expect(result.slate.items).toHaveLength(12);
    expect(new Set(result.slate.items.map((entry) => entry.contentId)).size).toBe(12);
    expect(
      new Set(
        result.slate.items.map(
          (entry) => candidates.find((candidate) => candidate.id === entry.contentId)?.sourceId,
        ),
      ).size,
    ).toBeGreaterThanOrEqual(6);
  });
});
