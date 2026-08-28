import { describe, expect, it } from "vitest";
import { createFetchHandler } from "../../src/worker-routing";

describe("Worker fetch routing", () => {
  it("delegates non-API traffic to the supplied Astro handler", async () => {
    const fetch = createFetchHandler(async () => new Response("rendered by Astro"));

    const response = await fetch(new Request("https://f.ads/"), {} as Env, {} as ExecutionContext);

    expect(await response.text()).toBe("rendered by Astro");
  });
});
