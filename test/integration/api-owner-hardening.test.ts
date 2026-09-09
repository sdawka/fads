import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createOwnerApiHandler } from "../../src/modules/api";
import { D1OwnerDataRepository } from "../../src/modules/storage";

const OWNER = "did:plc:api-owner";
const AT = "2026-08-28T12:00:00.000Z";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM api_idempotency WHERE owner_id = ?").bind(OWNER),
    env.DB.prepare("DELETE FROM sources WHERE owner_id = ?").bind(OWNER),
  ]);
});

describe("owner API with D1", () => {
  function handler(repository: D1OwnerDataRepository) {
    return createOwnerApiHandler({
      ownerDid: OWNER,
      authenticate: async () => ({ did: OWNER, expiresAt: "2026-09-04T12:00:00.000Z" }),
      logout: async () => new Response(null, { status: 204 }),
      withMutation: (operation) => operation(),
      repository,
      editions: {
        create: async () => ({ selected: [] }),
        resume: async () => undefined,
        setPosition: async () => undefined,
        complete: async () => undefined,
      },
      now: () => AT,
    });
  }

  it("runs exactly one domain mutation for concurrent idempotent requests", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    const handle = handler(repository);
    const request = () =>
      new Request("https://fads.cc/api/v1/sources", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "same-source" },
        body: JSON.stringify({
          adapter: "rss",
          displayName: "One",
          url: "https://example.com/feed.xml",
        }),
      });

    const concurrent = await Promise.all([handle(request()), handle(request())]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 425]);
    expect(await repository.listSources(OWNER)).toHaveLength(1);

    const replay = await handle(request());
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(await repository.listSources(OWNER)).toHaveLength(1);
  });

  it("completes and replays the idempotency claim for a full reset", async () => {
    const repository = new D1OwnerDataRepository(env.DB);
    const handle = handler(repository);
    const request = () =>
      new Request("https://fads.cc/api/v1/reset", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "full-reset" },
        body: JSON.stringify({ full: true, confirmation: "DELETE ALL PRIVATE DATA" }),
      });

    const response = await handle(request());
    expect(response.status).toBe(204);
    const replay = await handle(request());
    expect(replay.status).toBe(204);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
  });
});
