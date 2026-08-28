import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/app-env";
import type { QueueMessage } from "../../src/contracts";
import worker from "../fixtures/worker";

const appEnv = env as unknown as AppEnv;

describe("foundation Worker", () => {
  it("serves an observable health response without delegating API traffic to Astro", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request("https://f.ads/api/health"), appEnv, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("acknowledges a versioned ingestion message", async () => {
    const context = createExecutionContext();
    const batch = createMessageBatch<QueueMessage>("fads-ingestion-local", [
      {
        id: "message-1",
        timestamp: new Date("2026-08-28T12:00:00.000Z"),
        attempts: 1,
        body: { version: 1, kind: "sync_all" },
      },
    ]);

    await worker.queue(batch);

    await expect(getQueueResult(batch, context)).resolves.toMatchObject({ outcome: "ok" });
  });

  it("accepts the configured schedule without retrying it", async () => {
    const controller = createScheduledController({ cron: "*/15 * * * *" });

    await worker.scheduled(controller);

    expect(controller.cron).toBe("*/15 * * * *");
  });
});
