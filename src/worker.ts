import { handle } from "@astrojs/cloudflare/handler";
import type { AppEnv } from "./app-env";
import { handleApplicationRuntime } from "./application-runtime";
import { type SyncSourceMessage } from "./contracts";
import { OwnerSessionDO } from "./owner-session-do";
import { handleQueue, handleScheduled } from "./worker-handlers";
import { createFetchHandler } from "./worker-routing";

const fetch = createFetchHandler<Request, AppEnv, ExecutionContext<unknown>>(
  (request, env, context) => handle(request, env as unknown as Env, context),
  (request, env) => handleApplicationRuntime(request, env),
);

export { OwnerSessionDO };

export default {
  async fetch(request, env, ctx) {
    return fetch(request, env, ctx);
  },

  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<AppEnv, SyncSourceMessage>;
