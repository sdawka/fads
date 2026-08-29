import { describe, expect, it } from "vitest";

import {
  ACTIVE_EDITION_PATH,
  STATIC_ASSETS,
  isCacheableGet,
  isValidActiveEditionResponse,
  shouldUseOfflineFallback,
} from "../../src/modules/offline/policy";

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

  it("validates the finite active edition shape before caching", () => {
    expect(
      isValidActiveEditionResponse({
        edition: { id: "edition-1", items: [{ contentId: "content-1", position: 0 }] },
        content: [{ id: "content-1", title: "A safe item" }],
        position: 0,
        completed: false,
      }),
    ).toBe(true);
    expect(
      isValidActiveEditionResponse({
        edition: { id: "empty", items: [] },
        content: [],
        position: 0,
        completed: false,
      }),
    ).toBe(true);
    expect(isValidActiveEditionResponse({ edition: { items: [] }, content: [], position: 0 })).toBe(
      false,
    );
    expect(
      isValidActiveEditionResponse({
        edition: { items: [] },
        content: [],
        position: 13,
        completed: false,
      }),
    ).toBe(false);
    expect(
      isValidActiveEditionResponse({
        edition: { items: [] },
        content: [{ html: "<script>" }],
        position: 0,
        completed: false,
      }),
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
