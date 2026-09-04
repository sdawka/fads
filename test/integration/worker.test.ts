import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/app-env";
import type { SyncSourceMessage } from "../../src/contracts";
import worker from "../fixtures/worker";

const appEnv = env as unknown as AppEnv;

beforeAll(async () => {
  await applyD1Migrations(appEnv.DB, env.TEST_MIGRATIONS);
});

describe("foundation Worker", () => {
  it("serves an observable health response without delegating API traffic to Astro", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request("https://f.ads/api/health"), appEnv, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("acknowledges a versioned ingestion message", async () => {
    const context = createExecutionContext();
    const batch = createMessageBatch<SyncSourceMessage>("fads-ingestion-local", [
      {
        id: "message-1",
        timestamp: new Date("2026-08-28T12:00:00.000Z"),
        attempts: 1,
        body: {
          version: 1,
          kind: "sync_source",
          ownerId: "did:plc:testowner123",
          sourceId: "rss:missing",
          workId: "integration:missing",
        },
      },
    ]);

    await worker.queue(batch, appEnv);

    await expect(getQueueResult(batch, context)).resolves.toMatchObject({ outcome: "ok" });
  });

  it("accepts the configured schedule without retrying it", async () => {
    const controller = createScheduledController({ cron: "*/15 * * * *" });

    await worker.scheduled(controller, appEnv);

    expect(controller.cron).toBe("*/15 * * * *");
  });
});
