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
    expect(buildBootstrapSuggestionRecords("did:plc:owner", [], "2026-08-28T12:00:00.000Z"))
      .toEqual([]);
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
    });

    await handlers.queue({ messages: inputs } as never, {} as never);

    expect(inputs.slice(0, 4).every((input) => input.ack.mock.calls.length === 1)).toBe(true);
    expect(inputs.slice(0, 4).every((input) => input.retry.mock.calls.length === 0)).toBe(true);
    expect(inputs[4].ack).not.toHaveBeenCalled();
    expect(inputs[4].retry).toHaveBeenCalledOnce();
  });

  it("enqueues only planned stale source messages and disables schedule retries", async () => {
    const sendBatch = vi.fn(async () => undefined);
    const noRetry = vi.fn();
    const handlers = createWorkerHandlers({
      syncSource: async () => "processed",
      planScheduled: async () => [message],
    });

    await handlers.scheduled({ noRetry } as never, { INGESTION_QUEUE: { sendBatch } } as never);

    expect(sendBatch).toHaveBeenCalledWith([{ body: message }]);
    expect(noRetry).toHaveBeenCalledOnce();
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

    expect(input.retry).toHaveBeenCalledOnce();
    expect(input.ack).not.toHaveBeenCalled();
  });
});
