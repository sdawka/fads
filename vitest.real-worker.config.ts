import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./dist/server/entry.mjs",
      wrangler: { configPath: "./dist/server/wrangler.json" },
      additionalExports: { OwnerSessionDO: "DurableObject" },
    }),
  ],
  test: {
    include: ["test/real-worker/**/*.test.ts"],
  },
});
