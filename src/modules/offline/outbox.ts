export type OfflineMutationKind = "feedback" | "progress";
export type ReplayDisposition = "success" | "transient" | "permanent";

export interface OutboxEntry {
  id: string;
  kind: OfflineMutationKind;
  url: string;
  method: "POST" | "PATCH";
  body: string;
  headers: Record<string, string>;
  idempotencyKey: string;
  requestHash: string;
  createdAt: number;
  attempts: number;
  state: "pending" | "failed";
  lastError?: string;
}

export interface OutboxStore {
  list(): Promise<OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  markAttempt(id: string): Promise<void>;
  clear(): Promise<void>;
}

const INTERACTION_PATH = /^\/api\/v1\/interactions$/;
const PROGRESS_PATH = /^\/api\/v1\/editions\/[^/]+\/progress$/;
const ID_KEY = /^[\x21-\x7e]{1,128}$/;
const FEEDBACK_KINDS = new Set([
  "more_like_this",
  "less_like_this",
  "good_surprise",
  "not_now",
  "mute_source",
  "keep",
]);
let lastCreatedAt = 0;

function appOrigin(): string {
  if (typeof location !== "undefined") return location.origin;
  return "https://fads.cc";
}

function parseBody(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Route and method gate. Payload validation occurs while enqueueing, before persistence. */
export function isQueueableMutation(request: Request): boolean {
  const url = new URL(request.url);
  const route =
    (request.method === "POST" && INTERACTION_PATH.test(url.pathname)) ||
    (request.method === "PATCH" && PROGRESS_PATH.test(url.pathname));
  return (
    url.origin === appOrigin() &&
    url.search === "" &&
    route &&
    ID_KEY.test(request.headers.get("Idempotency-Key") ?? "")
  );
}

async function validatedRequest(request: Request): Promise<{
  kind: OfflineMutationKind;
  body: string;
  headers: Record<string, string>;
  idempotencyKey: string;
}> {
  if (!isQueueableMutation(request)) throw new Error("Mutation is not queueable offline.");
  const body = await request.clone().text();
  const data = parseBody(body);
  const kind: OfflineMutationKind = request.method === "POST" ? "feedback" : "progress";
  if (!data) throw new Error("Offline mutation body must be JSON.");
  if (kind === "feedback") {
    if (
      typeof data.editionId !== "string" ||
      typeof data.contentId !== "string" ||
      typeof data.sourceId !== "string" ||
      typeof data.kind !== "string" ||
      !FEEDBACK_KINDS.has(data.kind)
    )
      throw new Error("Invalid feedback mutation.");
  } else if (
    typeof data.position !== "number" ||
    !Number.isInteger(data.position) ||
    data.position < 0 ||
    data.position > 12
  ) {
    throw new Error("Invalid progress mutation.");
  }
  const idempotencyKey = request.headers.get("Idempotency-Key")!;
  return {
    kind,
    body,
    idempotencyKey,
    headers: {
      "Content-Type": request.headers.get("Content-Type") ?? "application/json",
      "Idempotency-Key": idempotencyKey,
    },
  };
}

export async function enqueueMutation(
  store: OutboxStore,
  request: Request,
  options: { now?: number; id?: string } = {},
): Promise<OutboxEntry> {
  const validated = await validatedRequest(request);
  const url = new URL(request.url).toString();
  const requestHash = `${request.method}\n${url}\n${validated.body}`;
  const existing = (await store.list()).find(
    (entry) => entry.idempotencyKey === validated.idempotencyKey,
  );
  if (existing) {
    if (existing.requestHash !== requestHash)
      throw new Error("Idempotency key was reused for a different mutation.");
    return existing;
  }
  const entry: OutboxEntry = {
    id: options.id ?? globalThis.crypto?.randomUUID?.() ?? `offline-${Date.now()}-${Math.random()}`,
    kind: validated.kind,
    url,
    method: request.method as "POST" | "PATCH",
    body: validated.body,
    headers: validated.headers,
    idempotencyKey: validated.idempotencyKey,
    requestHash,
    createdAt:
      options.now ??
      (() => {
        const now = Date.now();
        lastCreatedAt = Math.max(now, lastCreatedAt + 1);
        return lastCreatedAt;
      })(),
    attempts: 0,
    state: "pending",
  };
  await store.put(entry);
  return entry;
}

export function classifyReplayResponse(response?: Response, error?: unknown): ReplayDisposition {
  if (error || !response) return "transient";
  if (response.ok) return "success";
  return response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
    ? "transient"
    : "permanent";
}

export async function replayOutbox(
  store: OutboxStore,
  send: (entry: OutboxEntry) => Promise<Response>,
): Promise<{ sent: number; pending: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const entries = (await store.list()).sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of entries) {
    if (entry.state === "failed") break;
    await store.markAttempt(entry.id);
    let response: Response | undefined;
    let error: unknown;
    try {
      response = await send(entry);
    } catch (caught) {
      error = caught;
    }
    const disposition = classifyReplayResponse(response, error);
    if (disposition === "success") {
      await store.remove(entry.id);
      sent += 1;
      continue;
    }
    if (disposition === "permanent") {
      await store.markFailed(
        entry.id,
        response ? `Server rejected mutation (${response.status}).` : "Mutation failed.",
      );
      failed += 1;
    }
    break;
  }
  const pending = await store.list();
  return { sent, pending: pending.length, failed };
}

export function createMemoryOutbox(): OutboxStore {
  const entries: OutboxEntry[] = [];
  return {
    list() {
      return Promise.resolve(entries.map((entry) => ({ ...entry, headers: { ...entry.headers } })));
    },
    put(entry) {
      entries.push({ ...entry, headers: { ...entry.headers } });
      return Promise.resolve();
    },
    remove(id) {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) entries.splice(index, 1);
      return Promise.resolve();
    },
    markFailed(id, error) {
      const entry = entries.find((item) => item.id === id);
      if (entry) {
        entry.state = "failed";
        entry.lastError = error;
      }
      return Promise.resolve();
    },
    markAttempt(id) {
      const entry = entries.find((item) => item.id === id);
      if (entry) entry.attempts += 1;
      return Promise.resolve();
    },
    clear() {
      entries.splice(0, entries.length);
      return Promise.resolve();
    },
  };
}
