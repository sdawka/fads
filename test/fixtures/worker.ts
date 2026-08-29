import { OwnerSessionDO } from "../../src/owner-session-do";
import type { AppEnv } from "../../src/app-env";
import { type SyncSourceMessage } from "../../src/contracts";
import { handleQueue, handleScheduled } from "../../src/worker-handlers";
import { createFetchHandler } from "../../src/worker-routing";

const fetch = createFetchHandler(
  async (_request: Request, _env: AppEnv, _context: ExecutionContext) =>
    new Response("Astro handler test double"),
);

export { OwnerSessionDO };

export default {
  fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies Pick<
  Required<ExportedHandler<AppEnv, SyncSourceMessage>>,
  "fetch" | "queue" | "scheduled"
>;
