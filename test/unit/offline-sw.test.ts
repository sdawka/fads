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
    fetch: async () => new Response(null, { status: 503 }),
    clients: { claim: async () => undefined },
    registration: { sync: { register: async () => undefined } },
  };
  runInNewContext(readFileSync("public/sw.js", "utf8"), sandbox);
  return { listeners, caches, entries, sandbox };
}

describe("service worker flows", () => {
  it("clones a queueable body before failed network fetch and persists it intact", async () => {
    const harness = createHarness();
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

  it("serves cached active edition offline and clears only personal state", async () => {
    const harness = createHarness();
    const editionCache = await harness.caches.open("fads-edition-v1");
    const request = new Request("https://fads.cc/api/v1/editions/active");
    await editionCache.put(
      request,
      new Response(JSON.stringify({ edition: { id: "edition-1" }, content: [] })),
    );
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
    expect(await (await responsePromise!).json()).toEqual({
      edition: { id: "edition-1" },
      content: [],
    });
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
    expect(await (await harness.caches.open("fads-edition-v1")).match(request)).toBeUndefined();
    expect(await shell.match("/")).toBeDefined();
  });
});
