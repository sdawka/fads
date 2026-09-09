import type { AppEnv } from "./app-env";
import {
  InterestSuggestionSchema,
  SyncSourceMessageSchema,
  type ContentEnvelope,
  type Evidence,
} from "./contracts";
import { loadRuntimeConfig } from "./runtime-config";
import { createAtprotoAuth, type OwnerSessionStore } from "./modules/auth";
import { deriveBootstrapSuggestions } from "./modules/curation";
import { createAtprotoSourceFromSession } from "./modules/sources/atproto";
import { createRssSourceAdapter, createRssSynchronizer } from "./modules/sources/rss";
import {
  consumeSourceSyncMessage,
  D1OwnerDataRepository,
  planStaleSourceSyncs,
} from "./modules/storage";

type SyncSourceMessage = ReturnType<typeof SyncSourceMessageSchema.parse>;
type SyncResult = "processed" | "duplicate" | "retry" | void;
const QUEUE_BATCH_MAX_MESSAGES = 100;
const QUEUE_BATCH_MAX_BYTES = 256_000;
const QUEUE_MESSAGE_MAX_BYTES = 128_000;
const QUEUE_MESSAGE_METADATA_BYTES = 100;

export function createQueueBatches(
  messages: readonly SyncSourceMessage[],
): Array<Array<{ body: SyncSourceMessage }>> {
  const batches: Array<Array<{ body: SyncSourceMessage }>> = [];
  let batch: Array<{ body: SyncSourceMessage }> = [];
  let batchBytes = 0;
  for (const body of messages) {
    const messageBytes =
      new TextEncoder().encode(JSON.stringify({ body })).byteLength + QUEUE_MESSAGE_METADATA_BYTES;
    if (messageBytes > QUEUE_MESSAGE_MAX_BYTES) {
      throw new Error("Scheduled source sync message exceeds the queue size limit");
    }
    if (
      batch.length > 0 &&
      (batch.length >= QUEUE_BATCH_MAX_MESSAGES ||
        batchBytes + messageBytes > QUEUE_BATCH_MAX_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push({ body });
    batchBytes += messageBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function suggestionId(ownerId: string, value: string): string {
  const normalized = value.trim().toLowerCase();
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(`${ownerId}\u0000${normalized}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  const slug =
    normalized
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "interest";
  return `suggestion:${slug}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildBootstrapSuggestionRecords(
  ownerId: string,
  items: readonly ContentEnvelope[],
  createdAt: string,
) {
  const evidence: Evidence[] = items.map((item) => ({
    sourceId: item.sourceId,
    subjectUri: item.canonicalUri,
    observedAt: item.capturedAt,
    tags: item.tags,
  }));
  return deriveBootstrapSuggestions(evidence)
    .filter((suggestion) => suggestion.value.length <= 120)
    .map((suggestion) =>
      InterestSuggestionSchema.parse({
        id: suggestionId(ownerId, suggestion.value),
        ownerId,
        value: suggestion.value,
        evidenceCount: suggestion.evidenceCount,
        provenance: suggestion.provenance,
        status: "pending",
        createdAt,
      }),
    );
}

export interface WorkerHandlerDependencies {
  syncSource(env: AppEnv, message: SyncSourceMessage): Promise<SyncResult>;
  planScheduled(env: AppEnv, now: string): Promise<SyncSourceMessage[]>;
  log?: (event: WorkerOperationalEvent) => void;
}

export type WorkerOperationalEvent =
  | {
      event: "ingestion_queue";
      received: number;
      processed: number;
      duplicate: number;
      retried: number;
      discarded: number;
    }
  | {
      event: "ingestion_scheduled";
      outcome: "sent" | "failed";
      planned: number;
      batches: number;
    };

export function createWorkerHandlers(dependencies: WorkerHandlerDependencies) {
  return {
    async queue(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
      const outcomes = { processed: 0, duplicate: 0, retried: 0, discarded: 0 };
      for (const message of batch.messages) {
        const result = await consumeSourceSyncMessage(message.body, (body) =>
          dependencies.syncSource(env, body),
        );
        if (result.outcome === "retry") {
          outcomes.retried += 1;
          message.retry({ delaySeconds: 60 });
        } else {
          if (result.outcome === "processed") outcomes.processed += 1;
          else if (result.outcome === "duplicate") outcomes.duplicate += 1;
          else outcomes.discarded += 1;
          message.ack();
        }
      }
      safeLog(dependencies.log, {
        event: "ingestion_queue",
        received: batch.messages.length,
        ...outcomes,
      });
    },

    async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
      const scheduledTime =
        typeof controller.scheduledTime === "number" && Number.isFinite(controller.scheduledTime)
          ? new Date(controller.scheduledTime).toISOString()
          : new Date().toISOString();
      const messages = await dependencies.planScheduled(env, scheduledTime);
      const batches = createQueueBatches(messages);
      try {
        for (const batch of batches) {
          await env.INGESTION_QUEUE.sendBatch(batch);
        }
      } catch (error) {
        safeLog(dependencies.log, {
          event: "ingestion_scheduled",
          outcome: "failed",
          planned: messages.length,
          batches: batches.length,
        });
        throw error;
      }
      safeLog(dependencies.log, {
        event: "ingestion_scheduled",
        outcome: "sent",
        planned: messages.length,
        batches: batches.length,
      });
      controller.noRetry();
    },
  };
}

const productionDependencies: WorkerHandlerDependencies = {
  log(event) {
    console.info(JSON.stringify(event));
  },
  async syncSource(env, message) {
    const config = loadRuntimeConfig(env);
    if (message.ownerId !== config.ownerDid) throw statusError(403, "Owner mismatch");
    return ownerAuth(env).withOwnerMutation(async () => {
      const repository = new D1OwnerDataRepository(env.DB);
      const source = await repository.getSource(message.ownerId, message.sourceId);
      if (!source) throw statusError(404, "Source not found");

      const claim = await repository.claimSyncWork({
        ownerId: message.ownerId,
        sourceId: message.sourceId,
        fingerprint: message.workId,
        now: new Date().toISOString(),
      });
      if (claim.status === "duplicate") return "duplicate";
      if (claim.status === "pending") return "retry";

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
        const syncResult = await createRssSynchronizer({
          sourceId: source.id,
          adapter,
          repository: repository.rssSyncRepository(message.ownerId, source.id),
        }).sync();
        const suggestions = buildBootstrapSuggestionRecords(
          message.ownerId,
          syncResult.items,
          new Date().toISOString(),
        );
        if (suggestions.length) {
          await repository.upsertBootstrapSuggestions(message.ownerId, suggestions);
        }
        const completed = await repository.completeSyncWork({
          ownerId: message.ownerId,
          sourceId: message.sourceId,
          fingerprint: message.workId,
          claimToken: claim.claimToken,
          outcome: "processed",
          completedAt: new Date().toISOString(),
        });
        if (!completed) throw statusError(503, "Source synchronization claim expired");
        return "processed";
      } catch (error) {
        const normalized = normalizeSyncError(error);
        const transient =
          normalized.status === 429 || normalized.status === undefined || normalized.status >= 500;
        if (!transient) {
          const completed = await repository.completeSyncWork({
            ownerId: message.ownerId,
            sourceId: message.sourceId,
            fingerprint: message.workId,
            claimToken: claim.claimToken,
            outcome: "failed",
            completedAt: new Date().toISOString(),
          });
          if (!completed) throw statusError(503, "Source synchronization claim expired");
        }
        try {
          await repository.setSourceStatus(message.ownerId, message.sourceId, {
            status: "error",
            lastError: normalized.message.slice(0, 500),
            updatedAt: new Date().toISOString(),
          });
        } finally {
          if (transient) {
            await repository.releaseSyncWork({
              ownerId: message.ownerId,
              sourceId: message.sourceId,
              fingerprint: message.workId,
              claimToken: claim.claimToken,
            });
          }
        }
        throw normalized;
      }
    });
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

function safeLog(log: WorkerHandlerDependencies["log"], event: WorkerOperationalEvent): void {
  try {
    log?.(event);
  } catch {
    // Operational telemetry must never alter queue acknowledgement or retry behavior.
  }
}

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
    if (
      /invalid|unsupported|private|loopback|redirect limit|missing location/i.test(error.message)
    ) {
      return Object.assign(error, { status: 400 });
    }
    return Object.assign(error, { status: 503 });
  }
  return statusError(503, "Source synchronization failed");
}

const productionHandlers = createWorkerHandlers(productionDependencies);

export const handleQueue = (batch: MessageBatch<unknown>, env: AppEnv) =>
  productionHandlers.queue(batch, env);
export const handleScheduled = (controller: ScheduledController, env: AppEnv) =>
  productionHandlers.scheduled(controller, env);
