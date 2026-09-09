import {
  ACTIVE_EDITION_PATH,
  isUsableOfflineSession,
  isValidActiveEditionResponse,
  type OfflineSession,
} from "./policy";
import { enqueueMutation, replayOutbox, type OutboxEntry, type OutboxStore } from "./outbox";

export const OFFLINE_DB_NAME = "fads-offline-v1";
const OUTBOX_STORE = "outbox";
export const EDITION_CACHE_NAME = "fads-edition-v2";
export const OFFLINE_SESSION_PATH = "/__offline/session";
const LEGACY_EDITION_CACHE_NAME = "fads-edition-v1";

class IndexedDbOutbox implements OutboxStore {
  private readonly database: Promise<IDBDatabase>;

  constructor() {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(OFFLINE_DB_NAME, 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(OUTBOX_STORE)
          ? request.transaction!.objectStore(OUTBOX_STORE)
          : database.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
        if (!store.indexNames.contains("by-idempotency-key")) {
          store.createIndex("by-idempotency-key", "idempotencyKey", { unique: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open offline storage."));
    });
  }

  async list(): Promise<OutboxEntry[]> {
    return (await this.transaction<unknown[]>("readonly", (store) =>
      store.getAll(),
    )) as OutboxEntry[];
  }
  async put(entry: OutboxEntry): Promise<void> {
    await this.transaction("readwrite", (store) => store.put(entry));
  }
  async remove(id: string): Promise<void> {
    await this.transaction("readwrite", (store) => store.delete(id));
  }
  async markFailed(id: string, error: string): Promise<void> {
    const entry = (await this.list()).find((item) => item.id === id);
    if (entry) await this.put({ ...entry, state: "failed", lastError: error });
  }
  async markAttempt(id: string): Promise<void> {
    const entry = (await this.list()).find((item) => item.id === id);
    if (entry) await this.put({ ...entry, attempts: entry.attempts + 1 });
  }
  async clear(): Promise<void> {
    await this.transaction("readwrite", (store) => store.clear());
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(OUTBOX_STORE, mode);
      const request = operation(transaction.objectStore(OUTBOX_STORE));
      let result: T | undefined;
      let settled = false;
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error("Offline storage transaction failed."));
      };
      if (request)
        request.onsuccess = () => {
          result = request.result;
        };
      if (request) request.onerror = () => rejectOnce(request.error);
      transaction.onerror = () => rejectOnce(transaction.error);
      transaction.onabort = () => rejectOnce(transaction.error);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result as T);
      };
    });
  }
}

export function createIndexedDbOutbox(): OutboxStore {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable.");
  return new IndexedDbOutbox();
}

async function clearLocalOfflineState(): Promise<void> {
  const operations: Promise<unknown>[] = [];
  if (typeof indexedDB !== "undefined") operations.push(createIndexedDbOutbox().clear());
  if (typeof caches !== "undefined") {
    operations.push(caches.delete(EDITION_CACHE_NAME), caches.delete(LEGACY_EDITION_CACHE_NAME));
  }
  const results = await Promise.allSettled(operations);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

async function readStoredOfflineSession(): Promise<unknown> {
  if (typeof caches === "undefined") return undefined;
  try {
    const response = await (await caches.open(EDITION_CACHE_NAME)).match(OFFLINE_SESSION_PATH);
    if (!response) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

async function requireOfflineSession(store?: OutboxStore): Promise<OfflineSession | undefined> {
  const session = await readStoredOfflineSession();
  if (isUsableOfflineSession(session)) return session;
  await clearLocalOfflineState();
  if (store) await store.clear();
  return undefined;
}

function activeWorker(registration?: ServiceWorkerRegistration): ServiceWorker | undefined {
  return (
    registration?.active ??
    (typeof navigator !== "undefined"
      ? (navigator.serviceWorker?.controller ?? undefined)
      : undefined)
  );
}

async function postOfflineMessage(
  message: Record<string, unknown>,
  registration?: ServiceWorkerRegistration,
): Promise<void> {
  const worker = activeWorker(registration);
  if (!worker) return;
  if (typeof MessageChannel === "undefined") {
    worker.postMessage(message);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error("Service worker did not acknowledge offline state."));
    }, 2_000);
    channel.port1.onmessage = () => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve();
    };
    worker.postMessage(message, [channel.port2]);
  });
}

