import { OwnerSessionDO } from "../../src/owner-session-do";
import { type QueueMessage } from "../../src/contracts";
import { handleQueue, handleScheduled } from "../../src/worker-handlers";
import { createFetchHandler } from "../../src/worker-routing";

const fetch = createFetchHandler(async () => new Response("Astro handler test double"));

export { OwnerSessionDO };

export default {
  fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env, QueueMessage>;
