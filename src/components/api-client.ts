import { EditionResponseSchema } from "../contracts";
import type { ActiveEditionView, FadsUiClient, FeedbackKind, SessionView } from "./models";

const paths = {
  session: "/api/v1/session",
  activeEdition: "/api/v1/editions/active",
  createEdition: "/api/v1/editions",
  interaction: "/api/v1/interactions",
  progress: (editionId: string) => `/api/v1/editions/${encodeURIComponent(editionId)}/progress`,
  complete: (editionId: string) => `/api/v1/editions/${encodeURIComponent(editionId)}/complete`,
} as const;

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random()}`;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Your session expired." : "The request failed.");
  }
  return response.json() as Promise<unknown>;
}

function parseSession(value: unknown): SessionView {
  if (typeof value !== "object" || value === null) throw new Error("Invalid session response.");
  const authenticated = (value as Record<string, unknown>).authenticated;
  const did = (value as Record<string, unknown>).did;
  if (typeof authenticated !== "boolean" || (did !== undefined && typeof did !== "string")) {
    throw new Error("Invalid session response.");
  }
  return { authenticated, ...(typeof did === "string" ? { did } : {}) };
}

function parseActiveEdition(value: unknown): ActiveEditionView {
  const parsed = EditionResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid edition response.");
  }
  return parsed.data;
}

export function createBrowserUiClient(fetcher: typeof fetch = globalThis.fetch): FadsUiClient {
  const get = (path: string) =>
    fetcher(path, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  const mutate = (path: string, body: unknown, method: "POST" | "PATCH" = "POST") =>
    fetcher(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey(),
      },
      body: JSON.stringify(body),
    });

  return {
    async session() {
      return parseSession(await readJson(await get(paths.session)));
    },
    async activeEdition() {
      const response = await get(paths.activeEdition);
      if (response.status === 404) return undefined;
      return parseActiveEdition(await readJson(response));
    },
    async createEdition(input) {
      return parseActiveEdition(await readJson(await mutate(paths.createEdition, input)));
    },
    async setProgress(editionId, position) {
      await readJson(await mutate(paths.progress(editionId), { position }, "PATCH"));
    },
    async complete(editionId) {
      await readJson(await mutate(paths.complete(editionId), {}));
    },
    async interact(input: {
      editionId: string;
      contentId: string;
      sourceId: string;
      kind: FeedbackKind;
    }) {
      await readJson(await mutate(paths.interaction, input));
    },
  };
}
