import type {
  ContentEnvelope,
  DecisionTrace,
  EditionRequest,
  ProvenancedTag,
  RecommendationSlate,
} from "../../contracts";

export interface NotNowSuppression {
  contentId?: string;
  canonicalUri?: string;
  until: string;
}

export interface RecentlyShown {
  contentId?: string;
  canonicalUri?: string;
  shownAt: string;
}

export interface CurationProfile {
  /** Explicit owner interests; unlike proposals, these may affect ranking. */
  manualInterests?: readonly string[];
  /** Bootstrap interests become effective only after the owner confirms them. */
  confirmedInterests?: readonly string[];
  /** Kept for the evidence/confirmation UI and deliberately ignored by ranking. */
  proposedInterests?: readonly string[];
  learnedAdjustments?: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
  configuredLabels?: readonly string[];
  /** Aliases accepted by repository-facing callers for configured policy labels. */
  excludedLabels?: readonly string[];
  blockedLabels?: readonly string[];
  mutedSources?: readonly string[];
  notNow?:
    readonly NotNowSuppression[] | Readonly<Record<string, string>> | ReadonlyMap<string, string>;
  recentlyShown?: readonly RecentlyShown[];
  /** Alias useful when hydrating state from a repository. */
  shown?: readonly RecentlyShown[];
}

export interface CurationOptions extends CurationProfile {
  /** Explicit seed takes precedence over the owner/request-derived seed. */
  seed?: string | number;
  explorationIds?: readonly string[];
  isExploration?: (item: ContentEnvelope, matchedInterests: readonly string[]) => boolean;
}

export type EditionInput = Pick<
  EditionRequest,
  "ownerId" | "requestedAt" | "curiosity" | "energy"
> &
  Partial<Pick<EditionRequest, "limit">> & {
    seed?: string | number;
  };

export type ExclusionReason =
  | "configured-label"
  | "muted-source"
  | "missing-content"
  | "unsafe-content"
  | "not-now"
  | "already-shown"
  | "duplicate-canonical"
  | "duplicate-content"
  | "source-cap"
  | "not-selected";

export interface CandidateDecision {
  contentId: string;
  canonicalUri?: string;
  selected: boolean;
  reason?: ExclusionReason;
  decisionTrace: DecisionTrace;
}

export interface CurationResult {
  slate: RecommendationSlate;
  selected: readonly ContentEnvelope[];
  excluded: readonly CandidateDecision[];
  traces: ReadonlyMap<string, DecisionTrace>;
  seed: number;
}

export interface BootstrapSuggestion {
  value: string;
  confirmed: boolean;
  evidenceCount: number;
  provenance: ProvenancedTag["provenance"];
}

export interface WeightedCandidate<T> {
  value: T;
  weight: number;
}
