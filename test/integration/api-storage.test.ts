import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { D1OwnerDataRepository } from "../../src/modules/storage";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("owner D1 storage", () => {
  it("persists private source configuration and never crosses owners", async () => {
    const repo = new D1OwnerDataRepository(env.DB);
    await repo.saveSource({
      id: "rss:one",
      ownerId: "did:plc:owner",
      adapter: "rss",
      displayName: "One",
      url: "https://example.com/feed.xml",
      config: { cadenceMinutes: 30 },
      status: "idle",
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:00.000Z",
    });

    expect(await repo.listSources("did:plc:owner")).toHaveLength(1);
    expect(await repo.listSources("did:plc:other")).toEqual([]);
    expect(await repo.getSource("did:plc:other", "rss:one")).toBeUndefined();
  });

  it("scopes idempotent responses by owner, route, key, and request hash", async () => {
    const repo = new D1OwnerDataRepository(env.DB);
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
    await repo.saveIdempotentResponse({
      ownerId: "did:plc:owner",
      scope: "POST /api/v1/sources",
      key: "same",
      requestHash: "hash-one",
      response,
      expiresAt: "2026-08-29T12:00:00.000Z",
      createdAt: "2026-08-28T12:00:00.000Z",
    });

    const replay = await repo.getIdempotentResponse({
      ownerId: "did:plc:owner",
      scope: "POST /api/v1/sources",
      key: "same",
      requestHash: "hash-one",
      now: "2026-08-28T12:01:00.000Z",
    });
    const conflict = await repo.getIdempotentResponse({
      ownerId: "did:plc:owner",
      scope: "POST /api/v1/sources",
      key: "same",
      requestHash: "different",
      now: "2026-08-28T12:01:00.000Z",
    });
    const otherOwner = await repo.getIdempotentResponse({
      ownerId: "did:plc:other",
      scope: "POST /api/v1/sources",
      key: "same",
      requestHash: "hash-one",
      now: "2026-08-28T12:01:00.000Z",
    });

    expect(replay && !replay.conflict ? await replay.response.json() : undefined).toEqual({
      ok: true,
    });
    expect(conflict).toEqual({ conflict: true });
    expect(otherOwner).toBeUndefined();
  });

  it("atomically persists deduplicated RSS envelopes with the cursor", async () => {
    const repo = new D1OwnerDataRepository(env.DB);
    await repo.saveSource({
      id: "rss:one",
      ownerId: "did:plc:owner",
      adapter: "rss",
      displayName: "One",
      url: "https://example.com/feed.xml",
      config: {},
      status: "idle",
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
    const rss = repo.rssSyncRepository(
      "did:plc:owner",
      "rss:one",
      () => "2026-08-28T12:01:00.000Z",
    );
    await rss.commitSync({
      sourceId: "rss:one",
      nextCursor: "cursor-2",
      items: [
        {
          id: "item:one",
          canonicalUri: "https://example.com/one",
          sourceId: "rss:one",
          publishedAt: "2026-08-28T11:00:00.000Z",
          capturedAt: "2026-08-28T12:00:00.000Z",
          blocks: [{ kind: "paragraph", text: "One" }],
          media: [],
          tags: [],
          labels: [],
        },
      ],
    });

    expect(await rss.loadCursor({ sourceId: "rss:one" })).toBe("cursor-2");
    expect(await repo.listCandidates("did:plc:owner")).toHaveLength(1);
    expect(await repo.listCandidates("did:plc:other")).toEqual([]);

    expect(await repo.removeSource("did:plc:owner", "rss:one")).toBe(true);
    expect(await repo.listSources("did:plc:owner")).toEqual([]);
    expect(await repo.listCandidates("did:plc:owner")).toEqual([]);
  });

  it("learns once from a duplicated interaction and hydrates owner curation state", async () => {
    const repo = new D1OwnerDataRepository(env.DB);
    await repo.saveSource({
      id: "rss:one",
      ownerId: "did:plc:owner",
      adapter: "rss",
      displayName: "One",
      url: "https://example.com/feed.xml",
      config: {},
      status: "idle",
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
    const event = {
      id: "event:one",
      ownerId: "did:plc:owner",
      contentId: undefined,
      sourceId: "rss:one",
      kind: "more_like_this" as const,
      occurredAt: "2026-08-28T12:00:00.000Z",
      provenance: { source: "owner-feedback", observedAt: "2026-08-28T12:00:00.000Z" },
    };

    await repo.recordInteraction(event);
    await repo.recordInteraction(event);
    const state = await repo.getCurationState("did:plc:owner");

    expect(state.learnedAdjustments).toEqual({ "source:rss:one": 1 });
    expect(await repo.getCurationState("did:plc:other")).toEqual({
      learnedAdjustments: {},
      notNow: [],
      recentlyShown: [],
    });
  });
});
