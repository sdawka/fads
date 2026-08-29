/* global URL, caches, clients, crypto, fetch, indexedDB, registration, Response, self */

const VERSION = "v1";
const SHELL_CACHE = `fads-shell-${VERSION}`;
const EDITION_CACHE = `fads-edition-${VERSION}`;
const DB_NAME = "fads-offline-v1";
const DB_STORE = "outbox";
const ACTIVE_EDITION_PATH = "/api/v1/editions/active";
const STATIC_ASSETS = [
  "/",
  "/offline",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icons/icon-192.svg",
  "/icons/icon-512.svg",
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function validEdition(value) {
  if (!value || typeof value !== "object" || !value.edition || typeof value.edition !== "object") return false;
  const items = value.edition.items;
  const content = value.content;
  if (!Array.isArray(items) || items.length > 12 || !Array.isArray(content) || content.length > 12) return false;
  if (!Number.isInteger(value.position) || value.position < 0 || value.position > items.length || typeof value.completed !== "boolean") return false;
  const contentIds = new Set();
  for (const item of items) {
    if (!item || typeof item.contentId !== "string" || !item.contentId.trim() || !Number.isInteger(item.position) || item.position < 0 || item.position >= items.length) return false;
  }
  for (const item of content) {
    if (!item || typeof item.id !== "string" || !item.id.trim() || "html" in item || "raw" in item || "markup" in item) return false;
    if ("blocks" in item && !Array.isArray(item.blocks)) return false;
    contentIds.add(item.id);
  }
  return items.every((item) => contentIds.has(item.contentId));
}

function queueable(request, url) {
  const interaction = request.method === "POST" && url.pathname === "/api/v1/interactions";
  const progress = request.method === "PATCH" && /^\/api\/v1\/editions\/[^/]+\/progress$/.test(url.pathname);
  const key = request.headers.get("Idempotency-Key") || "";
  return sameOrigin(url) && !url.search && (interaction || progress) && /^[\x21-\x7e]{1,128}$/.test(key);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(mode, action) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const request = action(tx.objectStore(DB_STORE));
    if (request) {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } else tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  }));
}

function listOutbox() {
  return dbRequest("readonly", (store) => store.getAll());
}

function putOutbox(entry) {
  return dbRequest("readwrite", (store) => store.put(entry));
}

function removeOutbox(id) {
  return dbRequest("readwrite", (store) => store.delete(id));
}

function clearOffline() {
  return Promise.all([caches.delete(SHELL_CACHE), caches.delete(EDITION_CACHE), dbRequest("readwrite", (store) => store.clear())]);
}

async function enqueue(request) {
  const body = await request.clone().text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Offline mutation body must be JSON."); }
  const interaction = request.method === "POST";
  if (interaction && (!data || typeof data !== "object" || typeof data.editionId !== "string" || typeof data.contentId !== "string" || typeof data.sourceId !== "string" || typeof data.kind !== "string" || !["more_like_this", "less_like_this", "good_surprise", "not_now", "mute_source", "keep"].includes(data.kind))) throw new Error("Invalid feedback mutation.");
  if (!interaction && (!data || typeof data !== "object" || !Number.isInteger(data.position) || data.position < 0 || data.position > 12)) throw new Error("Invalid progress mutation.");
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const url = new URL(request.url).toString();
  const requestHash = `${request.method}\n${url}\n${body}`;
  const entries = await listOutbox();
  const duplicate = entries.find((entry) => entry.idempotencyKey === idempotencyKey);
  if (duplicate) {
    if (duplicate.requestHash !== requestHash) throw new Error("Idempotency key conflict.");
    return duplicate;
  }
  const entry = { id: crypto.randomUUID(), kind: interaction ? "feedback" : "progress", url, method: request.method, body, headers: { "Content-Type": request.headers.get("Content-Type") || "application/json", "Idempotency-Key": idempotencyKey }, idempotencyKey, requestHash, createdAt: Date.now(), attempts: 0, state: "pending" };
  await putOutbox(entry);
  return entry;
}

async function replay() {
  const entries = (await listOutbox()).sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of entries) {
    if (entry.state === "failed") break;
    let response;
    try {
      response = await fetch(entry.url, { method: entry.method, headers: entry.headers, body: entry.body, credentials: "same-origin", cache: "no-store" });
    } catch {
      await putOutbox({ ...entry, attempts: entry.attempts + 1 });
      break;
    }
    if (response.ok) { await removeOutbox(entry.id); continue; }
    if (response.status >= 500 || response.status === 408 || response.status === 425 || response.status === 429) {
      await putOutbox({ ...entry, attempts: entry.attempts + 1 });
      break;
    }
    await putOutbox({ ...entry, state: "failed", attempts: entry.attempts + 1, lastError: `Server rejected mutation (${response.status}).` });
    break;
  }
}

async function activeEdition(request) {
  try {
    const response = await fetch(request);
    if (!response.ok) return response;
    const clone = response.clone();
    const value = await clone.json();
    if (validEdition(value)) {
      const cache = await caches.open(EDITION_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await caches.open(EDITION_CACHE)).match(request) || new Response("", { status: 503 });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("fads-") && ![SHELL_CACHE, EDITION_CACHE].includes(key)).map((key) => caches.delete(key)))).then(() => clients.claim()));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CLEAR_OFFLINE") event.waitUntil(clearOffline());
  if (event.data && event.data.type === "REPLAY_OFFLINE") event.waitUntil(replay());
});

self.addEventListener("sync", (event) => {
  if (event.tag === "fads-replay") event.waitUntil(replay());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (!sameOrigin(url)) return;
  if (request.method === "GET" && url.pathname === ACTIVE_EDITION_PATH && !url.search) {
    event.respondWith(activeEdition(request));
    return;
  }
  if (request.method === "GET" && (request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html"))) {
    event.respondWith(fetch(request).catch(() => caches.match("/offline")));
    return;
  }
  if (queueable(request, url)) {
    event.respondWith(fetch(request).catch(async () => {
      try {
        await enqueue(request);
        try { await registration.sync.register("fads-replay"); } catch { /* Background Sync is optional. */ }
        return new Response(JSON.stringify({ queued: true }), { status: 202, headers: { "content-type": "application/json", "x-offline-queued": "true" } });
      } catch { return new Response(JSON.stringify({ queued: false }), { status: 400, headers: { "content-type": "application/json" } }); }
    }));
  }
});
