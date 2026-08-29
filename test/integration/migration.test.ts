import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("initial D1 migration", () => {
  it("creates the content, preference, edition, interaction, and idempotency tables", async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
      name: string;
    }>();
    const names = tables.results.map((table) => table.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "sources",
        "sync_cursors",
        "content_items",
        "content_tags",
        "content_labels",
        "manual_interests",
        "source_preferences",
        "learned_adjustments",
        "editions",
        "edition_items",
        "edition_decisions",
        "interactions",
        "keeps",
        "idempotency_keys",
      ]),
    );
  });

  it("persists owner-scoped edition settings, lifecycle, and decision traces", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(editions)").all<{
      name: string;
      pk: number;
    }>();
    const byName = new Map(columns.results.map((column) => [column.name, column]));

    expect([...byName.keys()]).toEqual(
      expect.arrayContaining(["owner_id", "id", "curiosity", "energy", "position", "completed"]),
    );
    expect(byName.get("owner_id")?.pk).toBeGreaterThan(0);
    expect(byName.get("id")?.pk).toBeGreaterThan(0);

    await env.DB.prepare(
      "INSERT INTO editions (owner_id, id, requested_at, curiosity, energy, trace_json, position, completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("owner-a", "same-edition", "2026-08-28T12:00:00.000Z", 80, 20, "{}", 0, 0, "2026-08-28T12:00:00.000Z")
      .run();
    await env.DB.prepare(
      "INSERT INTO editions (owner_id, id, requested_at, curiosity, energy, trace_json, position, completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("owner-b", "same-edition", "2026-08-28T12:00:00.000Z", 10, 90, "{}", 0, 0, "2026-08-28T12:00:00.000Z")
      .run();

    const owners = await env.DB.prepare(
      "SELECT owner_id FROM editions WHERE id = ? ORDER BY owner_id",
    )
      .bind("same-edition")
      .all<{ owner_id: string }>();
    expect(owners.results).toEqual([{ owner_id: "owner-a" }, { owner_id: "owner-b" }]);
  });

  it("enforces source references and adds the required lookup indexes", async () => {
    const foreignKeys = await env.DB.prepare("PRAGMA foreign_key_list(content_items)").all<{
      table: string;
    }>();
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all<{ name: string }>();

    expect(foreignKeys.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: "sources" })]),
    );
    expect(indexes.results.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_content_items_canonical_uri",
        "idx_content_items_source_published_at",
        "idx_edition_items_edition_position",
        "idx_interactions_occurred_at",
        "idx_idempotency_keys_expires_at",
      ]),
    );
  });
});
