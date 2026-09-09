import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: "http://127.0.0.1:4475",
    ...devices["Desktop Chrome"],
    // Service-worker behavior has an executable unit harness; browser UI tests mock the private API.
    serviceWorkers: "block",
  },
  webServer: {
    command: "ASTRO_DEV_BACKGROUND=0 npm run dev -- --ignore-lock --host 127.0.0.1 --port 4475",
    url: "http://127.0.0.1:4475",
    reuseExistingServer: false,
  },
});
