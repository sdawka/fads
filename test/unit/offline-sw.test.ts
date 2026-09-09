import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class FakeCache {
  readonly values = new Map<string, Response>();
  async addAll(paths: string[]) {
    for (const path of paths) this.values.set(path, new Response(`shell:${path}`));
  }
  async put(request: Request | string, response: Response) {
    this.values.set(
      typeof request === "string" ? request : new URL(request.url).pathname,
      response.clone(),
    );
  }
  async match(request: Request | string) {
    return this.values
      .get(typeof request === "string" ? request : new URL(request.url).pathname)
      ?.clone();
  }
}

function createHarness() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const cachesByName = new Map<string, FakeCache>();
  const entries: Record<string, unknown>[] = [];
  let hasStore = false;
  const makeRequest = (result: unknown) => {
    const request: { result: unknown; onsuccess?: () => void; onerror?: () => void } = { result };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };
  const db = {
    objectStoreNames: { contains: () => hasStore },
    createObjectStore: () => {
      hasStore = true;
      return { indexNames: { contains: () => false }, createIndex: () => undefined };
    },
    transaction: () => {
      const transaction: {
        oncomplete?: () => void;
        onerror?: () => void;
        onabort?: () => void;
        objectStore: () => unknown;
      } = {
        objectStore: () => ({
          indexNames: { contains: () => true },
          createIndex: () => undefined,
          getAll: () => {
            const request = makeRequest([...entries]);
            queueMicrotask(() => transaction.oncomplete?.());
            return request;
          },
          put: (entry: Record<string, unknown>) => {
            const index = entries.findIndex((existing) => existing.id === entry.id);
            if (index >= 0) entries[index] = entry;
            else entries.push(entry);
            const request = makeRequest(undefined);
            queueMicrotask(() => transaction.oncomplete?.());
            return request;
          },
          delete: (id: string) => {
            const index = entries.findIndex((entry) => entry.id === id);
            if (index >= 0) entries.splice(index, 1);
            const request = makeRequest(undefined);
            queueMicrotask(() => transaction.oncomplete?.());
            return request;
          },
          clear: () => {
            entries.splice(0, entries.length);
            const request = makeRequest(undefined);
            queueMicrotask(() => transaction.oncomplete?.());
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  const indexedDB = {
    open: () => {
      const request: {
        result: typeof db;
        transaction?: unknown;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: () => void;
      } = { result: db };
      request.transaction = db.transaction();
      queueMicrotask(() => {
        if (!hasStore) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  const caches = {
    open: async (name: string) => {
      const cache = cachesByName.get(name) ?? new FakeCache();
      cachesByName.set(name, cache);
      return cache;
    },
    delete: async (name: string) => cachesByName.delete(name),
    keys: async () => [...cachesByName.keys()],
    match: async (request: Request | string) => {
      for (const cache of cachesByName.values()) {
        const match = await cache.match(request);
        if (match) return match;
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: "https://fads.cc" },
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) =>
      listeners.set(type, handler),
    skipWaiting: async () => undefined,
  };
  const sandbox = {
    self,
    caches,
    indexedDB,
    URL,
    Request,
    Response,
    crypto: { randomUUID: () => "queued-1" },
    fetch: async (_request: Request) => new Response(null, { status: 503 }),
    clients: { claim: async () => undefined },
    registration: { sync: { register: async () => undefined } },
  };
  const restart = () =>
    runInNewContext(`(function () {\n${readFileSync("public/sw.js", "utf8")}\n})();`, sandbox);
  restart();
  return { listeners, caches, entries, sandbox, restart };
}

async function sendMessage(
  harness: ReturnType<typeof createHarness>,
  data: Record<string, unknown>,
) {
  let work: Promise<unknown> | undefined;
  let acknowledged = false;
  harness.listeners.get("message")!({
    data,
    ports: [{ postMessage: () => (acknowledged = true) }],
    waitUntil: (promise: Promise<unknown>) => {
      work = promise;
    },
  });
  if (!work) throw new Error(`Service worker did not handle ${String(data.type)}.`);
  await work;
  expect(acknowledged).toBe(true);
}

async function authorize(
  harness: ReturnType<typeof createHarness>,
  did = "did:plc:owner",
  expiresAt = "2099-01-01T00:00:00.000Z",
) {
  await sendMessage(harness, { type: "SET_OFFLINE_SESSION", session: { did, expiresAt } });
}

const activeEdition = {
  edition: {
    id: "edition-1",
    ownerId: "did:plc:owner",
    createdAt: "2026-08-28T14:00:00.000Z",
    curiosity: 50,
    energy: 50,
    items: [],
    decisionTrace: { factors: [], generatedAt: "2026-08-28T14:00:00.000Z" },
  },
  content: [],
  position: 0,
  completed: false,
};

describe("service worker flows", () => {
  it("pre-caches hashed application assets discovered in the install shell", async () => {
    const harness = createHarness();
    harness.sandbox.fetch = async () =>
      new Response(
        '<!doctype html><script type="module" src="/_astro/app.abc123.js"></script><link rel="stylesheet" href="/_astro/app.def456.css">',
        { headers: { "content-type": "text/html" } },
      );
    let installPromise: Promise<unknown> | undefined;
    harness.listeners.get("install")!({
      waitUntil: (promise: Promise<unknown>) => {
        installPromise = promise;
      },
    });
    await installPromise;

    const shell = await harness.caches.open("fads-shell-v1");
    expect(await shell.match("/_astro/app.abc123.js")).toBeDefined();
    expect(await shell.match("/_astro/app.def456.css")).toBeDefined();
  });

  it("caches a contract-valid active edition returned by the network", async () => {
    const harness = createHarness();
    await authorize(harness);
    const request = new Request("https://fads.cc/api/v1/editions/active");
    harness.sandbox.fetch = async () => Response.json(activeEdition);
    let responsePromise: Promise<Response> | undefined;
    harness.listeners.get("fetch")!({
      request,
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
    });

    expect(await (await responsePromise!).json()).toEqual(activeEdition);
    expect(
      await (await (await harness.caches.open("fads-edition-v2")).match(request))?.json(),
    ).toEqual(activeEdition);
  });

  it("keeps the cached edition current after creation and progress", async () => {
    const harness = createHarness();
    await authorize(harness);
    const activeRequest = new Request("https://fads.cc/api/v1/editions/active");
    harness.sandbox.fetch = async () => Response.json(activeEdition, { status: 201 });
    let responsePromise: Promise<Response> | undefined;
    harness.listeners.get("fetch")!({
      request: new Request("https://fads.cc/api/v1/editions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "edition-1" },
        body: JSON.stringify({ curiosity: 50, energy: 50 }),
      }),
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
    });
    expect(await responsePromise).toMatchObject({ status: 201 });
    expect(
      await (await (await harness.caches.open("fads-edition-v2")).match(activeRequest))?.json(),
    ).toEqual(activeEdition);

    harness.sandbox.fetch = async () =>
      Response.json({
        progress: {
          editionId: "edition-1",
          ownerId: "did:plc:owner",
          position: 0,
          completed: true,
        },
      });
    responsePromise = undefined;
    harness.listeners.get("fetch")!({
      request: new Request("https://fads.cc/api/v1/editions/edition-1/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "complete-online" },
        body: "{}",
      }),
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
    });
    expect(await responsePromise).toMatchObject({ status: 200 });
    expect(
      await (await (await harness.caches.open("fads-edition-v2")).match(activeRequest))?.json(),
    ).toMatchObject({ position: 0, completed: true });
  });

  it("clones a queueable body before failed network fetch and persists it intact", async () => {
    const harness = createHarness();
    await authorize(harness);
    const body = JSON.stringify({
      editionId: "edition-1",
      contentId: "content-1",
      sourceId: "rss:source-1",
      kind: "more_like_this",
    });
    harness.sandbox.fetch = async (request: Request) => {
      expect(await request.text()).toBe(body);
      throw new TypeError("offline");
    };
    let responsePromise: Promise<Response> | undefined;
    const event = {
      request: new Request("https://fads.cc/api/v1/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "feedback-1" },
        body,
      }),
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
    };
    harness.listeners.get("fetch")!(event);
    expect(await responsePromise).toMatchObject({ status: 202 });
    expect(harness.entries[0]).toMatchObject({ body, idempotencyKey: "feedback-1" });
  });

  it("queues a completion when the network is offline or transiently unavailable", async () => {
    const harness = createHarness();
    await authorize(harness);
    harness.sandbox.fetch = async () => new Response(null, { status: 503 });
    let responsePromise: Promise<Response> | undefined;
    harness.listeners.get("fetch")!({
      request: new Request("https://fads.cc/api/v1/editions/edition-1/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "complete-1" },
        body: "{}",
      }),
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
    });

    expect(await responsePromise).toMatchObject({ status: 202 });
    expect(harness.entries[0]).toMatchObject({
      kind: "completion",
      body: "{}",
      idempotencyKey: "complete-1",
    });
  });

  it("serves cached active edition offline and clears only personal state", async () => {
    const harness = createHarness();
    await authorize(harness);
    const editionCache = await harness.caches.open("fads-edition-v2");
    const request = new Request("https://fads.cc/api/v1/editions/active");
    await editionCache.put(request, Response.json(activeEdition));
    harness.sandbox.fetch = async () => {
      throw new TypeError("offline");
    };
    let responsePromise: Promise<Response> | undefined;
    harness.listeners.get("fetch")!({
      request,
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
    });
    expect(await (await responsePromise!).json()).toEqual(activeEdition);
    const shell = await harness.caches.open("fads-shell-v1");
    await shell.put("/", new Response("shell"));
    let clearPromise: Promise<unknown> | undefined;
    harness.listeners.get("message")!({
      data: { type: "CLEAR_OFFLINE" },
      waitUntil: (promise: Promise<unknown>) => {
        clearPromise = promise;
      },
    });
    await clearPromise;
    expect(await (await harness.caches.open("fads-edition-v2")).match(request)).toBeUndefined();
    expect(await shell.match("/")).toBeDefined();
  });

  it("persists the absolute session across worker restart without renewing it", async () => {
    const harness = createHarness();
    const expiresAt = "2099-01-01T00:00:00.000Z";
    await authorize(harness, "did:plc:owner", expiresAt);
    harness.restart();

    const stored = await (
      await (await harness.caches.open("fads-edition-v2")).match("/__offline/session")
    )?.json();
    expect(stored).toEqual({ did: "did:plc:owner", expiresAt });
  });

  it("invalidates legacy private caches and outbox entries without expiry metadata", async () => {
    const harness = createHarness();
    const legacy = await harness.caches.open("fads-edition-v1");
    await legacy.put("/api/v1/editions/active", Response.json(activeEdition));
    harness.entries.push({ id: "legacy-queued", state: "pending" });
    let activation: Promise<unknown> | undefined;
    harness.listeners.get("activate")!({
      waitUntil: (promise: Promise<unknown>) => {
        activation = promise;
      },
    });

    await activation;

    expect(harness.entries).toEqual([]);
    expect(await harness.caches.keys()).not.toContain("fads-edition-v1");
  });

  it("fails closed when replacement session expiry metadata is malformed", async () => {
    const harness = createHarness();
    await authorize(harness);
    const cache = await harness.caches.open("fads-edition-v2");
    await cache.put("/api/v1/editions/active", Response.json(activeEdition));
    harness.entries.push({ id: "queued-1", state: "pending" });

    await sendMessage(harness, {
      type: "SET_OFFLINE_SESSION",
      session: { did: "did:plc:owner", expiresAt: "not-a-date" },
    });

    expect(harness.entries).toEqual([]);
    expect(await harness.caches.keys()).not.toContain("fads-edition-v2");
  });

  it("clears edition and outbox when the authenticated DID changes", async () => {
    const harness = createHarness();
    await authorize(harness);
    const cache = await harness.caches.open("fads-edition-v2");
    await cache.put("/api/v1/editions/active", Response.json(activeEdition));
    harness.entries.push({ id: "queued-legacy", state: "pending" });

    await authorize(harness, "did:plc:another-owner");

    expect(
      await (await harness.caches.open("fads-edition-v2")).match("/api/v1/editions/active"),
    ).toBeUndefined();
    expect(harness.entries).toEqual([]);
  });

  it("preserves an unexpired offline edition on transient session inspection failure", async () => {
    const harness = createHarness();
    await authorize(harness);
    const cache = await harness.caches.open("fads-edition-v2");
    await cache.put("/api/v1/editions/active", Response.json(activeEdition));
    harness.sandbox.fetch = async () => new Response(null, { status: 503 });
    let responsePromise: Promise<Response> | undefined;
    harness.listeners.get("fetch")!({
      request: new Request("https://fads.cc/api/v1/session"),
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
    });

    expect(await responsePromise).toMatchObject({ status: 503 });
    expect(await cache.match("/api/v1/editions/active")).toBeDefined();
  });

  it("clears private state on confirmed signed out session inspection", async () => {
    const harness = createHarness();
    await authorize(harness);
    const cache = await harness.caches.open("fads-edition-v2");
    await cache.put("/api/v1/editions/active", Response.json(activeEdition));
    harness.entries.push({ id: "queued-1", state: "pending" });
    harness.sandbox.fetch = async () => Response.json({ authenticated: false });
    let responsePromise: Promise<Response> | undefined;
    harness.listeners.get("fetch")!({
      request: new Request("https://fads.cc/api/v1/session"),
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
    });
    expect(await (await responsePromise!).json()).toEqual({ authenticated: false });
    expect(harness.entries).toEqual([]);
    expect(
      await (await harness.caches.open("fads-edition-v2")).match("/api/v1/editions/active"),
    ).toBeUndefined();
  });

  it("clears the service-worker outbox when replay receives a 401", async () => {
    const harness = createHarness();
    await authorize(harness);
    harness.entries.push({
      id: "queued-401",
      url: "https://fads.cc/api/v1/interactions",
      method: "POST",
      headers: {},
      body: "{}",
      createdAt: 1,
      sequence: 1,
      attempts: 0,
      state: "pending",
    });
    harness.sandbox.fetch = async () => new Response(null, { status: 401 });

    await sendMessage(harness, { type: "REPLAY_OFFLINE" });

    expect(harness.entries).toEqual([]);
    expect(await harness.caches.keys()).not.toContain("fads-edition-v2");
  });

  it("clears private state after successful logout", async () => {
    const harness = createHarness();
    await authorize(harness);
    harness.entries.push({ id: "queued-logout", state: "pending" });
    harness.sandbox.fetch = async () => new Response(null, { status: 204 });
    let responsePromise: Promise<Response> | undefined;
    harness.listeners.get("fetch")!({
      request: new Request("https://fads.cc/api/v1/logout", { method: "POST" }),
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
    });

    expect(await responsePromise).toMatchObject({ status: 204 });
    expect(harness.entries).toEqual([]);
    expect(await harness.caches.keys()).not.toContain("fads-edition-v2");
  });

  it("does not intercept or cache remote media", () => {
    const harness = createHarness();
    let intercepted = false;
    harness.listeners.get("fetch")!({
      request: new Request("https://cdn.example/media/image.jpg"),
      respondWith: () => {
        intercepted = true;
      },
    });
    expect(intercepted).toBe(false);
  });
});
