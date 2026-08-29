import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const observedAt = "2026-08-28T14:00:00.000Z";
const provenance = { source: "rss:field-notes", observedAt, reference: "https://example.com/post" };

const activeEdition = {
  edition: {
    id: "edition-1",
    ownerId: "did:plc:owner",
    createdAt: observedAt,
    curiosity: 68,
    energy: 44,
    items: [
      {
        id: "frame-1",
        contentId: "post-1",
        frame: "A close match with one deliberate detour.",
        position: 0,
        decisionTrace: {
          factors: [
            { factor: "Manual interest · urban ecology", weight: 0.72, provenance },
            { factor: "Curiosity detour", weight: 0.21, provenance },
          ],
          generatedAt: observedAt,
        },
      },
      {
        id: "frame-2",
        contentId: "post-2",
        frame: "A lighter finish from a trusted source.",
        position: 1,
        decisionTrace: {
          factors: [{ factor: "Energy fit", weight: 0.61, provenance }],
          generatedAt: observedAt,
        },
      },
    ],
    decisionTrace: { factors: [], generatedAt: observedAt },
  },
  position: 0,
  completed: false,
  content: [
    {
      id: "post-1",
      canonicalUri: "https://example.com/post",
      sourceId: "Field Notes",
      publishedAt: observedAt,
      capturedAt: observedAt,
      blocks: [
        { kind: "heading", text: "The city is a garden", level: 1 },
        {
          kind: "paragraph",
          text: "<script>window.__unsafe = true</script>Look between the paving stones.",
        },
        { kind: "link", href: "https://example.com/post", text: "Read the original field note" },
      ],
      media: [
        {
          id: "image-1",
          kind: "image",
          url: "https://example.com/garden.jpg",
          alt: "Plants growing between paving stones",
          provenance,
        },
        {
          id: "audio-1",
          kind: "audio",
          url: "https://example.com/field-note.mp3",
          alt: "Audio field note",
          provenance,
        },
      ],
      tags: [],
      labels: [],
    },
    {
      id: "post-2",
      canonicalUri: "https://example.com/second",
      sourceId: "The Margins",
      publishedAt: observedAt,
      capturedAt: observedAt,
      blocks: [
        { kind: "heading", text: "An atlas of small attention", level: 1 },
        { kind: "paragraph", text: "A short ending, chosen on purpose." },
      ],
      media: [],
      tags: [],
      labels: [],
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({ json: { authenticated: true, did: "did:plc:owner" } }),
  );
  await page.route("**/api/v1/editions/active", (route) => route.fulfill({ json: activeEdition }));
  await page.route("**/api/v1/editions/edition-1/progress", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/v1/editions/edition-1/complete", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/v1/interactions", (route) => route.fulfill({ json: { ok: true } }));
});

test("reads exactly one safe item at a time and ends deliberately", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "The city is a garden" })).toBeVisible();
  await expect(page.getByText("1 of 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Manual interest · urban ecology")).toBeVisible();
  await expect(page.locator("main script")).toHaveCount(0);
  await expect(page.getByText("<script>window.__unsafe = true</script>")).toBeVisible();
  await expect(page.getByAltText("Plants growing between paving stones")).toBeVisible();
  await expect(page.getByLabel("Audio field note")).not.toHaveAttribute("autoplay", "");

  const original = page.getByRole("link", { name: "Read the original field note" });
  await expect(original).toHaveAttribute("target", "_blank");
  await expect(original).toHaveAttribute("rel", "noopener noreferrer");

  for (const label of [
    "More like this",
    "Less like this",
    "Good surprise",
    "Not now",
    "Mute source",
    "Keep",
  ]) {
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  }

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole("button", { name: "Next item" }).click();
  await expect(page.getByRole("heading", { name: "An atlas of small attention" })).toBeVisible();
  await page.getByRole("button", { name: "Finish edition" }).click();

  await expect(page.getByRole("heading", { name: "That’s the edition." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep reading" })).toHaveCount(0);
});

test("resumes the validated active edition when the private API is offline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The city is a garden" })).toBeVisible();

  await page.evaluate(async (value) => {
    const cache = await caches.open("fads-edition-v1");
    await cache.put(
      "/api/v1/editions/active",
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }),
    );
    localStorage.setItem("fads-test-offline", "true");
  }, activeEdition);
  await page.addInitScript(() => {
    if (localStorage.getItem("fads-test-offline") !== "true") return;
    const onlineFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.origin);
      return url.pathname.startsWith("/api/")
        ? Promise.reject(new TypeError("offline"))
        : onlineFetch(input, init);
    };
  });

  await page.reload();

  await expect(page.getByRole("heading", { name: "The city is a garden" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Offline edition resumed");
});

test("keeps mobile reading controls reachable without hiding the trace", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Why this item?" })).toBeVisible();
  const controls = page.getByLabel("Edition controls");
  await expect(controls).toBeVisible();
  const box = await controls.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(48);
});
