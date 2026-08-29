import { describe, expect, it } from "vitest";

import {
  ACTIVE_EDITION_PATH,
  STATIC_ASSETS,
  isCacheableGet,
  isValidActiveEditionResponse,
  shouldUseOfflineFallback,
} from "../../src/modules/offline/policy";

const content = (id: string) => ({
  id,
  canonicalUri: `https://example.com/${id}`,
  sourceId: "rss:source-1",
  publishedAt: "2026-01-01T00:00:00.000Z",
  capturedAt: "2026-01-01T00:00:00.000Z",
  blocks: [{ kind: "paragraph", text: "A safe item" }],
  media: [],
  tags: [],
  labels: [],
});

const active = (
  items = [
    {
      id: "item-1",
      contentId: "content-1",
      frame: "frame",
      position: 0,
      decisionTrace: { factors: [] },
    },
  ],
  contents = [content("content-1")],
) => ({
  edition: {
    id: "edition-1",
    ownerId: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    curiosity: 50,
    energy: 50,
    items,
    decisionTrace: { factors: [] },
  },
  content: contents,
  position: 0,
  completed: false,
});

describe("offline cache policy", () => {
  it("pre-caches only the owned shell and offline fallback assets", () => {
    expect(STATIC_ASSETS).toContain("/");
    expect(STATIC_ASSETS).toContain("/offline");
    expect(STATIC_ASSETS).toContain("/manifest.webmanifest");
    expect(
      STATIC_ASSETS.every(
        (asset) => new URL(asset, "https://fads.cc").origin === "https://fads.cc",
      ),
    ).toBe(true);
    expect(STATIC_ASSETS).not.toContain(ACTIVE_EDITION_PATH);
  });

  it("admits only the same-origin active edition GET response", () => {
    expect(isCacheableGet(new Request("https://fads.cc/api/v1/editions/active"))).toBe(true);
    expect(isCacheableGet(new Request("https://fads.cc/api/v1/session"))).toBe(false);
    expect(isCacheableGet(new Request("https://fads.cc/api/v1/sources"))).toBe(false);
    expect(isCacheableGet(new Request("https://fads.cc/api/v1/export"))).toBe(false);
    expect(isCacheableGet(new Request("https://cdn.example/image.jpg"))).toBe(false);
    expect(
      isCacheableGet(new Request("https://fads.cc/api/v1/editions/active", { method: "POST" })),
    ).toBe(false);
  });

  it("validates the complete finite active edition shape before caching", () => {
    expect(isValidActiveEditionResponse(active())).toBe(true);
    expect(isValidActiveEditionResponse(active([], []))).toBe(true);
    expect(isValidActiveEditionResponse({ edition: { items: [] }, content: [], position: 0 })).toBe(
      false,
    );
    expect(isValidActiveEditionResponse({ ...active(), position: 13 })).toBe(false);
    expect(isValidActiveEditionResponse({ ...active(), content: [{ html: "<script>" }] })).toBe(
      false,
    );
    expect(
      isValidActiveEditionResponse(
        active(
          [
            {
              id: "item-1",
              contentId: "content-1",
              frame: "frame",
              position: 0,
              decisionTrace: { factors: [] },
            },
            {
              id: "item-1",
              contentId: "content-2",
              frame: "frame",
              position: 0,
              decisionTrace: { factors: [] },
            },
          ],
          [content("content-1"), content("content-2")],
        ),
      ),
    ).toBe(false);
  });

  it("uses the offline document only for failed navigations", () => {
    expect(
      shouldUseOfflineFallback(
        new Request("https://fads.cc/", { headers: { Accept: "text/html" } }),
      ),
    ).toBe(true);
    expect(shouldUseOfflineFallback(new Request("https://fads.cc/api/v1/session"))).toBe(false);
    expect(
      shouldUseOfflineFallback(
        new Request("https://fads.cc/", { headers: { Accept: "application/json" } }),
      ),
    ).toBe(false);
  });
});
