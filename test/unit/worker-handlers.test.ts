import { describe, expect, it, vi } from "vitest";
import { createWorkerHandlers } from "../../src/worker-handlers";

const message = {
  version: 1,
  kind: "sync_source",
  ownerId: "did:plc:owner",
  sourceId: "rss:one",
} as const;

function queueMessage(body: unknown) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

describe("Worker ingestion handlers", () => {
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

    await handlers.scheduled(
      { noRetry } as never,
      { INGESTION_QUEUE: { sendBatch } } as never,
    );

    expect(sendBatch).toHaveBeenCalledWith([{ body: message }]);
    expect(noRetry).toHaveBeenCalledOnce();
  });
});
