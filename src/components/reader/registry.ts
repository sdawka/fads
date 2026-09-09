import type { Component } from "svelte";
import FocusFrame from "./FocusFrame.svelte";
import GridFrame from "./GridFrame.svelte";
import ListFrame from "./ListFrame.svelte";
import type { Layout, ReaderFrameProps } from "./types";

export interface ReaderFrame {
  id: Layout;
  label: string;
  component: Component<ReaderFrameProps>;
}

// Add an extension by creating a component that accepts ReaderFrameProps and one entry here.
export const frameRegistry: ReaderFrame[] = [
  { id: "focus", label: "Focus", component: FocusFrame },
  { id: "list", label: "List", component: ListFrame },
  { id: "grid", label: "Grid", component: GridFrame },
];
