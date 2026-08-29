import type { AppEnv } from "./app-env";
import { loadRuntimeConfig } from "./runtime-config";
import { createRuntimeRouter } from "./runtime-router";
import { createAtprotoAuth, type OwnerSessionStore } from "./modules/auth";
import { createOwnerApiHandler } from "./modules/api";
import { createD1EditionRepository, EditionService } from "./modules/editions";
import { D1OwnerDataRepository } from "./modules/storage";

export async function handleApplicationRuntime(
  request: Request,
  env: AppEnv,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
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
        authenticate: () => Promise.resolve(owner),
        logout: (logoutRequest, options) => auth.logout(logoutRequest, options),
        repository,
        editions,
        enqueueSource: async (message) => {
          await env.INGESTION_QUEUE.send(message);
        },
      });
      return api(apiRequest);
    },
  });
  return route(request);
}
