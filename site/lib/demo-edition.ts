import { createDeterministicEdition } from "../../src/modules/curation";
import type { ActiveEditionView } from "../../src/components/models";
import type { ContentEnvelope } from "../../src/contracts";

export type DemoMode = "familiar" | "surprise";

const timestamp = "2026-09-08T12:00:00-04:00";

const stories: ContentEnvelope[] = [
  {
    id: "moss-map",
    canonicalUri: "https://example.com/moss-map",
    sourceId: "fieldnotes",
    publishedAt: timestamp,
    capturedAt: timestamp,
    blocks: [
      { kind: "heading", text: "A map that rewards lingering", level: 2 },
      {
        kind: "paragraph",
        text: "A local map can show where the benches, shade and public water actually are. It is infrastructure for an unhurried afternoon.",
      },
    ],
    media: [],
    tags: [{ value: "civic", provenance: { source: "sample stories", observedAt: timestamp } }],
    labels: [],
  },
  {
    id: "paper-inventory",
    canonicalUri: "https://example.com/paper-inventory",
    sourceId: "publicworks",
    publishedAt: timestamp,
    capturedAt: timestamp,
    blocks: [
      { kind: "heading", text: "The small library of useful paper", level: 2 },
      {
        kind: "paragraph",
        text: "A field guide to printed things that remain better when they do not ask for an account, a notification, or your attention tomorrow.",
      },
    ],
    media: [],
    tags: [{ value: "tools", provenance: { source: "sample stories", observedAt: timestamp } }],
    labels: [],
  },
  {
    id: "window-seats",
    canonicalUri: "https://example.com/window-seats",
    sourceId: "fieldnotes",
    publishedAt: timestamp,
    capturedAt: timestamp,
    blocks: [
      { kind: "heading", text: "A city measured in window seats", level: 2 },
      {
        kind: "paragraph",
        text: "The best places to think are not secret. They are simply not optimized for turnover.",
      },
    ],
    media: [],
    tags: [{ value: "place", provenance: { source: "sample stories", observedAt: timestamp } }],
    labels: [],
  },
  {
    id: "radio-weather",
    canonicalUri: "https://example.com/radio-weather",
    sourceId: "signal",
    publishedAt: timestamp,
    capturedAt: timestamp,
    blocks: [
      { kind: "heading", text: "The weather report as a radio play", level: 2 },
      {
        kind: "paragraph",
        text: "A tiny community station gives the forecast room for jokes, sound effects and the names of people who keep the harbour open.",
      },
    ],
    media: [],
    tags: [{ value: "sound", provenance: { source: "sample stories", observedAt: timestamp } }],
    labels: [],
  },
  {
    id: "repair-cafe",
    canonicalUri: "https://example.com/repair-cafe",
    sourceId: "publicworks",
    publishedAt: timestamp,
    capturedAt: timestamp,
    blocks: [
      { kind: "heading", text: "A repair café keeps a parts diary", level: 2 },
      {
        kind: "paragraph",
        text: "Not a product review: a record of every strange screw, hinge and tiny victory encountered at the shared workbench.",
      },
    ],
    media: [],
    tags: [{ value: "repair", provenance: { source: "sample stories", observedAt: timestamp } }],
    labels: [],
  },
  {
    id: "night-bloom",
    canonicalUri: "https://example.com/night-bloom",
    sourceId: "signal",
    publishedAt: timestamp,
    capturedAt: timestamp,
    blocks: [
      { kind: "heading", text: "What opens after dark", level: 2 },
      {
        kind: "paragraph",
        text: "A photo essay about the plants, shops and volunteer kitchens that do their most interesting work after the day has stopped performing.",
      },
    ],
    media: [],
    tags: [{ value: "night", provenance: { source: "sample stories", observedAt: timestamp } }],
    labels: [],
  },
];

const configuration: Record<
  DemoMode,
  { curiosity: number; interests: string[]; explorationIds?: string[] }
> = {
  familiar: { curiosity: 0, interests: ["civic", "tools", "place"] },
  surprise: {
    curiosity: 100,
    interests: ["civic"],
    explorationIds: ["radio-weather", "repair-cafe", "night-bloom"],
  },
};

export function createDemoEdition(
  mode: DemoMode,
  position = 0,
  completed = false,
): ActiveEditionView {
  const settings = configuration[mode];
  const result = createDeterministicEdition(
    {
      ownerId: "demo-owner",
      requestedAt: timestamp,
      curiosity: settings.curiosity,
      energy: 45,
      limit: 3,
      seed: `public-demo:${mode}`,
    },
    stories,
    {
      manualInterests: settings.interests,
      explorationIds: settings.explorationIds,
      seed: `public-demo:${mode}`,
    },
  );
  return { edition: result.slate, content: [...result.selected], position, completed };
}

export interface DemoState {
  draftMode: DemoMode;
  activeMode: DemoMode;
  position: number;
  completed: boolean;
}

export function commitDemoEdition(state: DemoState): DemoState {
  return { ...state, activeMode: state.draftMode, position: 0, completed: false };
}
