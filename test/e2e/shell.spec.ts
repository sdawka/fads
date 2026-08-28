import { expect, test } from "@playwright/test";

test("serves the accessible reading shell and the preserved concept deck", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "A quieter place to follow your curiosity." }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Open the original concept deck/ })).toHaveAttribute(
    "href",
    "/concept/",
  );

  await page.goto("/concept/");
  await expect(page).toHaveTitle("f.ads — show me what's cool");
});
