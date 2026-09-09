import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const sessionExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
const observedAt = "2026-08-28T14:00:00.000Z";
const provenance = { source: "rss:field-notes", observedAt, reference: "https://example.com/post" };
const fieldNotesSource = {
  id: "rss:field-notes",
  ownerId: "did:plc:owner",
  adapter: "rss",
  displayName: "Field Notes",
  url: "https://example.com/feed.xml",
  config: {},
  status: "ready",
  createdAt: observedAt,
  updatedAt: observedAt,
};

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
            { factor: "interest:urban ecology", weight: 0.72, provenance },
            { factor: "exploration", weight: 0.21, provenance },
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
          factors: [{ factor: "energy-fit", weight: 0.61, provenance }],
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
      sourceId: fieldNotesSource.id,
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
      sourceId: "rss:the-margins",
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
    route.fulfill({
      json: { authenticated: true, did: "did:plc:owner", expiresAt: sessionExpiresAt },
    }),
  );
  await page.route("**/api/v1/editions/active", (route) => route.fulfill({ json: activeEdition }));
  await page.route("**/api/v1/sources", (route) =>
    route.fulfill({ json: { sources: [fieldNotesSource] } }),
  );
  await page.route("**/api/v1/editions/edition-1/progress", (route) =>
    route.fulfill({
      json: {
        progress: {
          editionId: "edition-1",
          ownerId: "did:plc:owner",
          position: 1,
          completed: false,
        },
      },
    }),
  );
  await page.route("**/api/v1/editions/edition-1/complete", (route) =>
    route.fulfill({
      json: {
        progress: {
          editionId: "edition-1",
          ownerId: "did:plc:owner",
          position: 1,
          completed: true,
        },
      },
    }),
  );
  await page.route("**/api/v1/keeps", (route) =>
    route.fulfill({
      json: {
        keeps: [
          {
            ownerId: "did:plc:owner",
            contentId: "post-1",
            keptAt: observedAt,
          },
        ],
        content: [activeEdition.content[0]],
      },
    }),
  );
  await page.route("**/api/v1/interactions", (route) => {
    const body = route.request().postDataJSON() as {
      contentId: string;
      sourceId: string;
      kind: string;
    };
    return route.fulfill({
      status: 201,
      json: {
        interaction: {
          id: "interaction-1",
          ownerId: "did:plc:owner",
          contentId: body.contentId,
          sourceId: body.sourceId,
          kind: body.kind,
          occurredAt: observedAt,
          provenance,
        },
      },
    });
  });
});

test("reads exactly one safe item at a time and ends deliberately", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "The city is a garden" })).toBeVisible();
  await expect(page.getByText("1 of 2", { exact: true })).toBeVisible();
  await page.getByText("Why this item?", { exact: true }).click();
  await expect(page.getByText("Matches your interest in urban ecology.")).toBeVisible();
  await expect(page.locator("main script")).toHaveCount(0);
  await expect(page.getByText("<script>window.__unsafe = true</script>")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open image: Plants growing between paving stones" }),
  ).toHaveAttribute("href", "https://example.com/garden.jpg");
  await expect(page.getByRole("link", { name: "Open audio: Audio field note" })).toHaveAttribute(
    "href",
    "https://example.com/field-note.mp3",
  );
  await expect(page.locator("img, audio, video")).toHaveCount(0);
  await expect(page.getByRole("article").getByText("Field Notes", { exact: true })).toBeVisible();
  await expect(page.getByText("rss:field-notes", { exact: true })).toHaveCount(0);

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
  const keep = page.getByRole("button", { name: "Keep" });
  await expect(keep).toHaveAttribute("aria-pressed", "true");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole("button", { name: "Next item" }).click();
  await expect(page.getByRole("heading", { name: "An atlas of small attention" })).toBeVisible();
  await page.getByRole("button", { name: "Finish edition" }).click();

  await expect(page.getByRole("heading", { name: "That’s the edition." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep reading" })).toHaveCount(0);
});

test("returns from an edition overview to the selected item without changing its order", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("button", { name: "The city is a garden" })).toBeVisible();
  await expect(page.getByRole("button", { name: "An atlas of small attention" })).toBeVisible();

  await page.getByRole("button", { name: "An atlas of small attention" }).click();
  await expect(page.getByRole("heading", { name: "An atlas of small attention" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to list" })).toBeVisible();
  await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();
});

test("shows a completed edition as a terminal reader state", async ({ page }) => {
  await page.route("**/api/v1/editions/active", (route) =>
    route.fulfill({ json: { ...activeEdition, completed: true } }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "That’s the edition." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next item" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finish edition" })).toHaveCount(0);
});

test("requires confirmation before removing a source", async ({ page }) => {
  let deleteCount = 0;
  await page.route("**/api/v1/preferences", (route) =>
    route.fulfill({ json: { preferences: { blockedLabels: [], mutedSourceIds: [] } } }),
  );
  await page.route("**/api/v1/sources/rss%3Afield-notes", async (route) => {
    deleteCount += 1;
    await route.fulfill({ status: 204 });
  });
  await page.goto("/sources/");
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("dialog", { name: "Remove Field Notes?" })).toBeVisible();
  expect(deleteCount).toBe(0);
  await page.getByRole("button", { name: "Remove source" }).click();
  await expect.poll(() => deleteCount).toBe(1);
});

