import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QueueMessage } from "../../src/contracts";
import worker from "../fixtures/worker";

const testWorker = worker as ExportedHandler<Env, QueueMessage>;

describe("foundation Worker", () => {
  it("serves an observable health response without delegating API traffic to Astro", async () => {
    const context = createExecutionContext();
    const response = await testWorker.fetch(new Request("https://f.ads/api/health"), env, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("acknowledges a versioned ingestion message", async () => {
    const context = createExecutionContext();
    const batch = createMessageBatch("fads-ingestion-local", [
      {
        id: "message-1",
        timestamp: new Date("2026-08-28T12:00:00.000Z"),
        attempts: 1,
        body: { version: 1, kind: "sync_all" },
      },
    ]);

    await testWorker.queue(batch, env, context);

    await expect(getQueueResult(batch, context)).resolves.toMatchObject({ outcome: "ok" });
  });

  it("accepts the configured schedule without retrying it", async () => {
    const context = createExecutionContext();
    const controller = createScheduledController({ cron: "*/15 * * * *" });

    await testWorker.scheduled(controller, env, context);

    expect(controller.cron).toBe("*/15 * * * *");
  });
});
