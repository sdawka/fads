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
    await stub.putOAuthState({
      key: "state-1",
      value: { pkceVerifier: "verifier", expiresAt: Date.now() + 60_000 },
    });

    await expect(stub.getOAuthState({ key: "state-1" })).resolves.toEqual({
      pkceVerifier: "verifier",
      expiresAt: expect.any(Number),
    });
    await expect(stub.getOAuthState({ key: "state-1" })).resolves.toBeUndefined();
  });

  it("purges expired OAuth state and retains only a bounded set", async () => {
    const appEnv = env as unknown as AppEnv;
    const stub = appEnv.OWNER_SESSION.getByName("owner-bounded-state");
    const now = Date.now();
    await stub.putOAuthState({ key: "expired", value: { expiresAt: now - 1 } });
    for (let index = 0; index < 12; index += 1) {
      await stub.putOAuthState({
        key: `state-${index}`,
        value: { expiresAt: now + 60_000 + index },
      });
    }

    const states = await runInDurableObject(stub, (_instance, state) =>
      Array.from(
        state.storage.sql.exec<{ key: string }>("SELECT key FROM oauth_states ORDER BY key"),
      ),
    );

    expect(states).toHaveLength(8);
    expect(states.map((row) => row.key)).not.toContain("expired");
  });

  it("rate-limits OAuth starts within a rolling window", async () => {
    const appEnv = env as unknown as AppEnv;
    const stub = appEnv.OWNER_SESSION.getByName("owner-oauth-rate");

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(stub.tryStartOAuth({ now: 1_000 })).resolves.toBe(true);
    }
    await expect(stub.tryStartOAuth({ now: 1_000 })).resolves.toBe(false);
    await expect(stub.tryStartOAuth({ now: 61_001 })).resolves.toBe(true);
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

    await expect(
      stub.readAppSession({ tokenHash: "sha256-token-only", now: 2 }),
    ).resolves.toBeUndefined();
    const row = await runInDurableObject(stub, (instance, state) => {
      return state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM app_sessions")
        .one();
    });
    expect(row.count).toBe(0);
  });

  it("can revoke every app session for the single owner", async () => {
    const appEnv = env as unknown as AppEnv;
    const stub = appEnv.OWNER_SESSION.getByName("owner-all-sessions");
    for (const tokenHash of ["first", "second"]) {
      await stub.createAppSession({
        tokenHash,
        did: "did:plc:owner123",
        idleExpiresAt: Date.now() + 60_000,
        absoluteExpiresAt: Date.now() + 60_000,
      });
    }

    await stub.deleteAllAppSessions();

    const count = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM app_sessions").one(),
    );
    expect(count.count).toBe(0);
  });

  it("retains and renews a refresh lease beyond thirty seconds", async () => {
    const appEnv = env as unknown as AppEnv;
    const stub = appEnv.OWNER_SESSION.getByName("owner-refresh");

    await expect(
      stub.tryAcquireRefreshLock({ name: "oauth-session-owner", holder: "first", now: 0 }),
    ).resolves.toBe(true);
    await expect(
      stub.tryAcquireRefreshLock({ name: "oauth-session-owner", holder: "second", now: 30_001 }),
    ).resolves.toBe(false);
    await expect(
      stub.renewRefreshLock({ name: "oauth-session-owner", holder: "first", now: 240_000 }),
    ).resolves.toBe(true);
    await expect(
      stub.tryAcquireRefreshLock({ name: "oauth-session-owner", holder: "second", now: 300_001 }),
    ).resolves.toBe(false);
  });
});
