import { enqueueMutation, replayOutbox, type OutboxEntry, type OutboxStore } from "./outbox";

export const OFFLINE_DB_NAME = "fads-offline-v1";
const OUTBOX_STORE = "outbox";

class IndexedDbOutbox implements OutboxStore {
  private readonly database: Promise<IDBDatabase>;

  constructor() {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(OFFLINE_DB_NAME, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
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
      if (request) {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error("Offline storage request failed."));
      }
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Offline storage transaction failed."));
      transaction.oncomplete = () => {
        if (!request) resolve(undefined as T);
      };
    });
  }
}

export function createIndexedDbOutbox(): OutboxStore {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable.");
  return new IndexedDbOutbox();
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
  if (typeof indexedDB !== "undefined") {
    const store = createIndexedDbOutbox();
    await store.clear();
  }
  const active =
    registration?.active ??
    (typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : undefined);
  active?.postMessage({ type: "CLEAR_OFFLINE" });
}

export async function queueOfflineMutation(
  request: Request,
  store = createIndexedDbOutbox(),
): Promise<OutboxEntry> {
  return enqueueMutation(store, request);
}

export async function replayOfflineMutations(
  store = createIndexedDbOutbox(),
): Promise<{ sent: number; pending: number; failed: number }> {
  return replayOutbox(store, async (entry) =>
    fetch(entry.url, {
      method: entry.method,
      headers: entry.headers,
      body: entry.body,
      credentials: "same-origin",
      cache: "no-store",
    }),
  );
}
