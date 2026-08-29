import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/app-env";
import { OwnerSessionDO } from "../../src/owner-session-do";

describe("OwnerSessionDO", () => {
  it("persists a session event in its SQLite-backed storage", async () => {
    const appEnv = env as unknown as AppEnv;
    const stub = appEnv.OWNER_SESSION.getByName("owner-1");
    await expect(stub.record("opened")).resolves.toBeUndefined();
    const event = await runInDurableObject(stub, (instance, state) => {
      return state.storage.sql.exec<{ event: string }>("SELECT event FROM session_events").one()
        .event;
    });

    expect(event).toBe("opened");
  });

  it("consumes an OAuth callback state exactly once", async () => {
    const appEnv = env as unknown as AppEnv;
    const stub = appEnv.OWNER_SESSION.getByName("owner");
    await stub.putOAuthState({ key: "state-1", value: { pkceVerifier: "verifier", expiresAt: Date.now() + 60_000 } });

    await expect(stub.getOAuthState({ key: "state-1" })).resolves.toEqual({
      pkceVerifier: "verifier",
      expiresAt: expect.any(Number),
    });
    await expect(stub.getOAuthState({ key: "state-1" })).resolves.toBeUndefined();
  });

  it("drops expired hashed app sessions without exposing a bearer token", async () => {
    const appEnv = env as unknown as AppEnv;
    const stub = appEnv.OWNER_SESSION.getByName("owner");
    await stub.createAppSession({
      tokenHash: "sha256-token-only",
      did: "did:plc:owner123",
      idleExpiresAt: 1,
      absoluteExpiresAt: 2,
    });

    await expect(stub.readAppSession({ tokenHash: "sha256-token-only", now: 2 })).resolves.toBeUndefined();
    const row = await runInDurableObject(stub, (instance, state) => {
      return state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM app_sessions").one();
    });
    expect(row.count).toBe(0);
  });
});
