import type { AppEnv } from "./app-env";
import { SyncSourceMessageSchema } from "./contracts";
import { loadRuntimeConfig } from "./runtime-config";
import { createAtprotoAuth, type OwnerSessionStore } from "./modules/auth";
import { createAtprotoSourceFromSession } from "./modules/sources/atproto";
import { createRssSourceAdapter, createRssSynchronizer } from "./modules/sources/rss";
import {
  consumeSourceSyncMessage,
  D1OwnerDataRepository,
  planStaleSourceSyncs,
} from "./modules/storage";

type SyncSourceMessage = ReturnType<typeof SyncSourceMessageSchema.parse>;
type SyncResult = "processed" | "duplicate" | void;

export interface WorkerHandlerDependencies {
  syncSource(env: AppEnv, message: SyncSourceMessage): Promise<SyncResult>;
  planScheduled(env: AppEnv, now: string): Promise<SyncSourceMessage[]>;
}

export function createWorkerHandlers(dependencies: WorkerHandlerDependencies) {
  return {
    async queue(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
      for (const message of batch.messages) {
        const result = await consumeSourceSyncMessage(message.body, (body) =>
          dependencies.syncSource(env, body),
        );
        if (result.outcome === "retry") message.retry();
        else message.ack();
      }
    },

    async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
      const messages = await dependencies.planScheduled(env, new Date().toISOString());
      if (messages.length) {
        await env.INGESTION_QUEUE.sendBatch(messages.map((body) => ({ body })));
      }
      controller.noRetry();
    },
  };
}

const productionDependencies: WorkerHandlerDependencies = {
  async syncSource(env, message) {
    const config = loadRuntimeConfig(env);
    if (message.ownerId !== config.ownerDid) throw statusError(403, "Owner mismatch");
    const repository = new D1OwnerDataRepository(env.DB);
    const source = await repository.getSource(message.ownerId, message.sourceId);
    if (!source) throw statusError(404, "Source not found");
    await repository.setSourceStatus(message.ownerId, message.sourceId, {
      status: "syncing",
      updatedAt: new Date().toISOString(),
    });

    try {
      const adapter =
        source.adapter === "rss"
          ? createRssSourceAdapter({
              sourceId: source.id,
              feedUrl: source.url ?? "",
              fetch: globalThis.fetch,
            })
          : createAtprotoSourceFromSession({
              ownerDid: config.ownerDid,
              sourceId: source.id,
              session: await ownerAuth(env).restoreOwner(),
              safetyLabels: new Set(config.safetyLabels),
              ...(typeof source.config.feedUri === "string"
                ? { stream: { kind: "feed" as const, uri: source.config.feedUri } }
                : {}),
            });
      await createRssSynchronizer({
        sourceId: source.id,
        adapter,
        repository: repository.rssSyncRepository(message.ownerId, source.id),
      }).sync();
      return "processed";
    } catch (error) {
      const normalized = normalizeSyncError(error);
      await repository.setSourceStatus(message.ownerId, message.sourceId, {
        status: "error",
        lastError: normalized.message.slice(0, 500),
        updatedAt: new Date().toISOString(),
      });
      throw normalized;
    }
  },

  async planScheduled(env, now) {
    const config = loadRuntimeConfig(env);
    const repository = new D1OwnerDataRepository(env.DB);
    return planStaleSourceSyncs(
      config.ownerDid,
      await repository.listSources(config.ownerDid),
      now,
    );
  },
};

function ownerAuth(env: AppEnv) {
  const config = loadRuntimeConfig(env);
  const session = env.OWNER_SESSION.getByName(config.ownerDid) as unknown as OwnerSessionStore;
  return createAtprotoAuth({
    ownerDid: config.ownerDid,
    origin: config.origin,
    privateJwks: config.privateJwks,
    session,
  });
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function normalizeSyncError(error: unknown): Error & { status?: number } {
  if (error instanceof Error) {
    const existing = Number((error as Error & { status?: unknown }).status);
    if (Number.isFinite(existing)) return Object.assign(error, { status: existing });
    const responseStatus = /\b(?:status |with )(\d{3})\b/i.exec(error.message)?.[1];
    if (responseStatus) return Object.assign(error, { status: Number(responseStatus) });
    if (/invalid|unsupported|private|loopback|redirect limit|missing location/i.test(error.message)) {
      return Object.assign(error, { status: 400 });
    }
    return Object.assign(error, { status: 503 });
  }
  return statusError(503, "Source synchronization failed");
}

const productionHandlers = createWorkerHandlers(productionDependencies);

export const handleQueue = productionHandlers.queue;
export const handleScheduled = productionHandlers.scheduled;
