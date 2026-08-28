import { handle } from "@astrojs/cloudflare/handler";
import { type QueueMessage } from "./contracts";
import { OwnerSessionDO } from "./owner-session-do";
import { handleQueue, handleScheduled } from "./worker-handlers";
import { createFetchHandler } from "./worker-routing";

const fetch = createFetchHandler(handle);

export { OwnerSessionDO };

export default {
  async fetch(request, env, ctx) {
    return fetch(request, env, ctx);
  },

  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env, QueueMessage>;
