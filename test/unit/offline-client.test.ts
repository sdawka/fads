import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EDITION_CACHE_NAME,
  OFFLINE_SESSION_PATH,
  getOfflineEdition,
  getOfflineSession,
  getOfflineStatus,
  queueOfflineMutation,
  registerOfflineServiceWorker,
  replayOfflineMutations,
  setOfflineSession,
} from "../../src/modules/offline/client";
import { createMemoryOutbox, enqueueMutation } from "../../src/modules/offline/outbox";

class FakeCache {
  readonly values = new Map<string, Response>();

  async put(request: Request | string, response: Response) {
    this.values.set(typeof request === "string" ? request : request.url, response.clone());
  }

  async match(request: Request | string) {
    return this.values.get(typeof request === "string" ? request : request.url)?.clone();
  }
}

function installCaches() {
  const cachesByName = new Map<string, FakeCache>();
  vi.stubGlobal("caches", {
    open: async (name: string) => {
      const cache = cachesByName.get(name) ?? new FakeCache();
      cachesByName.set(name, cache);
      return cache;
    },
    delete: async (name: string) => cachesByName.delete(name),
  });
  return cachesByName;
}

const activeEdition = (ownerId = "did:plc:owner") => ({
  edition: {
    id: "edition-1",
    ownerId,
    createdAt: "2026-09-08T12:00:00.000Z",
    curiosity: 50,
    energy: 50,
    items: [],
    decisionTrace: { factors: [] },
  },
  content: [],
  position: 0,
  completed: false,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("offline browser client", () => {
  it("is safe to call during server rendering", async () => {
    expect(await registerOfflineServiceWorker()).toBeUndefined();
  });

  it("surfaces pending and permanent-failure state for the owner UI", async () => {
    installCaches();
    await setOfflineSession({ did: "did:plc:owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    const store = createMemoryOutbox();
    await enqueueMutation(
      store,
      new Request("https://fads.cc/api/v1/editions/edition-1/progress", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "progress-1" },
        body: JSON.stringify({ position: 1 }),
      }),
    );
    expect(await getOfflineStatus(store)).toEqual({
      pending: 1,
      failed: 0,
      hasPending: true,
      hasFailed: false,
    });
  });

  it("persists the server absolute expiry without renewing it", async () => {
    const cachesByName = installCaches();
    const legacy = new FakeCache();
    legacy.values.set("/api/v1/editions/active", Response.json(activeEdition()));
    cachesByName.set("fads-edition-v1", legacy);

    const session = {
      did: "did:plc:owner",
      expiresAt: "2026-09-15T12:00:00.000Z",
    };
    await setOfflineSession(session);

    expect(cachesByName.has("fads-edition-v1")).toBe(false);
    expect(
      await (await cachesByName.get(EDITION_CACHE_NAME)!.match(OFFLINE_SESSION_PATH))?.json(),
    ).toEqual(session);
    expect(await getOfflineSession()).toEqual(session);
  });

  it("keeps authenticated online use available when Cache Storage is unavailable", async () => {
    vi.stubGlobal("caches", undefined);

    await expect(
      setOfflineSession({
        did: "did:plc:owner",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("serves an offline edition only to its unexpired DID", async () => {
    const cachesByName = installCaches();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
    await setOfflineSession({
      did: "did:plc:owner",
      expiresAt: "2026-09-08T12:00:00.001Z",
    });
    const cache = cachesByName.get(EDITION_CACHE_NAME)!;
    await cache.put("/api/v1/editions/active", Response.json(activeEdition()));

    expect(await getOfflineEdition()).toEqual(activeEdition());

    vi.setSystemTime(new Date("2026-09-08T12:00:00.001Z"));
    expect(await getOfflineEdition()).toBeUndefined();
    expect(cachesByName.has(EDITION_CACHE_NAME)).toBe(false);
  });

  it("clears a cached edition when its owner differs from the session DID", async () => {
    const cachesByName = installCaches();
    await setOfflineSession({ did: "did:plc:owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    const cache = cachesByName.get(EDITION_CACHE_NAME)!;
    await cache.put(
      "/api/v1/editions/active",
      Response.json(activeEdition("did:plc:someone-else")),
    );

    expect(await getOfflineEdition()).toBeUndefined();
    expect(cachesByName.has(EDITION_CACHE_NAME)).toBe(false);
  });

  it("does not queue or replay after the absolute session expiry", async () => {
    installCaches();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
    await setOfflineSession({
      did: "did:plc:owner",
      expiresAt: "2026-09-08T12:00:00.001Z",
    });
    const store = createMemoryOutbox();
    const request = new Request("https://fads.cc/api/v1/editions/edition-1/progress", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "progress-expired" },
      body: JSON.stringify({ position: 1 }),
    });
    await queueOfflineMutation(request, store);
    vi.setSystemTime(new Date("2026-09-08T12:00:00.001Z"));
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(queueOfflineMutation(request, store)).rejects.toThrow(/session/i);
    expect(await replayOfflineMutations(store)).toEqual({ sent: 0, pending: 0, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it("clears the outbox when replay receives a confirmed 401", async () => {
    installCaches();
    await setOfflineSession({ did: "did:plc:owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    const store = createMemoryOutbox();
    await queueOfflineMutation(
      new Request("https://fads.cc/api/v1/editions/edition-1/progress", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "progress-401" },
        body: JSON.stringify({ position: 1 }),
      }),
      store,
    );
    vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));

    expect(await replayOfflineMutations(store)).toEqual({ sent: 0, pending: 0, failed: 0 });
    expect(await store.list()).toEqual([]);
  });
});
