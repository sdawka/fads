import { describe, expect, it, vi } from "vitest";
import { handleApplicationRuntime, enqueueSourceBatches } from "../../src/application-runtime";

const config = {
  OWNER_DID: "did:plc:owner123",
  APP_ORIGIN: "https://fads.cc",
  ATPROTO_OAUTH_PRIVATE_JWKS: JSON.stringify([
    {
      kty: "EC",
      kid: "owner-key",
      alg: "ES256",
      crv: "P-256",
      x: "public-x",
      y: "public-y",
      d: "private-d",
    },
  ]),
};

function environment() {
  const getByName = vi.fn(() => ({}));
  return {
    ...config,
    DB: {},
    INGESTION_QUEUE: { send: vi.fn(async () => undefined) },
    OWNER_SESSION: { getByName },
    getByName,
  };
}

describe("application runtime assembly", () => {
  it("does not require private configuration for Astro-owned routes", async () => {
    await expect(
      handleApplicationRuntime(new Request("https://fads.cc/keeps/"), {} as never),
    ).resolves.toBeUndefined();
  });

  it("publishes OAuth metadata using the configured owner session namespace", async () => {
    const env = environment();

    const response = await handleApplicationRuntime(
      new Request("https://fads.cc/oauth/client-metadata.json"),
      env as never,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      client_id: "https://fads.cc/oauth/client-metadata.json",
      redirect_uris: ["https://fads.cc/oauth/callback"],
    });
    expect(env.getByName).toHaveBeenCalledWith("did:plc:owner123");
  });

  it("serves signed-out session inspection and blocks private APIs", async () => {
    const env = environment();

    const session = await handleApplicationRuntime(
      new Request("https://fads.cc/api/v1/session"),
      env as never,
    );
    const privateResponse = await handleApplicationRuntime(
      new Request("https://fads.cc/api/v1/sources"),
      env as never,
    );

    await expect(session?.json()).resolves.toEqual({ authenticated: false });
    expect(privateResponse?.status).toBe(401);
    expect(privateResponse?.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rechecks authentication inside the mutation lock after an earlier inspection", async () => {
    const env = environment();
    const session = {
      readAppSession: vi
        .fn()
        .mockResolvedValueOnce({
          did: config.OWNER_DID,
          absoluteExpiresAt: Date.now() + 60_000,
          generation: 0,
        })
        .mockResolvedValue(undefined),
      touchAppSession: vi.fn(async () => true),
      getAuthGeneration: vi.fn(async () => 1),
      tryAcquireRefreshLock: vi.fn(async () => true),
      releaseRefreshLock: vi.fn(async () => undefined),
    };
    env.getByName.mockReturnValue(session);
    const response = await handleApplicationRuntime(
      new Request("https://fads.cc/api/v1/sources", {
        method: "POST",
        headers: {
          cookie: "fads_session=old-session",
          "content-type": "application/json",
          "idempotency-key": "test-key",
        },
        body: JSON.stringify({
          adapter: "rss",
          displayName: "Example",
          url: "https://example.com/feed.xml",
          config: {},
        }),
      }),
      env as never,
    );
    expect(response?.status).toBe(409);
    expect(session.readAppSession).toHaveBeenCalledTimes(2);
    expect(session.releaseRefreshLock).toHaveBeenCalledOnce();
  });

  it("fails closed on private routes when production configuration is absent", async () => {
    await expect(
      handleApplicationRuntime(new Request("https://fads.cc/api/v1/session"), {} as never),
    ).rejects.toThrow("owner DID");
  });
});

it("reports only the unaccepted suffix when a later queue batch fails", async () => {
  const messages = Array.from({ length: 201 }, (_, index) => ({
    version: 1 as const,
    kind: "sync_source" as const,
    ownerId: "did:plc:owner",
    sourceId: `source:${index}`,
    workId: `work:${index}`,
  }));
  const sendBatch = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("queue unavailable"));
  const result = await enqueueSourceBatches({ sendBatch }, messages);
  expect(sendBatch).toHaveBeenCalledTimes(2);
  expect(result.failedSourceIds).toEqual(messages.slice(100).map((message) => message.sourceId));
});