test("explains learned preferences in plain language", async ({ page }) => {
  await page.route("**/api/v1/interests", (route) => route.fulfill({ json: { interests: [] } }));
  await page.route("**/api/v1/suggestions", (route) =>
    route.fulfill({ json: { suggestions: [] } }),
  );
  await page.route("**/api/v1/profile/learned", (route) =>
    route.fulfill({
      json: { learnedAdjustments: { "source:rss:field-notes": 0.6, "tag:ecology": -0.2 } },
    }),
  );

  await page.goto("/garden/");

  await expect(page.getByText("Field Notes has been showing up more often.")).toBeVisible();
  await expect(page.getByText("Ecology has been showing up less often.")).toBeVisible();
  await expect(page.getByText("0.6", { exact: true })).toHaveCount(0);
});

test("resumes the validated active edition when the private API is offline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The city is a garden" })).toBeVisible();

  await page.evaluate(async (value) => {
    const cache = await caches.open("fads-edition-v2");
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
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href, location.origin);
      return url.pathname.startsWith("/api/")
        ? Promise.reject(new TypeError("offline"))
        : onlineFetch(input, init);
    };
  });

  await page.reload();

  await expect(page.getByRole("heading", { name: "The city is a garden" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Offline edition resumed");
});

test("shows safe hydrated previews instead of opaque keep identifiers", async ({ page }) => {
  await page.route("**/api/v1/sources", (route) => route.fulfill({ json: { sources: [] } }));
  await page.goto("/keeps/");

  await expect(page.getByRole("heading", { name: "The city is a garden" })).toBeVisible();
  await expect(page.locator(".keep-list > li > div > p")).toContainText(
    "Look between the paving stones",
  );
  await expect(page.getByText("post-1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("example.com", { exact: true })).toBeVisible();
  const original = page.getByRole("link", { name: "Read the original field note" });
  await expect(original).not.toBeVisible();
  await page.getByText("Read saved item", { exact: true }).click();
  await expect(original).toBeVisible();
  await expect(page.locator("img, audio, video")).toHaveCount(0);
});

test("distinguishes a management load error from an empty collection", async ({ page }) => {
  await page.route("**/api/v1/keeps", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );

  await page.goto("/keeps/");

  await expect(page.getByRole("alert")).toContainText("Keeps could not be loaded");
  await expect(page.getByText("Nothing kept yet.")).toHaveCount(0);
});

test("adds the owner's ATProto home feed and queues its first refresh", async ({ page }) => {
  const atprotoSource = {
    ...fieldNotesSource,
    id: "atproto:home",
    adapter: "atproto",
    displayName: "ATProto home feed",
    url: undefined,
    status: "queued",
  };
  let createBody: unknown;
  let refreshRequested = false;
  await page.route("**/api/v1/preferences", (route) =>
    route.fulfill({ json: { preferences: { blockedLabels: [], mutedSourceIds: [] } } }),
  );
  await page.route("**/api/v1/sources", async (route) => {
    if (route.request().method() === "POST") {
      createBody = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { source: { ...atprotoSource, status: "idle" } } });
      return;
    }
    await route.fulfill({ json: { sources: [] } });
  });
  await page.route("**/api/v1/sources/atproto%3Ahome/refresh", async (route) => {
    refreshRequested = true;
    await route.fulfill({ status: 202, json: { source: atprotoSource } });
  });

  await page.goto("/sources/");
  await expect(page.getByText(/No sources yet/)).toBeVisible();
  await page.getByRole("button", { name: "Add ATProto home feed" }).click();

  await expect
    .poll(() => createBody)
    .toEqual({
      adapter: "atproto",
      displayName: "ATProto home feed",
      config: {},
    });
  await expect.poll(() => refreshRequested).toBe(true);
  await expect(page.getByText("Source refresh queued.")).toBeVisible();
  await expect(page.getByText("ATProto home feed", { exact: true })).toBeVisible();
});

test("requires an explicit accessible confirmation before a full reset", async ({ page }) => {
  let resetBody: unknown;
  await page.route("**/api/v1/preferences", (route) =>
    route.fulfill({ json: { preferences: { blockedLabels: [], mutedSourceIds: [] } } }),
  );
  await page.route("**/api/v1/reset", async (route) => {
    resetBody = route.request().postDataJSON();
    await route.fulfill({ status: 204 });
  });

  await page.goto("/settings/");
  await page.getByRole("button", { name: "Full reset…" }).click();

  const dialog = page.getByRole("dialog", { name: "Erase all private data?" });
  await expect(dialog).toBeVisible();
  expect(resetBody).toBeUndefined();
  await expect(dialog.getByRole("button", { name: "Erase everything" })).toBeFocused();

  await dialog.getByRole("button", { name: "Erase everything" }).click();
  await expect
    .poll(() => resetBody)
    .toEqual({
      full: true,
      confirmation: "DELETE ALL PRIVATE DATA",
    });
});

test("edits the owner's exact blocked labels instead of fixed categories", async ({ page }) => {
  const saved: Array<{ blockedLabels: string[]; mutedSourceIds: string[] }> = [];
  await page.route("**/api/v1/preferences", async (route) => {
    if (route.request().method() === "PUT") {
      const preferences = route.request().postDataJSON() as {
        blockedLabels: string[];
        mutedSourceIds: string[];
      };
      saved.push(preferences);
      await route.fulfill({ json: { preferences } });
      return;
    }
    await route.fulfill({
      json: { preferences: { blockedLabels: ["porn", "graphic-media"], mutedSourceIds: [] } },
    });
  });

  await page.goto("/settings/");
  await expect(page.getByText("porn", { exact: true })).toBeVisible();
  await expect(page.getByText("graphic-media", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Allow graphic-media" }).click();
  await page.getByLabel("Label to block").fill("political");
  await page.getByRole("button", { name: "Block label" }).click();

  await expect
    .poll(() => saved)
    .toEqual([
      { blockedLabels: ["porn"], mutedSourceIds: [] },
      { blockedLabels: ["porn", "political"], mutedSourceIds: [] },
    ]);
});

test("withholds allowance writes when authoritative settings fail to load", async ({ page }) => {
  await page.route("**/api/v1/preferences", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );

  await page.goto("/settings/");

  await expect(page.getByRole("alert")).toContainText("Settings could not be loaded");
  await expect(page.getByLabel("Label to block")).toHaveCount(0);
});

test("clears private offline state when remote logout cannot be confirmed", async ({ page }) => {
  let releaseLogout: (() => void) | undefined;
  await page.route("**/api/v1/preferences", (route) =>
    route.fulfill({ json: { preferences: { blockedLabels: [], mutedSourceIds: [] } } }),
  );
  await page.route("**/api/v1/logout", async (route) => {
    await new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });
    await route.abort("failed");
  });
  await page.goto("/settings/");
  await page.evaluate(async () => {
    const cache = await caches.open("fads-edition-v2");
    await cache.put(
      "/api/v1/editions/active",
      new Response(JSON.stringify({ private: true }), {
        headers: { "content-type": "application/json" },
      }),
    );
  });

  await page.getByRole("button", { name: "Sign out" }).click();

  await expect.poll(() => Boolean(releaseLogout)).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        Boolean(await (await caches.open("fads-edition-v2")).match("/api/v1/editions/active")),
      ),
    )
    .toBe(false);
  releaseLogout?.();
  await expect(
    page.getByRole("heading", { name: "A quieter place to follow your curiosity." }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Private offline data was cleared, but server sign-out could not be confirmed",
  );
});

