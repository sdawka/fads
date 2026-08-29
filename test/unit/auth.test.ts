import { describe, expect, it } from "vitest";
import { createAtprotoAuth } from "../../src/modules/auth";

const ownerDid = "did:plc:owneralice123";

class MemoryOwnerSession {
  readonly apps = new Map<
    string,
    { did: string; idleExpiresAt: number; absoluteExpiresAt: number }
  >();
  readonly states = new Map<string, unknown>();
  readonly oauth = new Map<string, unknown>();
  readonly refreshLocks = new Map<string, string>();

  async createAppSession(input: {
    tokenHash: string;
    did: string;
    idleExpiresAt: number;
    absoluteExpiresAt: number;
  }) {
    this.apps.set(input.tokenHash, input);
  }

  async readAppSession(input: { tokenHash: string; now: number }) {
    const app = this.apps.get(input.tokenHash);
    if (!app || app.idleExpiresAt <= input.now || app.absoluteExpiresAt <= input.now)
      return undefined;
    return { did: app.did };
  }

  async deleteAppSession(input: { tokenHash: string }) {
    this.apps.delete(input.tokenHash);
  }

  async touchAppSession(input: { tokenHash: string; now: number; idleExpiresAt: number }) {
    const app = this.apps.get(input.tokenHash);
    if (app && app.absoluteExpiresAt > input.now)
      app.idleExpiresAt = Math.min(input.idleExpiresAt, app.absoluteExpiresAt);
  }

  async getOAuthState(input: { key: string }) {
    const value = this.states.get(input.key);
    this.states.delete(input.key);
    return value;
  }

  async putOAuthState(input: { key: string; value: unknown }) {
    this.states.set(input.key, input.value);
  }

  async deleteOAuthState(input: { key: string }) {
    this.states.delete(input.key);
  }

  async getOAuthSession(input: { did: string }) {
    return this.oauth.get(input.did);
  }

  async putOAuthSession(input: { did: string; value: unknown }) {
    this.oauth.set(input.did, input.value);
  }

  async deleteOAuthSession(input: { did: string }) {
    this.oauth.delete(input.did);
  }

  async tryAcquireRefreshLock(input: { name: string; holder: string }) {
    const existing = this.refreshLocks.get(input.name);
    if (existing && existing !== input.holder) return false;
    this.refreshLocks.set(input.name, input.holder);
    return true;
  }

  async releaseRefreshLock(input: { name: string; holder: string }) {
    if (this.refreshLocks.get(input.name) === input.holder) this.refreshLocks.delete(input.name);
  }

  async renewRefreshLock(input: { name: string; holder: string }) {
    return this.refreshLocks.get(input.name) === input.holder;
  }
}

