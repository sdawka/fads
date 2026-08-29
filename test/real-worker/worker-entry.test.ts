import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  applyD1Migrations,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/app-env";
import type { SyncSourceMessage } from "../../src/contracts";
// @ts-expect-error Astro generates this entry during the build that precedes this test.
import builtWorker from "../../dist/server/entry.mjs";

interface BuiltWorker {
  fetch(request: Request, env: AppEnv, context: ExecutionContext): Promise<Response>;
  queue(
    batch: MessageBatch<SyncSourceMessage>,
    env: AppEnv,
    context: ExecutionContext,
  ): void | Promise<void>;
  scheduled(
    controller: ScheduledController,
    env: AppEnv,
    context: ExecutionContext,
  ): void | Promise<void>;
}

const worker = builtWorker as BuiltWorker;
const appEnv = env as unknown as AppEnv;

beforeAll(async () => {
  await applyD1Migrations(appEnv.DB, env.TEST_MIGRATIONS);
});

describe("built Worker entry", () => {
  it("serves health and delegates non-API requests to the built Astro application", async () => {
    const context = createExecutionContext();
    const health = await worker.fetch(new Request("https://f.ads/api/health"), appEnv, context);
    const page = await worker.fetch(new Request("https://f.ads/"), appEnv, context);
    const concept = await worker.fetch(new Request("https://f.ads/concept/"), appEnv, context);

    await expect(health.json()).resolves.toEqual({ status: "ok" });
    await expect(page.text()).resolves.toContain("f.ads");
    expect(concept.headers.get("content-security-policy")).toContain("sandbox");
    expect(concept.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  });

  it("runs the real queue and schedule exports", async () => {
    const context = createExecutionContext();
    const batch = createMessageBatch<SyncSourceMessage>("fads-ingestion-local", [
      {
        id: "built-entry-message",
        timestamp: new Date("2026-08-28T12:00:00.000Z"),
        attempts: 1,
        body: {
          version: 1,
          kind: "sync_source",
          ownerId: "did:plc:testowner123",
          sourceId: "rss:missing",
          workId: "real-worker:missing",
        },
      },
    ]);
    const controller = createScheduledController({ cron: "*/15 * * * *" });

    await worker.queue(batch, appEnv, context);
    await worker.scheduled(controller, appEnv, context);

    await expect(getQueueResult(batch, context)).resolves.toMatchObject({ outcome: "ok" });
    expect(controller.cron).toBe("*/15 * * * *");
  });
});
