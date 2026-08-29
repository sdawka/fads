import { describe, expect, it } from "vitest";

import {
  consumeSourceSyncMessage,
  planStaleSourceSyncs,
  type OwnerSource,
} from "../../src/modules/storage";

function source(id: string, lastSyncedAt?: string): OwnerSource {
  return {
    id,
    ownerId: "did:plc:owner",
    adapter: "rss",
    displayName: id,
    url: `https://${id.slice(4)}.example/feed`,
    config: {},
    status: "ready",
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  };
}

describe("source sync work", () => {
  it("plans only stale sources in deterministic versioned order", () => {
    expect(
      planStaleSourceSyncs(
        "did:plc:owner",
        [
          source("rss:z"),
          source("rss:fresh", "2026-08-28T11:55:00.000Z"),
          source("rss:a", "2026-08-28T11:30:00.000Z"),
        ],
        "2026-08-28T12:00:00.000Z",
      ),
    ).toEqual([
      { version: 1, kind: "sync_source", ownerId: "did:plc:owner", sourceId: "rss:a" },
      { version: 1, kind: "sync_source", ownerId: "did:plc:owner", sourceId: "rss:z" },
    ]);
  });

  it("distinguishes duplicate, transient, permanent, and malformed queue outcomes", async () => {
    const message = {
      version: 1,
      kind: "sync_source",
      ownerId: "did:plc:owner",
      sourceId: "rss:one",
    } as const;

    expect(await consumeSourceSyncMessage(message, async () => "duplicate")).toEqual({
      outcome: "duplicate",
    });
    expect(
      await consumeSourceSyncMessage(message, async () => {
        throw { status: 503 };
      }),
    ).toEqual({ outcome: "retry" });
    expect(
      await consumeSourceSyncMessage(message, async () => {
        throw { status: 404 };
      }),
    ).toEqual({ outcome: "failed" });
    expect(await consumeSourceSyncMessage({ version: 2 }, async () => undefined)).toEqual({
      outcome: "failed",
    });
  });
});
