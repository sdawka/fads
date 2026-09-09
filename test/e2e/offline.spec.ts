import { expect, test } from "@playwright/test";

test.describe("offline shell", () => {
  test("serves an explicit offline fallback page", async ({ page }) => {
    await page.goto("/offline");
    await expect(page.getByRole("heading", { name: /reading surface is offline/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /try again/i })).toHaveAttribute("href", "/");
  });

  test("publishes a versioned service worker and installable manifest", async ({ request }) => {
    const worker = await request.get("/sw.js");
    expect(worker.ok()).toBe(true);
    expect(await worker.text()).toContain('const VERSION = "v1"');

    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBe(true);
    const body = await manifest.json();
    expect(body.scope).toBe("/");
    expect(body.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icons/icon-192.svg" }),
        expect.objectContaining({ src: "/icons/icon-512.svg" }),
      ]),
    );
  });
});