export async function setOfflineSession(
  session: OfflineSession,
  registration?: ServiceWorkerRegistration,
): Promise<void> {
  if (!isUsableOfflineSession(session)) {
    await clearOfflineState(registration);
    throw new Error("Offline session expiry is invalid or has passed.");
  }
  const previous = await readStoredOfflineSession();
  if (
    !isUsableOfflineSession(previous) ||
    previous.did !== session.did ||
    previous.expiresAt !== session.expiresAt
  ) {
    await clearLocalOfflineState().catch(() => undefined);
  }
  if (typeof caches !== "undefined") {
    try {
      await caches.delete(LEGACY_EDITION_CACHE_NAME);
      await (
        await caches.open(EDITION_CACHE_NAME)
      ).put(
        OFFLINE_SESSION_PATH,
        Response.json(session, { headers: { "cache-control": "no-store" } }),
      );
    } catch {
      // Online use remains available when private browser storage is unavailable.
    }
  }
  await postOfflineMessage({ type: "SET_OFFLINE_SESSION", session }, registration);
}

export async function registerOfflineServiceWorker(
  path = "/sw.js",
): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  const registration = await navigator.serviceWorker.register(path, { scope: "/" });
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      void navigator.serviceWorker.ready.then((ready) =>
        ready.active?.postMessage({ type: "REPLAY_OFFLINE" }),
      );
    });
  }
  return registration;
}

export async function clearOfflineState(registration?: ServiceWorkerRegistration): Promise<void> {
  await clearLocalOfflineState();
  await postOfflineMessage({ type: "CLEAR_OFFLINE" }, registration);
}

export async function getOfflineSession(): Promise<OfflineSession | undefined> {
  return requireOfflineSession();
}

export interface OfflineStatus {
  pending: number;
  failed: number;
  hasPending: boolean;
  hasFailed: boolean;
}

export async function listOfflineMutations(
  store = createIndexedDbOutbox(),
): Promise<OutboxEntry[]> {
  if (!(await requireOfflineSession(store))) return [];
  return store.list();
}

export async function getOfflineStatus(store = createIndexedDbOutbox()): Promise<OfflineStatus> {
  if (!(await requireOfflineSession(store)))
    return { pending: 0, failed: 0, hasPending: false, hasFailed: false };
  const entries = await store.list();
  const failed = entries.filter((entry) => entry.state === "failed").length;
  const pending = entries.length - failed;
  return { pending, failed, hasPending: pending > 0, hasFailed: failed > 0 };
}

export async function getOfflineEdition<T = unknown>(): Promise<T | undefined> {
  if (typeof caches === "undefined") return undefined;
  const session = await readStoredOfflineSession();
  if (!isUsableOfflineSession(session)) {
    await clearLocalOfflineState();
    return undefined;
  }
  const cache = await caches.open(EDITION_CACHE_NAME);
  const response = await cache.match(ACTIVE_EDITION_PATH);
  if (!response) return undefined;
  try {
    const value: unknown = await response.clone().json();
    if (!isValidActiveEditionResponse(value)) return undefined;
    const edition = value as { edition: { ownerId: string } };
    if (edition.edition.ownerId !== session.did) {
      await clearLocalOfflineState();
      return undefined;
    }
    return value as T;
  } catch {
    return undefined;
  }
}

export async function queueOfflineMutation(
  request: Request,
  store = createIndexedDbOutbox(),
): Promise<OutboxEntry> {
  if (!(await requireOfflineSession(store))) throw new Error("Offline session is unavailable.");
  return enqueueMutation(store, request);
}

export async function replayOfflineMutations(
  store = createIndexedDbOutbox(),
): Promise<{ sent: number; pending: number; failed: number }> {
  if (!(await requireOfflineSession(store))) return { sent: 0, pending: 0, failed: 0 };
  let unauthorized = false;
  const result = await replayOutbox(store, async (entry) => {
    const response = await fetch(entry.url, {
      method: entry.method,
      headers: entry.headers,
      body: entry.body,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.status === 401) {
      unauthorized = true;
      await clearLocalOfflineState();
      await store.clear();
    }
    return response;
  });
  return unauthorized ? { sent: 0, pending: 0, failed: 0 } : result;
}
