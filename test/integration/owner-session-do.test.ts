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
});
