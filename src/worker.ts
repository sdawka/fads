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
    const path = new URL(request.url).pathname;
    const category = path.startsWith("/oauth/")
      ? "oauth"
      : path.startsWith("/api/")
        ? "api"
        : "page";
    try {
      const response = await fetch(request, env, ctx);
      if (category === "oauth" || response.status >= 500) {
        console.info(
          JSON.stringify({ event: "request_result", category, status: response.status }),
        );
      }
      return response;
    } catch (error) {
      console.error(JSON.stringify({ event: "request_result", category, status: 500 }));
      throw error;
    }
  },

  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<AppEnv, SyncSourceMessage>;
