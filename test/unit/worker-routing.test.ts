import { describe, expect, it, vi } from "vitest";
import { createFetchHandler } from "../../src/worker-routing";

describe("Worker fetch routing", () => {
  it("delegates non-API traffic to the supplied Astro handler", async () => {
    const fetch = createFetchHandler(async () => new Response("rendered by Astro"));

    const response = await fetch(new Request("https://f.ads/"), {} as Env, {} as ExecutionContext);

    expect(await response.text()).toBe("rendered by Astro");
  });

  it("gives runtime routes precedence over Astro without exposing unknown API paths", async () => {
    const astro = vi.fn(async () => new Response("rendered by Astro"));
    const runtime = vi.fn(async (request: Request) =>
      new URL(request.url).pathname === "/oauth/jwks.json"
        ? Response.json({ keys: [] })
        : undefined,
    );
    const fetch = createFetchHandler(astro, runtime);

    const runtimeResponse = await fetch(
      new Request("https://fads.cc/oauth/jwks.json"),
      {} as Env,
      {} as ExecutionContext,
    );
    const astroResponse = await fetch(
      new Request("https://fads.cc/keeps"),
      {} as Env,
      {} as ExecutionContext,
    );

    await expect(runtimeResponse.json()).resolves.toEqual({ keys: [] });
    await expect(astroResponse.text()).resolves.toBe("rendered by Astro");
    expect(astro).toHaveBeenCalledOnce();
  });
});