test("lets the owner retry a failed offline change so later changes can continue", async ({
  page,
}) => {
  let replayed = false;
  await page.route("**/api/v1/preferences", (route) =>
    route.fulfill({ json: { preferences: { blockedLabels: [], mutedSourceIds: [] } } }),
  );
  await page.route("**/api/v1/interactions", async (route) => {
    replayed = true;
    await route.fulfill({ status: 204 });
  });
  await page.goto("/settings/");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText(/Offline cache/)).toBeVisible();
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("fads-offline-v1", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("outbox", "readwrite");
      transaction.objectStore("outbox").put({
        id: "failed-1",
        kind: "feedback",
        url: `${location.origin}/api/v1/interactions`,
        method: "POST",
        body: JSON.stringify({
          editionId: "edition-1",
          contentId: "content-1",
          sourceId: "rss:source-1",
          kind: "more_like_this",
        }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": "failed-1" },
        idempotencyKey: "failed-1",
        requestHash: "POST\n/api/v1/interactions\nfailed-1",
        createdAt: 1,
        sequence: 1,
        attempts: 1,
        state: "failed",
        lastError: "Server rejected mutation (422).",
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();

  await page.getByRole("button", { name: "Retry failed changes" }).click();

  await expect.poll(() => replayed).toBe(true);
  await expect(page.getByText(/offline change.*needs attention/)).toHaveCount(0);
});

test("keeps mobile reading controls reachable without hiding the trace", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByText("Why this item?", { exact: true })).toBeVisible();
  const controls = page.getByLabel("Edition controls");
  await expect(controls).toBeVisible();
  const box = await controls.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(48);
});

test("loads media only on request and offers retry after failure", async ({ page }) => {
  let requests = 0;
  await page.route("https://example.com/garden.jpg", async (route) => {
    requests++;
    await route.abort("failed");
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The city is a garden" })).toBeVisible();
  expect(requests).toBe(0);
  await page.getByRole("button", { name: "Load image", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry image", exact: true })).toBeVisible();
  expect(requests).toBe(1);
  await page.getByRole("button", { name: "Retry image", exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await page.getByRole("button", { name: "Next item" }).click();
  await page.getByRole("button", { name: "Previous item" }).click();
  await expect(page.getByRole("button", { name: "Load image", exact: true })).toBeVisible();
  expect(requests).toBe(2);
});

test("updates first-sync status without queuing another refresh", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/v1/preferences", (route) =>
    route.fulfill({ json: { preferences: { blockedLabels: [], mutedSourceIds: [] } } }),
  );
  await page.route("**/api/v1/sources", (route) => {
    expect(route.request().method()).toBe("GET");
    reads++;
    return route.fulfill({
      json: {
        sources: [
          {
            ...fieldNotesSource,
            status: reads === 1 ? "queued" : "ready",
            ...(reads > 1 ? { lastSyncedAt: observedAt } : {}),
          },
        ],
      },
    });
  });
  await page.goto("/sources/");
  await expect(page.getByText("Refresh pending", { exact: true })).toBeVisible();
  await expect(page.getByText("ready", { exact: true })).toBeVisible();
  await expect(page.getByText(/Last synced/)).toBeVisible();
});
