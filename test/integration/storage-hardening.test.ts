import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  D1OwnerDataRepository,
  OwnerExportSchema,
  type OwnerSource,
} from "../../src/modules/storage";

const OWNER = "did:plc:owner";
const OTHER = "did:plc:other";
const AT = "2026-08-28T12:00:00.000Z";

function source(
  id: string,
  ownerId = OWNER,
  url = `https://${id.replaceAll(":", "-")}.example/feed`,
): OwnerSource {
  return {
    id,
    ownerId,
    adapter: "rss",
    displayName: id,
    url,
    config: {},
    status: "idle",
    createdAt: AT,
    updatedAt: AT,
  };
}

function envelope(id: string, sourceId: string, canonicalUri = `https://example.com/${id}`) {
  return {
    id,
    canonicalUri,
    sourceId,
    publishedAt: AT,
    capturedAt: AT,
    blocks: [{ kind: "paragraph" as const, text: id }],
    media: [],
    tags: [
      {
        value: `tag:${id}`,
        provenance: { source: "feed", observedAt: AT },
      },
    ],
    labels: [
      {
        value: `label:${id}`,
        provenance: { source: "feed", observedAt: AT },
      },
    ],
  };
}

async function seedContent(
  repository: D1OwnerDataRepository,
  ownerId: string,
  sourceId: string,
  items: ReturnType<typeof envelope>[],
) {
  await repository.saveSource(source(sourceId, ownerId));
  await repository
    .rssSyncRepository(ownerId, sourceId, () => AT)
    .commitSync({
      sourceId,
      items,
      nextCursor: `cursor:${sourceId}`,
    });
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM source_sync_work"),
    env.DB.prepare("DELETE FROM api_idempotency"),
    env.DB.prepare("DELETE FROM keeps"),
    env.DB.prepare("DELETE FROM interactions"),
    env.DB.prepare("DELETE FROM edition_decisions"),
    env.DB.prepare("DELETE FROM edition_items"),
    env.DB.prepare("DELETE FROM editions"),
    env.DB.prepare("DELETE FROM content_suppressions"),
    env.DB.prepare("DELETE FROM learned_adjustments"),
    env.DB.prepare("DELETE FROM owner_muted_sources"),
    env.DB.prepare("DELETE FROM owner_preferences"),
    env.DB.prepare("DELETE FROM interest_suggestions"),
    env.DB.prepare("DELETE FROM manual_interests"),
    env.DB.prepare("DELETE FROM content_tags"),
    env.DB.prepare("DELETE FROM content_labels"),
    env.DB.prepare("DELETE FROM sync_cursors"),
    env.DB.prepare("DELETE FROM content_items"),
    env.DB.prepare("DELETE FROM sources"),
  ]);
});

