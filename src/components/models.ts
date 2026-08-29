import type {
  ContentEnvelope,
  InterestSuggestion,
  KeepRecord,
  ManualInterest,
  OwnerExport,
  OwnerPreferences,
  RecommendationSlate,
  ApiSource,
} from "../contracts";

export type Surface = "edition" | "keeps" | "sources" | "garden" | "settings";
export type FeedbackKind =
  "more_like_this" | "less_like_this" | "good_surprise" | "not_now" | "mute_source" | "keep";

export interface SessionView {
  authenticated: boolean;
  did?: string;
}

export interface ActiveEditionView {
  edition: RecommendationSlate;
  content: ContentEnvelope[];
  position: number;
  completed: boolean;
}

export interface KeepLibrary {
  keeps: KeepRecord[];
  content: ContentEnvelope[];
}

export interface FadsUiClient {
  session(): Promise<SessionView>;
  activeEdition(): Promise<ActiveEditionView | undefined>;
  createEdition(input: { curiosity: number; energy: number }): Promise<ActiveEditionView>;
  setProgress(editionId: string, position: number): Promise<void>;
  complete(editionId: string): Promise<void>;
  interact(input: {
    editionId: string;
    contentId: string;
    sourceId: string;
    kind: FeedbackKind;
  }): Promise<void>;
  listKeeps(): Promise<KeepLibrary>;
  addKeep(contentId: string): Promise<KeepRecord>;
  removeKeep(contentId: string): Promise<void>;
  listSources(): Promise<ApiSource[]>;
  addSource(input: {
    adapter: "rss" | "atproto";
    displayName: string;
    url?: string;
    config?: Record<string, unknown>;
  }): Promise<ApiSource>;
  removeSource(sourceId: string): Promise<void>;
  refreshSource(sourceId: string): Promise<ApiSource>;
  muteSource(
    sourceId: string,
    muted: boolean,
    current?: OwnerPreferences,
  ): Promise<OwnerPreferences>;
  importOpml(
    opml: string,
  ): Promise<{ sources: ApiSource[]; rejected: Array<{ url: string; reason: string }> }>;
  exportOpml(): Promise<string>;
  listInterests(): Promise<ManualInterest[]>;
  addInterest(value: string): Promise<ManualInterest>;
  removeInterest(interestId: string): Promise<void>;
  listSuggestions(): Promise<InterestSuggestion[]>;
  decideSuggestion(
    suggestionId: string,
    decision: "confirm" | "reject",
  ): Promise<InterestSuggestion>;
  getPreferences(): Promise<OwnerPreferences>;
  savePreferences(preferences: OwnerPreferences): Promise<OwnerPreferences>;
  exportData(): Promise<OwnerExport>;
  reset(full?: boolean): Promise<void>;
  logout(): Promise<void>;
}
