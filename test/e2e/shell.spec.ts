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

test("isolates hostile concept-deck messages from app-origin storage", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("app-origin-secret", "do-not-leak");
    document.cookie = "app-origin-secret=do-not-leak; path=/";
    window.addEventListener("message", (event) => {
      if (event.data?.kind === "concept-probe") {
        (window as typeof window & { conceptProbe?: unknown }).conceptProbe = event.data;
      }
    });
  });

  const conceptPagePromise = context.waitForEvent("page");
  await page.evaluate(() => window.open("/concept/", "concept-probe"));
  const conceptPage = await conceptPagePromise;
  await conceptPage.waitForLoadState();
  const response = await conceptPage.reload();

  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("sandbox");
  expect(policy).not.toContain("allow-same-origin");

  await page.evaluate(() => {
    const conceptWindow = window.open("", "concept-probe");
    conceptWindow?.postMessage(
      {
        type: "od:srcdoc-transport-activate",
        html: `<script>try { window.opener.postMessage({ kind: 'concept-probe', storage: localStorage.getItem('app-origin-secret'), cookie: document.cookie }, '*'); } catch { window.opener.postMessage({ kind: 'concept-probe', storage: 'blocked', cookie: 'blocked' }, '*'); }</script>`,
      },
      "*",
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { conceptProbe?: unknown }).conceptProbe),
    )
    .toEqual({ kind: "concept-probe", storage: "blocked", cookie: "blocked" });
});
