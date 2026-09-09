import { describe, expect, it, vi } from "vitest";

import { createBrowserUiClient } from "../../src/components";

const source = {
  id: "rss:one",
  ownerId: "did:plc:owner",
  adapter: "rss" as const,
  displayName: "One",
  url: "https://example.com/feed.xml",
  config: {},
  status: "ready" as const,
  createdAt: "2026-08-28T12:00:00.000Z",
  updatedAt: "2026-08-28T12:00:00.000Z",
};

const interest = {
  id: "interest-1",
  ownerId: "did:plc:owner",
  value: "urban ecology",
  createdAt: "2026-08-28T12:00:00.000Z",
};

const suggestion = {
  id: "suggestion-1",
  ownerId: "did:plc:owner",
  value: "small press publishing",
  evidenceCount: 2,
  provenance: { source: "bootstrap", observedAt: "2026-08-28T12:00:00.000Z" },
  status: "pending" as const,
  createdAt: "2026-08-28T12:00:00.000Z",
};

const keptContent = {
  id: "content-1",
  canonicalUri: "https://example.com/kept",
  sourceId: source.id,
  publishedAt: source.createdAt,
  capturedAt: source.createdAt,
  blocks: [
    { kind: "heading" as const, text: "A kept field note", level: 1 },
    { kind: "paragraph" as const, text: "A safe preview." },
  ],
  media: [],
  tags: [],
  labels: [],
};

const ownerExport = {
  ownerId: source.ownerId,
  exportedAt: source.createdAt,
  data: {
    sources: [],
    syncCursors: [],
    content: [],
    interests: [],
    suggestions: [],
    preferences: { blockedLabels: [], mutedSourceIds: [] },
    learnedAdjustments: [],
    suppressions: [],
    interactions: [],
    keeps: [],
    editions: [],
    editionItems: [],
    editionDecisions: [],
    progress: [],
  },
};

function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("browser UI management client", () => {
  it("uses the private source, keep, garden, and preference routes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sources: [source] }))
      .mockResolvedValueOnce(response({ source }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        response({
          keeps: [{ ownerId: source.ownerId, contentId: "content-1", keptAt: source.createdAt }],
          content: [keptContent],
        }),
      )
      .mockResolvedValueOnce(
        response({
          keep: { ownerId: source.ownerId, contentId: "content-1", keptAt: source.createdAt },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ interests: [interest] }))
      .mockResolvedValueOnce(response({ interest }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ suggestions: [suggestion] }))
      .mockResolvedValueOnce(response({ suggestion: { ...suggestion, status: "confirmed" } }))
      .mockResolvedValueOnce(response({ preferences: { blockedLabels: [], mutedSourceIds: [] } }))
      .mockResolvedValueOnce(
        response({ preferences: { blockedLabels: ["graphic"], mutedSourceIds: [source.id] } }),
      );
    const client = createBrowserUiClient(fetcher);

    await expect(client.listSources()).resolves.toEqual([source]);
    await expect(
      client.addSource({ adapter: "rss", displayName: source.displayName, url: source.url }),
    ).resolves.toEqual(source);
    await client.removeSource(source.id);
    await expect(client.listKeeps()).resolves.toEqual({
      keeps: [{ ownerId: source.ownerId, contentId: "content-1", keptAt: source.createdAt }],
      content: [keptContent],
    });
    await expect(client.addKeep("content-1")).resolves.toEqual({
      ownerId: source.ownerId,
      contentId: "content-1",
      keptAt: source.createdAt,
    });
    await client.removeKeep("content-1");
    await expect(client.listInterests()).resolves.toEqual([interest]);
    await expect(client.addInterest("urban ecology")).resolves.toEqual(interest);
    await client.removeInterest(interest.id);
    await expect(client.listSuggestions()).resolves.toEqual([suggestion]);
    await expect(client.decideSuggestion(suggestion.id, "confirm")).resolves.toEqual({
      ...suggestion,
      status: "confirmed",
    });
    await expect(client.getPreferences()).resolves.toEqual({
      blockedLabels: [],
      mutedSourceIds: [],
    });
    await expect(
      client.savePreferences({ blockedLabels: ["graphic"], mutedSourceIds: [source.id] }),
    ).resolves.toEqual({ blockedLabels: ["graphic"], mutedSourceIds: [source.id] });

    expect(fetcher.mock.calls.map(([path, init]) => `${init?.method ?? "GET"} ${path}`)).toEqual([
      "GET /api/v1/sources",
      "POST /api/v1/sources",
      "DELETE /api/v1/sources/rss%3Aone",
      "GET /api/v1/keeps",
      "POST /api/v1/keeps",
      "DELETE /api/v1/keeps/content-1",
      "GET /api/v1/interests",
      "POST /api/v1/interests",
      "DELETE /api/v1/interests/interest-1",
      "GET /api/v1/suggestions",
      "POST /api/v1/suggestions/suggestion-1",
      "GET /api/v1/preferences",
      "PUT /api/v1/preferences",
    ]);
  });

  it("isolates source refresh, OPML, export, reset, and logout with validation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ source }))
      .mockResolvedValueOnce(response({ sources: [source], rejected: [] }, 201))
      .mockResolvedValueOnce(
        new Response('<?xml version="1.0"?><opml version="2.0"></opml>', {
          status: 200,
          headers: { "Content-Type": "text/x-opml" },
        }),
      )
      .mockResolvedValueOnce(response(ownerExport))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createBrowserUiClient(fetcher);

    await expect(client.refreshSource(source.id)).resolves.toEqual(source);
    await expect(client.importOpml("<opml />")).resolves.toEqual({
      sources: [source],
      rejected: [],
    });
    await expect(client.exportOpml()).resolves.toContain("<opml");
    await expect(client.exportData()).resolves.toEqual(ownerExport);
    await expect(client.reset(false)).resolves.toBeUndefined();
    await expect(client.logout()).resolves.toBeUndefined();

    expect(fetcher.mock.calls.map(([path, init]) => `${init?.method ?? "GET"} ${path}`)).toEqual([
      "POST /api/v1/sources/rss%3Aone/refresh",
      "POST /api/v1/sources/opml",
      "GET /api/v1/sources/opml",
      "GET /api/v1/export",
      "POST /api/v1/reset",
      "POST /api/v1/logout",
    ]);
  });

  it("rejects malformed management payloads at the browser boundary", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ sources: [{ ...source, status: "not-a-status" }] }));
    await expect(createBrowserUiClient(fetcher).listSources()).rejects.toThrow(
      "Invalid sources response.",
    );
  });

  it("persists source mute through the preferences contract", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ preferences: { blockedLabels: [], mutedSourceIds: [] } }))
      .mockResolvedValueOnce(
        response({ preferences: { blockedLabels: [], mutedSourceIds: [source.id] } }),
      );

    await expect(createBrowserUiClient(fetcher).muteSource(source.id, true)).resolves.toEqual({
      blockedLabels: [],
      mutedSourceIds: [source.id],
    });
    expect(fetcher.mock.calls.map(([path, init]) => `${init?.method ?? "GET"} ${path}`)).toEqual([
      "GET /api/v1/preferences",
      "PUT /api/v1/preferences",
    ]);
  });
});
