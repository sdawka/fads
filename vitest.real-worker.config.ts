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
      main: "./dist/server/entry.mjs",
      wrangler: { configPath: "./dist/server/wrangler.json" },
      additionalExports: { OwnerSessionDO: "DurableObject" },
      miniflare: {
        bindings: {
          OWNER_DID: "did:plc:testowner123",
          APP_ORIGIN: "https://fads.test",
          ATPROTO_OAUTH_PRIVATE_JWKS:
            '[{"kty":"EC","kid":"test-key","alg":"ES256","crv":"P-256","x":"test-x","y":"test-y","d":"test-d"}]',
          SAFETY_LABELS_JSON: "[]",
          TEST_MIGRATIONS: await readMigrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["test/real-worker/**/*.test.ts"],
  },
});
