import { describe, expect, it } from "vitest";

import { isValidActiveEditionResponse } from "../../src/modules/offline/policy";

const content = {
  id: "content-1",
  canonicalUri: "https://example.com/content-1",
  sourceId: "rss:source-1",
  publishedAt: "2026-01-01T00:00:00.000Z",
  capturedAt: "2026-01-01T00:00:00.000Z",
  blocks: [{ kind: "paragraph", text: "safe" }],
  media: [],
  tags: [],
  labels: [],
};

const response = {
  edition: {
    id: "edition-1",
    ownerId: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    curiosity: 50,
    energy: 50,
    items: [
      {
        id: "item-1",
        contentId: "content-1",
        frame: "frame",
        position: 0,
        decisionTrace: { factors: [] },
      },
    ],
    decisionTrace: { factors: [] },
  },
  content: [content],
  position: 0,
  completed: false,
};

describe("deep active-edition validation", () => {
  it.each([
    ["unsafe block", { ...content, blocks: [{ kind: "embed", src: "https://evil.example" }] }],
    ["malformed media", { ...content, media: [{ kind: "video", url: "https://evil.example" }] }],
  ])("rejects %s", (_name, invalidContent) => {
    expect(isValidActiveEditionResponse({ ...response, content: [invalidContent] })).toBe(false);
  });

  it("rejects a malformed decision trace and duplicate item positions/ids", () => {
    expect(
      isValidActiveEditionResponse({
        ...response,
        edition: {
          ...response.edition,
          decisionTrace: { factors: [{ factor: "bad", weight: 1 }] },
        },
      }),
    ).toBe(false);
    const duplicate = { ...response.edition.items[0], id: "item-1", position: 0 };
    expect(
      isValidActiveEditionResponse({
        ...response,
        edition: { ...response.edition, items: [response.edition.items[0], duplicate] },
        content: [content, { ...content, id: "content-2" }],
      }),
    ).toBe(false);
  });
});
