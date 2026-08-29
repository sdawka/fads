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
  if (!value || typeof value !== "object" || !exactKeys(value, ["edition", "content", "position", "completed"]) || !value.edition || typeof value.edition !== "object") return false;
  const items = value.edition.items;
  const content = value.content;
  if (!Array.isArray(items) || items.length > 12 || !Array.isArray(content) || content.length > 12) return false;
  if (!exactKeys(value.edition, ["id", "ownerId", "createdAt", "curiosity", "energy", "items", "decisionTrace"])) return false;
  if (typeof value.edition.id !== "string" || !value.edition.id.trim() || typeof value.edition.ownerId !== "string" || !value.edition.ownerId.trim() || typeof value.edition.createdAt !== "string" || !Number.isInteger(value.edition.curiosity) || value.edition.curiosity < 0 || value.edition.curiosity > 100 || !Number.isInteger(value.edition.energy) || value.edition.energy < 0 || value.edition.energy > 100 || !validTrace(value.edition.decisionTrace)) return false;
  if (!Number.isInteger(value.position) || value.position < 0 || value.position > items.length || typeof value.completed !== "boolean") return false;
  const contentIds = new Set();
  const itemIds = new Set();
  const positions = new Set();
  for (const item of items) {
    if (!item || !exactKeys(item, ["id", "contentId", "frame", "position", "decisionTrace"]) || typeof item.id !== "string" || !item.id.trim() || typeof item.contentId !== "string" || !item.contentId.trim() || typeof item.frame !== "string" || !item.frame.trim() || !Number.isInteger(item.position) || item.position < 0 || item.position >= items.length || !validTrace(item.decisionTrace) || itemIds.has(item.id) || positions.has(item.position) || item.position !== positions.size) return false;
    itemIds.add(item.id);
    positions.add(item.position);
  }
  for (const item of content) {
    if (!item || !exactKeys(item, ["id", "canonicalUri", "sourceId", "publishedAt", "capturedAt", "blocks", "media", "tags", "labels"]) || typeof item.id !== "string" || !item.id.trim() || typeof item.canonicalUri !== "string" || !item.canonicalUri.trim() || typeof item.sourceId !== "string" || !item.sourceId.trim() || typeof item.publishedAt !== "string" || typeof item.capturedAt !== "string" || !Array.isArray(item.blocks) || !item.blocks.every(validBlock) || !Array.isArray(item.media) || !item.media.every(validMedia) || !Array.isArray(item.tags) || !item.tags.every(validProvenancedValue) || !Array.isArray(item.labels) || !item.labels.every(validProvenancedValue) || contentIds.has(item.id)) return false;
    contentIds.add(item.id);
  }
  return items.every((item) => contentIds.has(item.contentId));
}