describe("AT Protocol owner authentication", () => {
  it("publishes HTTPS metadata and never discloses private JWK members", async () => {
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "private", kid: "main" }],
      session: new MemoryOwnerSession(),
    });

    const metadata = await auth.clientMetadata();
    const jwks = await auth.jwks();

    expect(metadata.client_id).toBe("https://fads.example/oauth/client-metadata.json");
    expect(metadata.redirect_uris).toEqual(["https://fads.example/oauth/callback"]);
    expect(jwks).toEqual({ keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "main" }] });
  });

  it("projects only public JWK members from confidential EC, OKP, and RSA keys", async () => {
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [
        {
          kty: "EC",
          crv: "P-256",
          x: "ec-x",
          y: "ec-y",
          d: "ec-private",
          kid: "ec",
          q: "unknown-private",
        },
        {
          kty: "OKP",
          crv: "Ed25519",
          x: "okp-x",
          d: "okp-private",
          k: "symmetric-private",
          kid: "okp",
        },
        {
          kty: "RSA",
          n: "rsa-n",
          e: "AQAB",
          d: "rsa-private",
          p: "p",
          q: "q",
          dp: "dp",
          dq: "dq",
          qi: "qi",
          oth: [{ d: "nested" }],
          kid: "rsa",
          extra: "unknown",
        },
      ] as never,
      session: new MemoryOwnerSession(),
    });

    const jwks = await auth.jwks();

    expect(jwks).toEqual({
      keys: [
        { kty: "EC", crv: "P-256", x: "ec-x", y: "ec-y", kid: "ec" },
        { kty: "OKP", crv: "Ed25519", x: "okp-x", kid: "okp" },
        { kty: "RSA", n: "rsa-n", e: "AQAB", kid: "rsa" },
      ],
    });
  });

  it("rejects expired opaque app sessions", async () => {
    const session = new MemoryOwnerSession();
    let timestamp = 1_000;
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "private", kid: "main" }],
      session,
      now: () => timestamp,
      oauthFactory: () => ({
        metadata: {},
        authorize: async () => ({
          url: new URL("https://pds.example/authorize"),
          stateId: "state",
        }),
        callback: async () => ({ session: { did: ownerDid }, state: {} }) as never,
        restore: async () => ({ did: ownerDid }) as never,
        revoke: async () => undefined,
      }),
    });
    const callback = await auth.callback(
      new Request("https://fads.example/oauth/callback?code=code&state=state"),
    );
    const cookie = callback.headers.get("set-cookie")?.split(";")[0];
    timestamp += 8 * 60 * 60 * 1000;

    await expect(
      auth.inspect(new Request("https://fads.example", { headers: { cookie } })),
    ).resolves.toBeUndefined();
  });

  it("rejects a non-owner callback without creating an app session", async () => {
    const session = new MemoryOwnerSession();
    let revoked = false;
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "private", kid: "main" }],
      session,
      oauthFactory: () => ({
        metadata: {},
        authorize: async () => ({
          url: new URL("https://pds.example/authorize"),
          stateId: "state",
        }),
        callback: async () => ({ session: { did: "did:plc:someoneelse" }, state: {} }) as never,
        restore: async () => ({ did: ownerDid }) as never,
        revoke: async () => {
          revoked = true;
        },
      }),
    });

    const response = await auth.callback(
      new Request("https://fads.example/oauth/callback?code=code&state=state"),
    );

    expect(response.status).toBe(403);
    expect(revoked).toBe(true);
    expect(session.apps.size).toBe(0);
  });

  it("deletes a wrong-owner SDK session even when upstream revocation fails", async () => {
    const session = new MemoryOwnerSession();
    const wrongDid = "did:plc:someoneelse";
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "private", kid: "main" }],
      session,
      oauthFactory: () => ({
        metadata: {},
        authorize: async () => ({
          url: new URL("https://pds.example/authorize"),
          stateId: "state",
        }),
        callback: async () => {
          await session.putOAuthSession({ did: wrongDid, value: { refresh_token: "secret" } });
          return { session: { did: wrongDid }, state: {} } as never;
        },
        restore: async () => ({ did: ownerDid }) as never,
        revoke: async () => {
          throw new Error("upstream unavailable");
        },
      }),
    });

    const response = await auth.callback(
      new Request("https://fads.example/oauth/callback?code=code&state=state"),
    );

    expect(response.status).toBe(403);
    expect(session.apps.size).toBe(0);
    expect(session.oauth.has(wrongDid)).toBe(false);
  });

  it("consumes callback state once and issues only a secure opaque cookie", async () => {
    const session = new MemoryOwnerSession();
    await session.putOAuthState({ key: "one-time", value: { pkceVerifier: "verifier" } });
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "private", kid: "main" }],
      session,
      oauthFactory: () => ({
        metadata: {},
        authorize: async () => ({
          url: new URL("https://pds.example/authorize"),
          stateId: "state",
        }),
        callback: async (params) => {
          const state = params.get("state");
          if (!state || !(await session.getOAuthState({ key: state })))
            throw new Error("replayed state");
          return { session: { did: ownerDid }, state: {} } as never;
        },
        restore: async () => ({ did: ownerDid }) as never,
        revoke: async () => undefined,
      }),
    });
    const request = new Request("https://fads.example/oauth/callback?code=code&state=one-time");

    const first = await auth.callback(request);
    const replay = await auth.callback(request);

    expect(first.status).toBe(302);
    expect(first.headers.get("set-cookie")).toMatch(
      /^fads_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=604800$/,
    );
    expect(replay.status).toBe(400);
    expect(session.apps.size).toBe(1);
  });

  it("clears the server-side session and secure cookie when upstream logout fails", async () => {
    const session = new MemoryOwnerSession();
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "private", kid: "main" }],
      session,
      oauthFactory: () => ({
        metadata: {},
        authorize: async () => ({
          url: new URL("https://pds.example/authorize"),
          stateId: "state",
        }),
        callback: async () => ({ session: { did: ownerDid }, state: {} }) as never,
        restore: async () => ({ did: ownerDid }) as never,
        revoke: async () => {
          throw new Error("upstream unavailable");
        },
      }),
    });
    const callback = await auth.callback(
      new Request("https://fads.example/oauth/callback?code=code&state=state"),
    );
    const cookie = callback.headers.get("set-cookie")?.split(";")[0] ?? "";

    const response = await auth.logout(
      new Request("https://fads.example/logout", { headers: { cookie } }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBe(
      "fads_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    );
    await expect(
      auth.inspect(new Request("https://fads.example", { headers: { cookie } })),
    ).resolves.toBeUndefined();
  });

  it("extends an active session's bounded idle expiry without extending its absolute expiry", async () => {
    const session = new MemoryOwnerSession();
    let timestamp = 1_000;
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "private", kid: "main" }],
      session,
      now: () => timestamp,
      oauthFactory: () => ({
        metadata: {},
        authorize: async () => ({
          url: new URL("https://pds.example/authorize"),
          stateId: "state",
        }),
        callback: async () => ({ session: { did: ownerDid }, state: {} }) as never,
        restore: async () => ({ did: ownerDid }) as never,
        revoke: async () => undefined,
      }),
    });
    const callback = await auth.callback(
      new Request("https://fads.example/oauth/callback?code=code&state=state"),
    );
    const cookie = callback.headers.get("set-cookie")?.split(";")[0] ?? "";

    timestamp += 7 * 60 * 60 * 1000;
    await expect(
      auth.inspect(new Request("https://fads.example", { headers: { cookie } })),
    ).resolves.toEqual({ did: ownerDid });
    timestamp += 2 * 60 * 60 * 1000;
    await expect(
      auth.inspect(new Request("https://fads.example", { headers: { cookie } })),
    ).resolves.toEqual({ did: ownerDid });
  });

  it("serializes simultaneous OAuth refreshes through the owner session store", async () => {
    const session = new MemoryOwnerSession();
    let refreshed = false;
    let refreshes = 0;
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "private", kid: "main" }],
      session,
      oauthFactory: ({ requestLock }) => ({
        metadata: {},
        authorize: async () => ({
          url: new URL("https://pds.example/authorize"),
          stateId: "state",
        }),
        callback: async () => ({ session: { did: ownerDid }, state: {} }) as never,
        restore: () =>
          requestLock(`oauth-session-${ownerDid}`, async () => {
            activeRefreshes += 1;
            maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
            try {
              if (!refreshed) {
                refreshes += 1;
                await new Promise((resolve) => setTimeout(resolve, 10));
                refreshed = true;
              }
              return { did: ownerDid } as never;
            } finally {
              activeRefreshes -= 1;
            }
          }),
        revoke: async () => undefined,
      }),
    });
    const callback = await auth.callback(
      new Request("https://fads.example/oauth/callback?code=code&state=state"),
    );
    const cookie = callback.headers.get("set-cookie")?.split(";")[0] ?? "";
    const request = new Request("https://fads.example", { headers: { cookie } });

    await Promise.all([auth.restore(request), auth.restore(request)]);

    expect(refreshes).toBe(1);
    expect(maxActiveRefreshes).toBe(1);
  });

  it("restores the configured owner's OAuth session for background ingestion", async () => {
    const restored: string[] = [];
    const auth = createAtprotoAuth({
      ownerDid,
      origin: "https://fads.example",
      privateJwks: [
        { kty: "EC", crv: "P-256", x: "x", y: "y", d: "private", kid: "main" },
      ],
      session: new MemoryOwnerSession(),
      oauthFactory: () => ({
        metadata: {},
        authorize: async () => ({
          url: new URL("https://pds.example/authorize"),
          stateId: "state",
        }),
        callback: async () => ({ session: { did: ownerDid }, state: {} }) as never,
        restore: async (did) => {
          restored.push(did);
          return { did } as never;
        },
        revoke: async () => undefined,
      }),
    });

    await expect(auth.restoreOwner()).resolves.toMatchObject({ did: ownerDid });
    expect(restored).toEqual([ownerDid]);
  });
});
