import { describe, expect, it } from "vitest";

import {
  discardFailedChanges,
  resetFailedChangesForRetry,
} from "../../src/components/offline-resolution";
import { createMemoryOutbox, enqueueMutation, replayOutbox } from "../../src/modules/offline";

function interaction(key: string, contentId: string) {
  return new Request("https://fads.cc/api/v1/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      editionId: "edition-1",
      contentId,
      sourceId: "rss:source-1",
      kind: "more_like_this",
    }),
  });
}

describe("owner resolution of failed offline changes", () => {
  it("resets failed changes so ordered replay can continue", async () => {
    const store = createMemoryOutbox();
    await enqueueMutation(store, interaction("feedback-1", "content-1"));
    await enqueueMutation(store, interaction("feedback-2", "content-2"));
    await replayOutbox(store, async () => new Response(null, { status: 422 }));

    await expect(resetFailedChangesForRetry(store)).resolves.toBe(1);
    await expect(
      replayOutbox(store, async () => new Response(null, { status: 204 })),
    ).resolves.toMatchObject({ sent: 2, pending: 0, failed: 0 });
  });

  it("discards only failed changes after owner confirmation", async () => {
    const store = createMemoryOutbox();
    await enqueueMutation(store, interaction("feedback-1", "content-1"));
    await enqueueMutation(store, interaction("feedback-2", "content-2"));
    await replayOutbox(store, async () => new Response(null, { status: 422 }));

    await expect(discardFailedChanges(store)).resolves.toBe(1);
    await expect(store.list()).resolves.toHaveLength(1);
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: "feedback-2", state: "pending" }),
    ]);
  });
});
