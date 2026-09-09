import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/site",
  testMatch: "**/*.spec.ts",
  use: {
    baseURL: process.env.FADS_SITE_URL ?? "http://127.0.0.1:4399",
    ...devices["Desktop Chrome"],
  },
  webServer: process.env.FADS_SITE_URL
    ? undefined
    : {
        command: "npx wrangler dev --config wrangler.site.jsonc --port 4399 --ip 127.0.0.1",
        url: "http://127.0.0.1:4399",
        reuseExistingServer: false,
      },
});
