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
        "interactions",
        "keeps",
        "idempotency_keys",
      ]),
    );
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
