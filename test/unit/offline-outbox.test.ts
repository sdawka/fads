import { describe, expect, it, vi } from "vitest";

import {
  classifyReplayResponse,
  createMemoryOutbox,
  enqueueMutation,
  isQueueableMutation,
  replayOutbox,
  type OutboxEntry,
} from "../../src/modules/offline/outbox";

const interaction = (overrides: Record<string, unknown> = {}, key = "feedback-1") =>
  new Request("https://fads.cc/api/v1/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      editionId: "edition-1",
      contentId: "content-1",
      sourceId: "rss:source-1",
      kind: "more_like_this",
      ...overrides,
    }),
  });

describe("offline mutation outbox", () => {
  it("queues only explicit feedback, progress, and completion mutations", async () => {
    expect(isQueueableMutation(interaction())).toBe(true);
    expect(
      isQueueableMutation(
        new Request("https://fads.cc/api/v1/editions/edition-1/progress", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "Idempotency-Key": "progress-1" },
          body: JSON.stringify({ position: 1 }),
        }),
      ),
    ).toBe(true);
    expect(
      isQueueableMutation(
        new Request("https://fads.cc/api/v1/editions/edition-1/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": "complete-1" },
          body: "{}",
        }),
      ),
    ).toBe(true);
    await expect(
      enqueueMutation(
        createMemoryOutbox(),
        new Request("https://fads.cc/api/v1/editions/edition-1/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": "complete-1" },
          body: "{}",
        }),
      ),
    ).resolves.toMatchObject({ kind: "completion" });
    expect(
      isQueueableMutation(
        new Request("https://fads.cc/api/v1/sources", { method: "POST", body: "{}" }),
      ),
    ).toBe(false);
    expect(
      isQueueableMutation(
        new Request("https://fads.cc/api/v1/logout", { method: "POST", body: "{}" }),
      ),
    ).toBe(false);
    await expect(
      enqueueMutation(createMemoryOutbox(), interaction({ kind: "unknown" })),
    ).rejects.toThrow(/feedback/i);
  });

  it("deduplicates a repeated idempotency key without losing order", async () => {
    const store = createMemoryOutbox();
    const first = await enqueueMutation(store, interaction());
    const duplicate = await enqueueMutation(store, interaction());
    const second = await enqueueMutation(
      store,
      interaction({ contentId: "content-2" }, "feedback-2"),
    );
    expect(duplicate).toEqual(first);
    expect(second.id).not.toBe(first.id);
    expect((await store.list()).map((entry) => entry.id)).toEqual([first.id, second.id]);
  });

  it("rejects a reused idempotency key with a different mutation", async () => {
    const store = createMemoryOutbox();
    await enqueueMutation(store, interaction());
    await expect(enqueueMutation(store, interaction({ contentId: "content-2" }))).rejects.toThrow(
      /idempotency/i,
    );
  });

  it("replays successful entries in insertion order", async () => {
    const store = createMemoryOutbox();
    const first = await enqueueMutation(store, interaction());
    const second = await enqueueMutation(
      store,
      new Request("https://fads.cc/api/v1/editions/edition-1/progress", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "progress-1" },
        body: JSON.stringify({ position: 1 }),
      }),
    );
    const send = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await replayOutbox(store, send);
    expect(send.mock.calls.map(([entry]) => (entry as OutboxEntry).id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(result).toMatchObject({ sent: 2, pending: 0, failed: 0 });
  });

  it("stops at a transient failure and retains it and later entries", async () => {
    const store = createMemoryOutbox();
    await enqueueMutation(store, interaction());
    await enqueueMutation(
      store,
      interaction({ contentId: "content-2", sourceId: "rss:source-2" }, "feedback-2"),
    );
    const send = vi.fn(async () => new Response(null, { status: 503 }));
    const result = await replayOutbox(store, send);
    expect(result).toMatchObject({ sent: 0, pending: 2, failed: 0 });
    expect(await store.list()).toHaveLength(2);
  });

  it("retains a permanent failure for owner action and stops ordering", async () => {
    const store = createMemoryOutbox();
    const first = await enqueueMutation(store, interaction());
    await enqueueMutation(
      store,
      interaction({ contentId: "content-2", sourceId: "rss:source-2" }, "feedback-2"),
    );
    const send = vi.fn(async () => new Response(null, { status: 422 }));
    const result = await replayOutbox(store, send);
    const pending = await store.list();
    expect(result).toMatchObject({ sent: 0, pending: 2, failed: 1 });
    expect(pending[0]).toMatchObject({
      id: first.id,
      state: "failed",
      lastError: expect.any(String),
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not automatically retry a retained permanent failure", async () => {
    const store = createMemoryOutbox();
    await enqueueMutation(store, interaction());
    await replayOutbox(store, async () => new Response(null, { status: 422 }));
    const send = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await replayOutbox(store, send);
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, pending: 1, failed: 0 });
  });

  it("serializes concurrent replay calls so an entry is sent once", async () => {
    const store = createMemoryOutbox();
    await enqueueMutation(store, interaction());
    const send = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(null, { status: 204 });
    });
    await Promise.all([replayOutbox(store, send), replayOutbox(store, send)]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("classifies network errors as transient and 4xx errors as permanent", () => {
    expect(classifyReplayResponse(undefined, new TypeError("offline"))).toBe("transient");
    expect(classifyReplayResponse(new Response(null, { status: 408 }))).toBe("transient");
    expect(classifyReplayResponse(new Response(null, { status: 500 }))).toBe("transient");
    expect(classifyReplayResponse(new Response(null, { status: 401 }))).toBe("permanent");
    expect(classifyReplayResponse(new Response(null, { status: 422 }))).toBe("permanent");
  });

  it("clears all pending and failed entries on logout or full reset", async () => {
    const store = createMemoryOutbox();
    await enqueueMutation(store, interaction());
    await store.clear();
    expect(await store.list()).toEqual([]);
  });
});
