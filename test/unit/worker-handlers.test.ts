import { describe, expect, it, vi } from "vitest";
import { buildBootstrapSuggestionRecords, createWorkerHandlers } from "../../src/worker-handlers";

const message = {
  version: 1,
  kind: "sync_source",
  ownerId: "did:plc:owner",
  sourceId: "rss:one",
  workId: "sync:one",
} as const;

function queueMessage(body: unknown) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

describe("Worker ingestion handlers", () => {
  it("builds deterministic pending bootstrap suggestions from synced content", () => {
    const records = buildBootstrapSuggestionRecords(
      "did:plc:owner",
      [
        {
          id: "rss:one:item",
          canonicalUri: "https://example.com/item",
          sourceId: "rss:one",
          publishedAt: "2026-08-28T11:59:00.000Z",
          capturedAt: "2026-08-28T12:00:00.000Z",
          blocks: [{ kind: "paragraph", text: "item" }],
          media: [],
          tags: [
            {
              value: "Systems",
              provenance: { source: "rss:one", observedAt: "2026-08-28T12:00:00.000Z" },
            },
          ],
          labels: [],
        },
      ],
      "2026-08-28T12:00:00.000Z",
    );

    expect(records).toEqual([
      {
        id: expect.stringMatching(/^suggestion:systems:[a-f0-9]{8}$/),
        ownerId: "did:plc:owner",
        value: "Systems",
        evidenceCount: 1,
        provenance: { source: "rss:one", observedAt: "2026-08-28T12:00:00.000Z" },
        status: "pending",
        createdAt: "2026-08-28T12:00:00.000Z",
      },
    ]);
    expect(
      buildBootstrapSuggestionRecords("did:plc:owner", [], "2026-08-28T12:00:00.000Z"),
    ).toEqual([]);
  });

  it("keeps suggestion identifiers bounded and skips unusably long observed tags", () => {
    const records = buildBootstrapSuggestionRecords(
      `did:plc:${"o".repeat(180)}`,
      [
        {
          id: "rss:one:item",
          canonicalUri: "https://example.com/item",
          sourceId: "rss:one",
          publishedAt: "2026-08-28T11:59:00.000Z",
          capturedAt: "2026-08-28T12:00:00.000Z",
          blocks: [{ kind: "paragraph", text: "item" }],
          media: [],
          tags: [
            {
              value: "A useful topic",
              provenance: { source: "rss:one", observedAt: "2026-08-28T12:00:00.000Z" },
            },
            {
              value: "x".repeat(121),
              provenance: { source: "rss:one", observedAt: "2026-08-28T12:00:00.000Z" },
            },
          ],
          labels: [],
        },
      ],
      "2026-08-28T12:00:00.000Z",
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.id.length).toBeLessThanOrEqual(256);
    expect(records[0]?.value).toBe("A useful topic");
  });

  it("acks processed, duplicate, malformed, and permanent work but retries transient work", async () => {
    const log = vi.fn();
    const inputs = [
      queueMessage({ ...message, sourceId: "rss:processed" }),
      queueMessage({ ...message, sourceId: "rss:duplicate" }),
      queueMessage({ version: 2 }),
      queueMessage({ ...message, sourceId: "rss:permanent" }),
      queueMessage({ ...message, sourceId: "rss:transient" }),
    ];
    const handlers = createWorkerHandlers({
      syncSource: async (_env, input) => {
        if (input.sourceId === "rss:duplicate") return "duplicate";
        if (input.sourceId === "rss:permanent") throw { status: 404 };
        if (input.sourceId === "rss:transient") throw { status: 503 };
        return "processed";
      },
      planScheduled: async () => [],
      log,
    });

    await handlers.queue({ messages: inputs } as never, {} as never);

    expect(inputs.slice(0, 4).every((input) => input.ack.mock.calls.length === 1)).toBe(true);
    expect(inputs.slice(0, 4).every((input) => input.retry.mock.calls.length === 0)).toBe(true);
    expect(inputs[4].ack).not.toHaveBeenCalled();
    expect(inputs[4].retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(log).toHaveBeenCalledWith({
      event: "ingestion_queue",
      received: 5,
      processed: 1,
      duplicate: 1,
      retried: 1,
      discarded: 2,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/owner|source|workId|error/i);
  });

  it("enqueues only planned stale source messages and disables schedule retries", async () => {
    const sendBatch = vi.fn(async () => undefined);
    const noRetry = vi.fn();
    const log = vi.fn();
    const handlers = createWorkerHandlers({
      syncSource: async () => "processed",
      planScheduled: async () => [message],
      log,
    });

    await handlers.scheduled({ noRetry } as never, { INGESTION_QUEUE: { sendBatch } } as never);

    expect(sendBatch).toHaveBeenCalledWith([{ body: message }]);
    expect(noRetry).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith({
      event: "ingestion_scheduled",
      outcome: "sent",
      planned: 1,
      batches: 1,
    });
  });

  it("logs a redacted scheduled failure outcome before preserving the retry", async () => {
    const log = vi.fn();
    const handlers = createWorkerHandlers({
      syncSource: async () => "processed",
      planScheduled: async () => [message],
      log,
    });

    await expect(
      handlers.scheduled(
        { noRetry: vi.fn() } as never,
        {
          INGESTION_QUEUE: {
            sendBatch: vi.fn(async (_batch: unknown) => Promise.reject(new Error("secret"))),
          },
        } as never,
      ),
    ).rejects.toThrow("secret");

    expect(log).toHaveBeenCalledWith({
      event: "ingestion_scheduled",
      outcome: "failed",
      planned: 1,
      batches: 1,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it.each([101, 201])(
    "fans out %i scheduled messages in complete queue-safe batches",
    async (count) => {
      const sendBatch = vi.fn(async (_batch: unknown) => undefined);
      const planned = Array.from({ length: count }, (_, index) => ({
        ...message,
        sourceId: `rss:${index}`,
        workId: `sync:${index}`,
      }));
      const handlers = createWorkerHandlers({
        syncSource: async () => "processed",
        planScheduled: async () => planned,
      });

      await handlers.scheduled(
        { noRetry: vi.fn() } as never,
        { INGESTION_QUEUE: { sendBatch } } as never,
      );

      const batches = sendBatch.mock.calls.map(
        ([batch]) => batch as Array<{ body: typeof message }>,
      );
      expect(batches.map((batch) => batch.length)).toEqual(
        count === 101 ? [100, 1] : [100, 100, 1],
      );
      expect(batches.flat().map(({ body }) => body.sourceId)).toEqual(
        planned.map(({ sourceId }) => sourceId),
      );
    },
  );

  it("keeps each scheduled queue batch within the serialized byte ceiling", async () => {
    const sendBatch = vi.fn(async (_batch: unknown) => undefined);
    const planned = Array.from({ length: 100 }, (_, index) => ({
      ...message,
      sourceId: `rss:${index}:${"x".repeat(2_900)}`,
      workId: `sync:${index}`,
    }));
    const handlers = createWorkerHandlers({
      syncSource: async () => "processed",
      planScheduled: async () => planned,
    });

    await handlers.scheduled(
      { noRetry: vi.fn() } as never,
      { INGESTION_QUEUE: { sendBatch } } as never,
    );

    expect(sendBatch.mock.calls.length).toBeGreaterThan(1);
    for (const [batch] of sendBatch.mock.calls) {
      const bytes = (batch as Array<{ body: unknown }>).reduce(
        (total, item) => total + new TextEncoder().encode(JSON.stringify(item)).byteLength + 100,
        0,
      );
      expect(bytes).toBeLessThanOrEqual(256_000);
    }
  });

  it("passes the scheduled controller timestamp to planning", async () => {
    const planScheduled = vi.fn(async () => [message]);
    const handlers = createWorkerHandlers({
      syncSource: async () => "processed",
      planScheduled,
    });
    const noRetry = vi.fn();

    await handlers.scheduled(
      { noRetry, scheduledTime: Date.parse("2026-08-28T12:00:00.000Z") } as never,
      { INGESTION_QUEUE: { sendBatch: vi.fn(async () => undefined) } } as never,
    );

    expect(planScheduled).toHaveBeenCalledWith(expect.anything(), "2026-08-28T12:00:00.000Z");
  });

  it("retries a queue message when its source work claim is still pending", async () => {
    const input = queueMessage(message);
    const handlers = createWorkerHandlers({
      syncSource: async () => "retry",
      planScheduled: async () => [],
    });

    await handlers.queue({ messages: [input] } as never, {} as never);

    expect(input.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(input.ack).not.toHaveBeenCalled();
  });
});
