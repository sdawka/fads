import type { ContentEnvelope, RecommendationSlate } from "../contracts";

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
}