describe("hardened owner storage", () => {
  it("atomically claims, replays, conflicts, and reclaims idempotency work", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    const claim = {
      ownerId: OWNER,
      scope: "POST /api/v1/sources",
      key: "same",
      requestHash: "hash-one",
      now: AT,
      expiresAt: "2026-08-28T13:00:00.000Z",
    };

    const [first, concurrent] = await Promise.all([
      repository.claimIdempotency({ ...claim, claimToken: "claim-one" }),
      repository.claimIdempotency({ ...claim, claimToken: "claim-two" }),
    ]);
    expect([first.status, concurrent.status].sort()).toEqual(["claimed", "pending"]);

    const winner = first.status === "claimed" ? first : concurrent;
    expect(
      await repository.completeIdempotency({
        ...claim,
        claimToken: winner.claimToken,
        response: new Response('{"ok":true}', {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
        completedAt: "2026-08-28T12:01:00.000Z",
      }),
    ).toBe(true);

    const replay = await repository.claimIdempotency({ ...claim, claimToken: "claim-three" });
    expect(replay.status).toBe("completed");
    if (replay.status === "completed") expect(await replay.response.json()).toEqual({ ok: true });
    expect(
      await repository.claimIdempotency({
        ...claim,
        requestHash: "different",
        claimToken: "claim-four",
      }),
    ).toEqual({ status: "conflict" });

    const reclaimed = await repository.claimIdempotency({
      ...claim,
      requestHash: "different",
      now: "2026-08-28T14:00:00.000Z",
      expiresAt: "2026-08-28T15:00:00.000Z",
      claimToken: "claim-five",
    });
    expect(reclaimed).toEqual({ status: "claimed", claimToken: "claim-five" });

    const pending = {
      ...claim,
      key: "stale-pending",
      claimToken: "pending-one",
    };
    await expect(repository.claimIdempotency(pending)).resolves.toEqual({
      status: "claimed",
      claimToken: "pending-one",
    });
    await expect(
      repository.claimIdempotency({
        ...pending,
        now: "2026-08-28T12:01:00.000Z",
        claimToken: "pending-two",
      }),
    ).resolves.toEqual({ status: "pending" });
    await expect(
      repository.claimIdempotency({
        ...pending,
        now: "2026-08-28T12:03:00.000Z",
        claimToken: "pending-three",
      }),
    ).resolves.toEqual({ status: "claimed", claimToken: "pending-three" });
  });

  it("does not alter foreign metadata when content identifiers collide", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await seedContent(repository, OTHER, "rss:foreign", [envelope("shared", "rss:foreign")]);
    await repository.saveSource(source("rss:owner"));

    await expect(
      repository
        .rssSyncRepository(OWNER, "rss:owner", () => AT)
        .commitSync({
          sourceId: "rss:owner",
          items: [envelope("shared", "rss:owner")],
        }),
    ).rejects.toThrow(/content identifier/i);

    const foreign = await repository.hydrateContent(OTHER, ["shared"]);
    expect(foreign[0]?.tags.map((tag) => tag.value)).toEqual(["tag:shared"]);
    expect(foreign[0]?.labels.map((label) => label.value)).toEqual(["label:shared"]);
  });

  it("rejects foreign content and source references in keeps and interactions", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await seedContent(repository, OTHER, "rss:foreign", [envelope("foreign", "rss:foreign")]);

    await expect(
      repository.saveKeep({ ownerId: OWNER, contentId: "foreign", keptAt: AT }),
    ).rejects.toThrow(/content not found/i);
    await expect(
      repository.recordInteraction({
        id: "interaction:foreign",
        ownerId: OWNER,
        contentId: "foreign",
        sourceId: "rss:foreign",
        kind: "keep",
        occurredAt: AT,
        provenance: { source: "owner-feedback", observedAt: AT },
      }),
    ).rejects.toThrow(/content not found/i);
    expect(await repository.listKeeps(OTHER)).toEqual([]);
  });

  it("hydrates at most twelve owner content items in requested order", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await seedContent(repository, OWNER, "rss:owner", [
      envelope("one", "rss:owner"),
      envelope("two", "rss:owner"),
    ]);
    await seedContent(repository, OTHER, "rss:foreign", [envelope("foreign", "rss:foreign")]);

    expect(
      (await repository.hydrateContent(OWNER, ["two", "foreign", "one"])).map((item) => item.id),
    ).toEqual(["two", "one"]);
    await expect(
      repository.hydrateContent(
        OWNER,
        Array.from({ length: 13 }, (_, index) => String(index)),
      ),
    ).rejects.toThrow(/twelve/i);
  });

  it("atomically imports OPML sources with canonical URL deduplication", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await repository.saveSource(source("rss:existing", OWNER, "https://example.com/feed"));

    const result = await repository.importSourcesAtomically(OWNER, [
      source("rss:first", OWNER, "HTTPS://NEW.EXAMPLE:443/feed#fragment"),
      source("rss:duplicate", OWNER, "https://new.example/feed"),
      source("rss:already", OWNER, "https://example.com/feed"),
    ]);

    expect(result.inserted.map((item) => item.id)).toEqual(["rss:first"]);
    expect(result.duplicates).toEqual([
      { id: "rss:duplicate", url: "https://new.example/feed", reason: "request" },
      { id: "rss:already", url: "https://example.com/feed", reason: "existing" },
    ]);
    expect((await repository.listSources(OWNER)).map((item) => item.id)).toEqual([
      "rss:existing",
      "rss:first",
    ]);
  });

  it("persists bootstrap suggestions and returns only confirmed values", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await repository.upsertBootstrapSuggestions(OWNER, [
      {
        id: "suggestion:one",
        ownerId: OWNER,
        value: "distributed systems",
        evidenceCount: 2,
        provenance: { source: "bootstrap" },
        status: "pending",
        createdAt: AT,
      },
    ]);
    await expect(
      repository.decideSuggestion(OWNER, "suggestion:one", "confirm", AT),
    ).resolves.toMatchObject({ status: "confirmed" });
    await expect(
      repository.decideSuggestion(OWNER, "suggestion:one", "reject", AT),
    ).resolves.toBeUndefined();

    expect(await repository.listConfirmedSuggestions(OWNER)).toEqual(["distributed systems"]);
  });

  it("persists queue work identity and observable outcomes", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await repository.saveSource(source("rss:owner"));

    expect(
      await repository.claimSyncWork({
        ownerId: OWNER,
        sourceId: "rss:owner",
        fingerprint: "sync:one",
        now: AT,
        claimToken: "queue-claim",
      }),
    ).toEqual({ status: "claimed", claimToken: "queue-claim" });
    expect(
      await repository.completeSyncWork({
        ownerId: OWNER,
        sourceId: "rss:owner",
        fingerprint: "sync:one",
        claimToken: "queue-claim",
        outcome: "processed",
        completedAt: "2026-08-28T12:01:00.000Z",
      }),
    ).toBe(true);
    expect(
      await repository.claimSyncWork({
        ownerId: OWNER,
        sourceId: "rss:owner",
        fingerprint: "sync:one",
        now: "2026-08-28T12:02:00.000Z",
        claimToken: "queue-again",
      }),
    ).toEqual({ status: "duplicate", outcome: "processed" });
    await expect(
      repository.claimSyncWork({
        ownerId: OWNER,
        sourceId: "rss:foreign",
        fingerprint: "sync:foreign",
        now: AT,
        claimToken: "queue-foreign",
      }),
    ).rejects.toThrow(/source not found/i);
  });

  it("serializes work per source and permits an explicitly released retry", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await repository.saveSource(source("rss:serialized"));

    await expect(
      repository.claimSyncWork({
        ownerId: OWNER,
        sourceId: "rss:serialized",
        fingerprint: "sync:first",
        now: AT,
        claimToken: "first-claim",
      }),
    ).resolves.toEqual({ status: "claimed", claimToken: "first-claim" });
    await expect(
      repository.claimSyncWork({
        ownerId: OWNER,
        sourceId: "rss:serialized",
        fingerprint: "sync:second",
        now: AT,
        claimToken: "second-claim",
      }),
    ).resolves.toEqual({ status: "pending" });

    await expect(
      repository.releaseSyncWork({
        ownerId: OWNER,
        sourceId: "rss:serialized",
        fingerprint: "sync:first",
        claimToken: "first-claim",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.claimSyncWork({
        ownerId: OWNER,
        sourceId: "rss:serialized",
        fingerprint: "sync:first",
        now: AT,
        claimToken: "retry-claim",
      }),
    ).resolves.toEqual({ status: "claimed", claimToken: "retry-claim" });
  });

  it("resets learned state without deleting durable feedback or manual intent", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await seedContent(repository, OWNER, "rss:owner", [envelope("one", "rss:owner")]);
    await repository.saveInterest({
      id: "interest:one",
      ownerId: OWNER,
      value: "systems",
      createdAt: AT,
    });
    await repository.saveKeep({ ownerId: OWNER, contentId: "one", keptAt: AT });
    await repository.recordInteraction({
      id: "interaction:not-now",
      ownerId: OWNER,
      contentId: "one",
      sourceId: "rss:owner",
      kind: "not_now",
      occurredAt: AT,
      provenance: { source: "owner-feedback", observedAt: AT },
    });
    await repository.savePreferences(
      OWNER,
      { blockedLabels: [], mutedSourceIds: ["rss:owner"] },
      AT,
    );

    await repository.resetOwnerData(OWNER, false);

    expect(await repository.listInterests(OWNER)).toHaveLength(1);
    expect(await repository.listKeeps(OWNER)).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT id FROM interactions WHERE owner_id = ?").bind(OWNER).all(),
    ).toMatchObject({ results: [{ id: "interaction:not-now" }] });
    expect(await repository.getCurationState(OWNER)).toEqual({
      learnedAdjustments: {},
      notNow: [],
      recentlyShown: [],
    });
    expect((await repository.getPreferences(OWNER)).mutedSourceIds).toEqual(["rss:owner"]);
  });

  it("keeps saved content readable and lets a re-added feed reclaim deleted-source items", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await seedContent(repository, OWNER, "rss:old", [
      envelope("one", "rss:old", "https://example.com/canonical"),
    ]);
    await repository.saveKeep({ ownerId: OWNER, contentId: "one", keptAt: AT });
    await repository.removeSource(OWNER, "rss:old");

    expect((await repository.hydrateContent(OWNER, ["one"])).map((item) => item.id)).toEqual([
      "one",
    ]);

    await repository.saveSource(source("rss:new", OWNER, "https://rss-old.example/feed"));
    const sync = repository.rssSyncRepository(OWNER, "rss:new", () => AT);
    expect(
      await sync.isKnownContent({ id: "one", canonicalUri: "https://example.com/canonical" }),
    ).toBe(false);
    await sync.commitSync({
      sourceId: "rss:new",
      items: [envelope("one", "rss:new", "https://example.com/canonical")],
    });

    expect((await repository.listCandidates(OWNER))[0]?.sourceId).toBe("rss:new");
  });

  it("preserves only the in-flight full-reset claim so its response can be replayed", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    const expiresAt = "2026-08-28T13:00:00.000Z";
    const preserved = await repository.claimIdempotency({
      ownerId: OWNER,
      scope: "POST /api/v1/reset",
      key: "reset-key",
      requestHash: "reset-hash",
      now: AT,
      expiresAt,
      claimToken: "reset-claim",
    });
    const stale = await repository.claimIdempotency({
      ownerId: OWNER,
      scope: "POST /api/v1/interactions",
      key: "old-key",
      requestHash: "old-hash",
      now: AT,
      expiresAt,
      claimToken: "old-claim",
    });
    expect(preserved.status).toBe("claimed");
    expect(stale.status).toBe("claimed");

    await repository.resetOwnerData(OWNER, true, {
      scope: "POST /api/v1/reset",
      key: "reset-key",
    });

    const rows = await env.DB.prepare(
      "SELECT scope, key FROM api_idempotency WHERE owner_id = ? ORDER BY key",
    )
      .bind(OWNER)
      .all();
    expect(rows.results).toEqual([{ scope: "POST /api/v1/reset", key: "reset-key" }]);
    await expect(
      repository.completeIdempotency({
        ownerId: OWNER,
        scope: "POST /api/v1/reset",
        key: "reset-key",
        requestHash: "reset-hash",
        claimToken: "reset-claim",
        response: new Response(null, { status: 204 }),
        completedAt: AT,
      }),
    ).resolves.toBe(true);
  });

  it("enriches interaction context from owner-scoped stored content", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await seedContent(repository, OWNER, "rss:owner", [
      envelope("one", "rss:owner", "https://example.com/canonical"),
    ]);
    await seedContent(repository, OTHER, "rss:foreign", [envelope("foreign", "rss:foreign")]);

    expect(await repository.getContentContext(OWNER, "one")).toEqual({
      contentId: "one",
      sourceId: "rss:owner",
      canonicalUri: "https://example.com/canonical",
      format: "text",
      tags: ["tag:one"],
      labels: ["label:one"],
    });
    expect(await repository.getContentContext(OWNER, "foreign")).toBeUndefined();
  });

  it("exports the complete owner dataset through a strict runtime schema", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    await seedContent(repository, OWNER, "rss:owner", [envelope("one", "rss:owner")]);
    await repository.saveInterest({
      id: "interest:one",
      ownerId: OWNER,
      value: "systems",
      createdAt: AT,
    });
    await repository.saveKeep({ ownerId: OWNER, contentId: "one", keptAt: AT });

    const exported = OwnerExportSchema.parse(await repository.exportOwnerData(OWNER));
    expect(exported.data.sources).toHaveLength(1);
    expect(exported.data.syncCursors).toEqual([
      { sourceId: "rss:owner", cursor: "cursor:rss:owner", syncedAt: AT },
    ]);
    expect(exported.data.content[0]).toMatchObject({ id: "one", tags: [{ value: "tag:one" }] });
    expect(exported.data).toEqual(
      expect.objectContaining({
        interests: expect.any(Array),
        suggestions: expect.any(Array),
        preferences: expect.any(Object),
        learnedAdjustments: expect.any(Array),
        suppressions: expect.any(Array),
        interactions: expect.any(Array),
        keeps: expect.any(Array),
        editions: expect.any(Array),
        editionItems: expect.any(Array),
        editionDecisions: expect.any(Array),
        progress: expect.any(Array),
      }),
    );
  });
});
