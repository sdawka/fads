import { expect, test, type Page } from "@playwright/test";

const observedAt = "2026-09-08T12:00:00.000Z";
const activeEdition = {
  edition: {
    id: "edition-expiry",
    ownerId: "did:plc:owner",
    createdAt: observedAt,
    curiosity: 50,
    energy: 50,
    items: [
      {
        id: "item-1",
        contentId: "content-1",
        frame: "A finite read.",
        position: 0,
        decisionTrace: { factors: [], generatedAt: observedAt },
      },
    ],
    decisionTrace: { factors: [], generatedAt: observedAt },
  },
  content: [
    {
      id: "content-1",
      canonicalUri: "https://example.com/finite",
      sourceId: "rss:source-1",
      publishedAt: observedAt,
      capturedAt: observedAt,
      blocks: [{ kind: "heading", text: "A finite offline session", level: 1 }],
      media: [],
      tags: [],
      labels: [],
    },
  ],
  position: 0,
  completed: false,
};

async function routeReader(page: Page, expiresAt: string) {
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({ json: { authenticated: true, did: "did:plc:owner", expiresAt } }),
  );
  await page.route("**/api/v1/editions/active", (route) => route.fulfill({ json: activeEdition }));
  await page.route("**/api/v1/sources", (route) => route.fulfill({ json: { sources: [] } }));
  await page.route("**/api/v1/keeps", (route) =>
    route.fulfill({ json: { keeps: [], content: [] } }),
  );
}

test("removes an already visible edition at the absolute session expiry", async ({ page }) => {
  await routeReader(page, new Date(Date.now() + 1_500).toISOString());

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A finite offline session" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A quieter place to follow your curiosity." }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("alert")).toContainText("Your session expired.");
});

test("removes an already visible edition after a confirmed API 401", async ({ page }) => {
  await routeReader(page, new Date(Date.now() + 60_000).toISOString());
  await page.route("**/api/v1/editions/edition-expiry/complete", (route) =>
    route.fulfill({ status: 401 }),
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A finite offline session" })).toBeVisible();
  await page.getByRole("button", { name: "Finish edition" }).click();

  await expect(
    page.getByRole("heading", { name: "A quieter place to follow your curiosity." }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Your session expired.");
});

test("does not restore a late private load after the session expires", async ({ page }) => {
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        did: "did:plc:owner",
        expiresAt: new Date(Date.now() + 500).toISOString(),
      },
    }),
  );
  await page.route("**/api/v1/editions/active", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.fulfill({ json: activeEdition });
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "A quieter place to follow your curiosity." }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("heading", { name: "A finite offline session" })).toHaveCount(0);
});
