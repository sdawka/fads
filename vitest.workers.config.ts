import { cloudflareTest } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";

async function readMigrations(migrationsDir: string) {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (name) => ({
      name,
      queries: (await readFile(path.join(migrationsDir, name), "utf8"))
        .split(/;\s*(?:\r?\n|$)/)
        .map((query) => query.trim())
        .filter(Boolean),
    })),
  );
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      additionalExports: { OwnerSessionDO: "DurableObject" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readMigrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
  },
});
