import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("storage hardening migration", () => {
  it("supports idempotency claims and persisted queue outcomes", async () => {
    const idempotencyColumns = await env.DB.prepare("PRAGMA table_info(api_idempotency)").all<{
      name: string;
    }>();
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();

    expect(idempotencyColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["state", "claim_token", "claimed_at", "completed_at"]),
    );
    expect(tables.results.map((table) => table.name)).toContain("source_sync_work");
  });
});
