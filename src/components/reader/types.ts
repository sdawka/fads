import type { ActiveEditionView, FeedbackKind } from "../models";

/** IDs are registered locally; the reader never loads executable code from a URL. */
export type Layout = string;

export interface ReaderFrameProps {
  view: ActiveEditionView;
  position: number;
  keptIds: string[];
  sourceName: (sourceId: string) => string;
  working: boolean;
  returnLabel: string;
  onSelect: (position: number) => void;
  onMove: (direction: "previous" | "next") => void;
  onLayout: () => void;
  onFeedback: (kind: FeedbackKind) => void;
}
