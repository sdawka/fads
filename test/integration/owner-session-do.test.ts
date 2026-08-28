import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OwnerSessionDO } from "../../src/owner-session-do";

describe("OwnerSessionDO", () => {
  it("persists a session event in its SQLite-backed storage", async () => {
    const stub = env.OWNER_SESSION.getByName("owner-1");
    const event = await runInDurableObject(stub, (instance, state) => {
      (instance as OwnerSessionDO).record("opened");
      return state.storage.sql.exec<{ event: string }>("SELECT event FROM session_events").one()
        .event;
    });

    expect(event).toBe("opened");
  });
});