function validProvenance(value) {
  return value && typeof value === "object" && typeof value.source === "string" && value.source.trim() && typeof value.observedAt === "string";
}
function validProvenancedValue(value) {
  return value && typeof value === "object" && exactKeys(value, ["value", "provenance"]) && typeof value.value === "string" && value.value.trim() && validProvenance(value.provenance);
}
function validTrace(value) {
  return value && typeof value === "object" && exactKeys(value, ["factors"]) && Array.isArray(value.factors) && value.factors.every((factor) => factor && typeof factor === "object" && exactKeys(factor, ["factor", "weight", "provenance"]) && typeof factor.factor === "string" && factor.factor.trim() && Number.isFinite(factor.weight) && validProvenance(factor.provenance));
}
function validBlock(value) {
  if (!value || typeof value !== "object" || typeof value.kind !== "string") return false;
  if (value.kind === "paragraph") return exactKeys(value, ["kind", "text"]) && typeof value.text === "string" && value.text.trim();
  if (value.kind === "heading") return (exactKeys(value, ["kind", "text"]) || exactKeys(value, ["kind", "text", "level"])) && typeof value.text === "string" && value.text.trim() && (value.level === undefined || (Number.isInteger(value.level) && value.level >= 1 && value.level <= 6));
  if (value.kind === "quote") return (exactKeys(value, ["kind", "text"]) || exactKeys(value, ["kind", "text", "attribution"])) && typeof value.text === "string" && value.text.trim();
  if (value.kind === "code") return (exactKeys(value, ["kind", "code"]) || exactKeys(value, ["kind", "code", "language"])) && typeof value.code === "string";
  if (value.kind === "image") return exactKeys(value, ["kind", "src", "alt"]) && /^https?:\/\//.test(value.src) && typeof value.alt === "string";
  if (["audio", "video"].includes(value.kind)) return (exactKeys(value, ["kind", "src"]) || exactKeys(value, ["kind", "src", "transcript"])) && /^https?:\/\//.test(value.src);
  if (value.kind === "link") return exactKeys(value, ["kind", "href", "text"]) && /^https?:\/\//.test(value.href) && typeof value.text === "string" && value.text.trim();
  return false;
}
function validMedia(value) {
  return value && typeof value === "object" && (exactKeys(value, ["id", "kind", "url", "provenance"]) || exactKeys(value, ["id", "kind", "url", "alt", "provenance"])) && typeof value.id === "string" && value.id.trim() && ["image", "audio", "video"].includes(value.kind) && /^https?:\/\//.test(value.url) && (value.alt === undefined || typeof value.alt === "string") && validProvenance(value.provenance);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function queueable(request, url) {
  const interaction = request.method === "POST" && url.pathname === "/api/v1/interactions";
  const progress = request.method === "PATCH" && /^\/api\/v1\/editions\/[^/]+\/progress$/.test(url.pathname);
  const key = request.headers.get("Idempotency-Key") || "";
  return sameOrigin(url) && !url.search && (interaction || progress) && /^[\x21-\x7e]{1,128}$/.test(key);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(DB_STORE) ? request.transaction.objectStore(DB_STORE) : database.createObjectStore(DB_STORE, { keyPath: "id" });
      if (!store.indexNames.contains("by-idempotency-key")) store.createIndex("by-idempotency-key", "idempotencyKey", { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(mode, action) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const request = action(tx.objectStore(DB_STORE));
    let result;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error("Offline storage transaction failed."));
    };
    if (request) {
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => rejectOnce(request.error);
    }
    tx.onerror = () => rejectOnce(tx.error);
    tx.onabort = () => rejectOnce(tx.error);
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
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
  return Promise.all([
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => undefined)),
    caches.delete(EDITION_CACHE),
    dbRequest("readwrite", (store) => store.clear()),
  ]);
}

function requestReplay() {
  try {
    return registration?.sync?.register("fads-replay").catch(() => undefined) ?? Promise.resolve();
  } catch {
    return Promise.resolve();
  }
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
  const entry = { id: crypto.randomUUID(), kind: interaction ? "feedback" : "progress", url, method: request.method, body, headers: { "Content-Type": request.headers.get("Content-Type") || "application/json", "Idempotency-Key": idempotencyKey }, idempotencyKey, requestHash, createdAt: Date.now(), sequence: Date.now() * 1000 + Math.floor(Math.random() * 1000), attempts: 0, state: "pending" };
  await putOutbox(entry);
  return entry;
}

async function replayOnce() {
  const entries = (await listOutbox()).sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence || a.id.localeCompare(b.id));
  for (const entry of entries) {
    if (entry.state === "failed") break;
    let response;
    try {
      response = await fetch(entry.url, { method: entry.method, headers: entry.headers, body: entry.body, credentials: "same-origin", cache: "no-store" });
    } catch {
      await putOutbox({ ...entry, attempts: entry.attempts + 1 });
      await requestReplay();
      break;
    }
    if (response.ok) { await removeOutbox(entry.id); continue; }
    if (response.status >= 500 || response.status === 408 || response.status === 425 || response.status === 429) {
      await putOutbox({ ...entry, attempts: entry.attempts + 1 });
      await requestReplay();
      break;
    }
    await putOutbox({ ...entry, state: "failed", attempts: entry.attempts + 1, lastError: `Server rejected mutation (${response.status}).` });
    break;
  }
}

let replayLock = Promise.resolve();
function replay() {
  const current = replayLock.then(() => replayOnce());
  replayLock = current.catch(() => undefined);
  return current;
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
    event.respondWith(fetch(request).then((response) => response).catch(async () => (await caches.match(request)) || (await caches.match("/offline"))));
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/_astro/") && ["script", "style", "font"].includes(request.destination)) {
    event.respondWith(fetch(request).then(async (response) => { if (response.ok) (await caches.open(SHELL_CACHE)).put(request, response.clone()); return response; }).catch(() => caches.match(request)));
    return;
  }
  if (queueable(request, url)) {
    const replayRequest = request.clone();
    event.respondWith(fetch(request).catch(async () => {
      try {
        await enqueue(replayRequest);
        await requestReplay();
        return new Response(JSON.stringify({ queued: true }), { status: 202, headers: { "content-type": "application/json", "x-offline-queued": "true" } });
      } catch { return new Response(JSON.stringify({ queued: false }), { status: 400, headers: { "content-type": "application/json" } }); }
    }));
  }
});
