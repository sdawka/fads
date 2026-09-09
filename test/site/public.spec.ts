import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("demo changes layout without replacing content, then ends deliberately", async ({ page }) => {
  const privateRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/|\/oauth\/|\/sw\.js/.test(request.url())) privateRequests.push(request.url());
  });
  await page.goto("/");
  const reader = page.getByRole("region", { name: "Edition reader" });
  const original = await reader.locator("#article-title").innerText();
  await page.getByRole("button", { name: "Allow a detour", exact: true }).click();
  await expect(reader.locator("#article-title")).toHaveText(original);
  await reader.getByRole("button", { name: "List", exact: true }).click();
  await expect(reader.getByRole("list", { name: /edition items/ })).toBeVisible();
  await reader.getByRole("button", { name: "Grid", exact: true }).click();
  await reader.getByRole("button", { name: "Focus", exact: true }).click();
  await expect(reader.locator("#article-title")).toHaveText(original);
  await page.getByRole("button", { name: "Make this edition", exact: true }).click();
  await expect(reader.locator("#article-title")).not.toHaveText(original);
  await reader.getByRole("button", { name: "Next item", exact: true }).click();
  await reader.getByRole("button", { name: "Next item", exact: true }).click();
  await reader.getByRole("button", { name: "Finish edition", exact: true }).click();
  await expect(reader.getByRole("heading", { name: "That’s the edition." })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Next item", exact: true })).toHaveCount(0);
  expect(privateRequests).toEqual([]);
});

test("layout preference restores after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  const items = page.getByRole("list", { name: /edition items/ });
  await items.getByRole("button").first().click();
  await expect(page.getByRole("button", { name: "Back to grid", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Grid", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await items.getByRole("button").first().click();
  await page.getByRole("button", { name: "Back to grid", exact: true }).click();
  await expect(page.getByRole("button", { name: "Grid", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("landing and installation remain readable on narrow screens", async ({ page }) => {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/install/"]) {
      await page.goto(path);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  }
});

test("landing and demo have no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("static deployment applies security headers to both public pages", async ({ request }) => {
  for (const path of ["/", "/install/"]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  }
});

test("demo waits for hydration before accepting its first click", async ({ page }) => {
  let releaseScript: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseScript = resolve;
  });
  await page.route("**/_astro/Demo.*.js", async (route) => {
    await blocked;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#demo")).toHaveAttribute("inert", "");
  await expect(page.locator("#demo")).toHaveAttribute("aria-busy", "true");
  releaseScript?.();
  await expect(page.locator("#demo")).not.toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(page.getByRole("list", { name: /edition items/ })).toBeVisible();
});
