import { describe, expect, it } from "vitest";

import { registerOfflineServiceWorker } from "../../src/modules/offline/client";

describe("offline browser client", () => {
  it("is safe to call during server rendering", async () => {
    expect(await registerOfflineServiceWorker()).toBeUndefined();
  });
});
