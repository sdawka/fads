import { describe, expect, it, vi } from "vitest";
import { createRuntimeRouter } from "../../src/runtime-router";

function createHarness(authenticated = true) {
  const auth = {
    clientMetadata: vi.fn(() => ({ client_id: "https://fads.cc/oauth/client-metadata.json" })),
    jwks: vi.fn(() => ({ keys: [{ kty: "EC", x: "public" }] })),
    start: vi.fn(async () => Response.redirect("https://pds.example/authorize", 302)),
    callback: vi.fn(async () => Response.redirect("https://fads.cc/", 302)),
    inspect: vi.fn(async () => (authenticated ? { did: "did:plc:owner" } : undefined)),
    logout: vi.fn(async () => new Response(null, { status: 204 })),
  };
  const api = vi.fn(async (_request: Request, owner: { did: string }) =>
    Response.json({ owner: owner.did }),
  );
  return { auth, api, route: createRuntimeRouter({ auth, api }) };
}

describe("runtime route boundary", () => {
  it("serves public OAuth metadata without inspecting a session", async () => {
    const { auth, route } = createHarness(false);

    const response = await route(new Request("https://fads.cc/oauth/client-metadata.json"));

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      client_id: "https://fads.cc/oauth/client-metadata.json",
    });
    expect(response?.headers.get("cache-control")).toContain("public");
    expect(auth.inspect).not.toHaveBeenCalled();
  });

  it("exposes only public JWK material supplied by the auth boundary", async () => {
    const { route } = createHarness();

    const response = await route(new Request("https://fads.cc/oauth/jwks.json"));

    await expect(response?.json()).resolves.toEqual({ keys: [{ kty: "EC", x: "public" }] });
  });

  it("reports signed-out session state privately", async () => {
    const { route } = createHarness(false);

    const response = await route(new Request("https://fads.cc/api/v1/session"));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    await expect(response?.json()).resolves.toEqual({ authenticated: false });
  });

  it("rejects private API traffic before invoking the API handler", async () => {
    const { api, route } = createHarness(false);

    const response = await route(new Request("https://fads.cc/api/v1/editions"));

    expect(response?.status).toBe(401);
    expect(response?.headers.get("content-type")).toContain("application/problem+json");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(api).not.toHaveBeenCalled();
  });

  it("passes only the inspected owner identity to the private API", async () => {
    const { api, route } = createHarness(true);
    const request = new Request("https://fads.cc/api/v1/editions");

    const response = await route(request);

    expect(api).toHaveBeenCalledWith(request, { did: "did:plc:owner" });
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    await expect(response?.json()).resolves.toEqual({ owner: "did:plc:owner" });
  });

  it("delegates authenticated logout to the idempotent private API", async () => {
    const { api, auth, route } = createHarness();
    const request = new Request("https://fads.cc/api/v1/logout", { method: "POST" });

    const response = await route(request);

    expect(response?.status).toBe(200);
    expect(api).toHaveBeenCalledWith(request, { did: "did:plc:owner" });
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it("does not permit an unauthenticated logout mutation", async () => {
    const { api, auth, route } = createHarness(false);

    const response = await route(
      new Request("https://fads.cc/api/v1/logout", { method: "POST" }),
    );

    expect(response?.status).toBe(401);
    expect(api).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it("returns undefined for Astro-owned routes", async () => {
    const { route } = createHarness();

    await expect(route(new Request("https://fads.cc/keeps"))).resolves.toBeUndefined();
  });
});
