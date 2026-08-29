import { describe, expect, it } from "vitest";

import { getOfflineStatus, registerOfflineServiceWorker } from "../../src/modules/offline/client";
import { createMemoryOutbox, enqueueMutation } from "../../src/modules/offline/outbox";

describe("offline browser client", () => {
  it("is safe to call during server rendering", async () => {
    expect(await registerOfflineServiceWorker()).toBeUndefined();
  });

  it("surfaces pending and permanent-failure state for the owner UI", async () => {
    const store = createMemoryOutbox();
    await enqueueMutation(
      store,
      new Request("https://fads.cc/api/v1/editions/edition-1/progress", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "progress-1" },
        body: JSON.stringify({ position: 1 }),
      }),
    );
    expect(await getOfflineStatus(store)).toEqual({
      pending: 1,
      failed: 0,
      hasPending: true,
      hasFailed: false,
    });
  });
});
