import type { SyncSourceMessage } from "./contracts";
import type { AppEnv } from "./app-env";
import { loadRuntimeConfig } from "./runtime-config";
import { createRuntimeRouter } from "./runtime-router";
import { createAtprotoAuth, type OwnerSessionStore } from "./modules/auth";
import { createOwnerApiHandler } from "./modules/api";
import { createD1EditionRepository, EditionService } from "./modules/editions";
import { D1OwnerDataRepository } from "./modules/storage";
import { createQueueBatches } from "./worker-handlers";
import { checkReadiness } from "./readiness";

export async function handleApplicationRuntime(
  request: Request,
  env: AppEnv,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/api/ready") {
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    const ready = await checkReadiness({
      validateConfig: () => {
        loadRuntimeConfig(env);
        if (!env.INGESTION_QUEUE?.send) throw new Error("Missing queue binding");
      },
      checkDatabase: async () => {
        await env.DB.prepare("SELECT owner_id FROM sources LIMIT 1").all();
        await env.DB.prepare("SELECT owner_id FROM owner_preferences LIMIT 1").all();
        await env.DB.prepare("SELECT source_id FROM source_sync_work LIMIT 1").all();
      },
      checkSessions: async () => {
        const config = loadRuntimeConfig(env);
        const session = env.OWNER_SESSION.getByName(
          config.ownerDid,
        ) as unknown as OwnerSessionStore;
        await session.getOAuthSession({
          did: config.ownerDid,
        });
      },
    });
    return Response.json(
      { status: ready ? "ready" : "unavailable" },
      {
        status: ready ? 200 : 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
  if (!path.startsWith("/oauth/") && !path.startsWith("/api/v1/")) return undefined;

  const config = loadRuntimeConfig(env);
  const session = env.OWNER_SESSION.getByName(config.ownerDid) as unknown as OwnerSessionStore;
  const auth = createAtprotoAuth({
    ownerDid: config.ownerDid,
    origin: config.origin,
    privateJwks: config.privateJwks,
    session,
  });
  const repository = new D1OwnerDataRepository(env.DB);
  const editions = new EditionService(createD1EditionRepository(env.DB));
  const route = createRuntimeRouter({
    auth,
    api: async (apiRequest, owner) => {
      const api = createOwnerApiHandler({
        ownerDid: config.ownerDid,
        withMutation: (operation) =>
          auth.withOwnerMutation(async () => {
            // The request may have waited behind a full reset after the router authenticated it.
            if (!(await auth.inspect(apiRequest))) throw new Error("Session invalidated");
            return operation();
          }),
        authenticate: () => Promise.resolve(owner),
        logout: (logoutRequest, options) => auth.logout(logoutRequest, options),
        repository,
        editions,
        enqueueSources: (messages) => enqueueSourceBatches(env.INGESTION_QUEUE, messages),
        enqueueSource: async (message) => {
          await env.INGESTION_QUEUE.send(message);
        },
      });
      return api(apiRequest);
    },
  });
  return route(request);
}

export async function enqueueSourceBatches(
  queue: Pick<AppEnv["INGESTION_QUEUE"], "sendBatch">,
  messages: readonly SyncSourceMessage[],
): Promise<{ failedSourceIds: string[] }> {
  let accepted = 0;
  for (const batch of createQueueBatches(messages)) {
    try {
      await queue.sendBatch(batch);
      accepted += batch.length;
    } catch {
      return { failedSourceIds: messages.slice(accepted).map((message) => message.sourceId) };
    }
  }
  return { failedSourceIds: [] };
}
