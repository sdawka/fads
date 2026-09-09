import {
  InteractionEventSchema,
  type ContentEnvelope,
  type InteractionEvent,
} from "../../contracts";
import type { CurationProfile } from "../curation";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface KeepRecord {
  ownerId: string;
  contentId: string;
  keptAt: string;
}

export interface FeedbackState {
  ownerId: string;
  manualInterests: string[];
  learnedAdjustments: Record<string, number>;
  notNow: Record<string, string>;
  mutedSources: string[];
  keeps: KeepRecord[];
  appliedInteractionIds: string[];
  isSuppressed(contentId: string, at: string, canonicalUri?: string): boolean;
  isSourceMuted(sourceId: string): boolean;
}

export interface FeedbackStateSeed {
  ownerId: string;
  manualInterests?: readonly string[];
  learnedAdjustments?: Readonly<Record<string, number>>;
  notNow?: Readonly<Record<string, string>>;
  mutedSources?: readonly string[];
  keeps?: readonly KeepRecord[];
  appliedInteractionIds?: readonly string[];
}

export interface InteractionContext {
  content?: ContentEnvelope;
  format?: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function makeState(seed: FeedbackStateSeed): FeedbackState {
  const notNow = { ...(seed.notNow ?? {}) };
  const state: FeedbackState = {
    ownerId: seed.ownerId,
    manualInterests: unique(seed.manualInterests ?? []),
    learnedAdjustments: { ...(seed.learnedAdjustments ?? {}) },
    notNow,
    mutedSources: unique(seed.mutedSources ?? []),
    keeps: [...(seed.keeps ?? [])].map((keep) => ({ ...keep })),
    appliedInteractionIds: unique(seed.appliedInteractionIds ?? []),
    isSuppressed(contentId, at, canonicalUri) {
      const now = new Date(at).getTime();
      if (!Number.isFinite(now)) return false;
      const keys = [
        normalize(contentId),
        canonicalUri ? normalize(canonicalUri) : undefined,
      ].filter((key): key is string => Boolean(key));
      return keys.some((key) => {
        const until = new Date(notNow[key] ?? "").getTime();
        return Number.isFinite(until) && until > now;
      });
    },
    isSourceMuted(sourceId) {
      return state.mutedSources.includes(normalize(sourceId));
    },
  };
  return state;
}

export function createFeedbackState(seed: FeedbackStateSeed): FeedbackState {
  return makeState(seed);
}

function addAdjustment(adjustments: Record<string, number>, key: string, amount: number): void {
  const normalized = normalize(key);
  adjustments[normalized] = (adjustments[normalized] ?? 0) + amount;
  if (adjustments[normalized] === 0) delete adjustments[normalized];
}

function feedbackKeys(event: InteractionEvent, context?: InteractionContext): string[] {
  const keys: string[] = [];
  if (event.contentId) keys.push(`content:${normalize(event.contentId)}`);
  if (event.sourceId) keys.push(`source:${normalize(event.sourceId)}`);
  if (context?.format) keys.push(`format:${normalize(context.format)}`);
  for (const tag of context?.content?.tags ?? []) keys.push(`tag:${normalize(tag.value)}`);
  return [...new Set(keys)];
}

function interactionDelta(kind: InteractionEvent["kind"]): number {
  if (kind === "more_like_this") return 1;
  if (kind === "less_like_this") return -1;
  if (kind === "good_surprise") return 0.5;
  return 0;
}

export function applyInteraction(
  state: FeedbackState,
  input: InteractionEvent,
  context?: InteractionContext,
): FeedbackState {
  const event = InteractionEventSchema.parse(input);
  if (event.ownerId !== state.ownerId)
    throw new Error("Interaction owner does not match feedback state");
  if (state.appliedInteractionIds.includes(normalize(event.id))) return state;

  const next: FeedbackStateSeed = {
    ownerId: state.ownerId,
    manualInterests: state.manualInterests,
    learnedAdjustments: state.learnedAdjustments,
    notNow: state.notNow,
    mutedSources: state.mutedSources,
    keeps: state.keeps,
    appliedInteractionIds: [...state.appliedInteractionIds, event.id],
  };
  const delta = interactionDelta(event.kind);
  if (delta !== 0) {
    next.learnedAdjustments = { ...state.learnedAdjustments };
    for (const key of feedbackKeys(event, context))
      addAdjustment(next.learnedAdjustments, key, delta);
  }
  if (event.kind === "not_now") {
    if (!event.contentId) throw new Error("not_now requires contentId");
    const until = new Date(new Date(event.occurredAt).getTime() + SEVEN_DAYS_MS).toISOString();
    const notNow = { ...state.notNow, [normalize(event.contentId)]: until };
    const canonicalUri = context?.content?.canonicalUri;
    if (canonicalUri) notNow[normalize(canonicalUri)] = until;
    next.notNow = notNow;
  }
  if (event.kind === "mute_source") {
    if (!event.sourceId) throw new Error("mute_source requires sourceId");
    next.mutedSources = unique([...state.mutedSources, event.sourceId]);
  }
  if (event.kind === "keep") {
    if (!event.contentId) throw new Error("keep requires contentId");
    const alreadyKept = state.keeps.some(
      (keep) => keep.ownerId === state.ownerId && keep.contentId === event.contentId,
    );
    next.keeps = alreadyKept
      ? state.keeps
      : [
          ...state.keeps,
          { ownerId: state.ownerId, contentId: event.contentId, keptAt: event.occurredAt },
        ];
  }
  return makeState(next);
}

export interface ResetOptions {
  full?: boolean;
}

export function resetFeedback(state: FeedbackState, options: ResetOptions = {}): FeedbackState {
  if (options.full) return makeState({ ownerId: state.ownerId });
  return makeState({
    ownerId: state.ownerId,
    manualInterests: state.manualInterests,
    keeps: state.keeps,
    appliedInteractionIds: state.appliedInteractionIds,
  });
}

export function toCurationProfile(state: FeedbackState): CurationProfile {
  return {
    manualInterests: state.manualInterests,
    confirmedInterests: state.manualInterests,
    learnedAdjustments: state.learnedAdjustments,
    notNow: state.notNow,
    mutedSources: state.mutedSources,
  };
}
