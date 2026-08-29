import {
  EditionResponseSchema,
  InterestSuggestionSchema,
  ManualInterestSchema,
  OwnerPreferencesSchema,
  SourceCreateSchema,
  SourceSchema,
  SuggestionDecisionSchema,
} from "../contracts";
import { z } from "zod";
import type {
  ActiveEditionView,
  FadsUiClient,
  FeedbackKind,
  OwnerExport,
  SessionView,
} from "./models";

const paths = {
  session: "/api/v1/session",
  activeEdition: "/api/v1/editions/active",
  createEdition: "/api/v1/editions",
  interaction: "/api/v1/interactions",
  progress: (editionId: string) => `/api/v1/editions/${encodeURIComponent(editionId)}/progress`,
  complete: (editionId: string) => `/api/v1/editions/${encodeURIComponent(editionId)}/complete`,
  keeps: "/api/v1/keeps",
  keep: (contentId: string) => `/api/v1/keeps/${encodeURIComponent(contentId)}`,
  sources: "/api/v1/sources",
  source: (sourceId: string) => `/api/v1/sources/${encodeURIComponent(sourceId)}`,
  sourceRefresh: (sourceId: string) => `/api/v1/sources/${encodeURIComponent(sourceId)}/refresh`,
  opml: "/api/v1/sources/opml",
  interests: "/api/v1/interests",
  interest: (interestId: string) => `/api/v1/interests/${encodeURIComponent(interestId)}`,
  suggestions: "/api/v1/suggestions",
  suggestion: (suggestionId: string) => `/api/v1/suggestions/${encodeURIComponent(suggestionId)}`,
  preferences: "/api/v1/preferences",
  export: "/api/v1/export",
  reset: "/api/v1/reset",
  logout: "/api/v1/logout",
} as const;

const KeepRecordSchema = z
  .object({
    ownerId: z.string().trim().min(1),
    contentId: z.string().trim().min(1),
    keptAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const OwnerExportSchema = z
  .object({
    ownerId: z.string().trim().min(1),
    exportedAt: z.iso.datetime({ offset: true }),
    data: z.record(z.string(), z.json()),
  })
  .strict();
const OpmlImportResponseSchema = z
  .object({
    sources: z.array(SourceSchema),
    rejected: z.array(z.object({ url: z.string(), reason: z.string() }).strict()),
  })
  .strict();

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random()}`;
}

function assertOk(response: Response): Response {
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Your session expired." : "The request failed.");
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  return assertOk(response).json();
}

function readNoContent(response: Response): void {
  assertOk(response);
}

function parse<T>(value: unknown, schema: z.ZodType<T>, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(message);
  return parsed.data;
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
  const mutate = (
    path: string,
    body: unknown,
    method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST",
  ) =>
    fetcher(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    async listKeeps() {
      const value = await readJson(await get(paths.keeps));
      return parse(
        value,
        z.object({ keeps: z.array(KeepRecordSchema) }).strict(),
        "Invalid keeps response.",
      ).keeps;
    },
    async addKeep(contentId: string) {
      const value = await readJson(await mutate(paths.keeps, { contentId }));
      return parse(value, z.object({ keep: KeepRecordSchema }).strict(), "Invalid keep response.")
        .keep;
    },
    async removeKeep(contentId: string) {
      readNoContent(await mutate(paths.keep(contentId), undefined, "DELETE"));
    },
    async listSources() {
      const value = await readJson(await get(paths.sources));
      return parse(
        value,
        z.object({ sources: z.array(SourceSchema) }).strict(),
        "Invalid sources response.",
      ).sources;
    },
    async addSource(input) {
      const body = parse(input, SourceCreateSchema, "Invalid source request.");
      const value = await readJson(await mutate(paths.sources, body));
      return parse(value, z.object({ source: SourceSchema }).strict(), "Invalid source response.")
        .source;
    },
    async removeSource(sourceId: string) {
      readNoContent(await mutate(paths.source(sourceId), undefined, "DELETE"));
    },
    async refreshSource(sourceId: string) {
      const value = await readJson(await mutate(paths.sourceRefresh(sourceId), {}));
      return parse(value, z.object({ source: SourceSchema }).strict(), "Invalid source response.")
        .source;
    },
    async muteSource(sourceId: string, muted: boolean, current) {
      const previous = current ?? (await this.getPreferences());
      const mutedSourceIds = muted
        ? [...new Set([...previous.mutedSourceIds, sourceId])]
        : previous.mutedSourceIds.filter((id) => id !== sourceId);
      return this.savePreferences({ ...previous, mutedSourceIds });
    },
    async importOpml(opml: string) {
      const value = await readJson(await mutate(paths.opml, { opml }));
      return parse(value, OpmlImportResponseSchema, "Invalid OPML response.");
    },
    async exportOpml() {
      const response = assertOk(await get(paths.opml));
      const value = await response.text();
      if (!value.trim() || value.length > 2 * 1024 * 1024)
        throw new Error("Invalid OPML response.");
      return value;
    },
    async listInterests() {
      const value = await readJson(await get(paths.interests));
      return parse(
        value,
        z.object({ interests: z.array(ManualInterestSchema) }).strict(),
        "Invalid interests response.",
      ).interests;
    },
    async addInterest(value: string) {
      const response = await readJson(await mutate(paths.interests, { value }));
      return parse(
        response,
        z.object({ interest: ManualInterestSchema }).strict(),
        "Invalid interest response.",
      ).interest;
    },
    async removeInterest(interestId: string) {
      readNoContent(await mutate(paths.interest(interestId), undefined, "DELETE"));
    },
    async listSuggestions() {
      const value = await readJson(await get(paths.suggestions));
      return parse(
        value,
        z.object({ suggestions: z.array(InterestSuggestionSchema) }).strict(),
        "Invalid suggestions response.",
      ).suggestions;
    },
    async decideSuggestion(suggestionId: string, decision: "confirm" | "reject") {
      const body = parse({ decision }, SuggestionDecisionSchema, "Invalid suggestion decision.");
      const value = await readJson(await mutate(paths.suggestion(suggestionId), body));
      return parse(
        value,
        z.object({ suggestion: InterestSuggestionSchema }).strict(),
        "Invalid suggestion response.",
      ).suggestion;
    },
    async getPreferences() {
      const value = await readJson(await get(paths.preferences));
      return parse(
        value,
        z.object({ preferences: OwnerPreferencesSchema }).strict(),
        "Invalid preferences response.",
      ).preferences;
    },
    async savePreferences(preferences) {
      const body = parse(preferences, OwnerPreferencesSchema, "Invalid preferences request.");
      const value = await readJson(await mutate(paths.preferences, body, "PUT"));
      return parse(
        value,
        z.object({ preferences: OwnerPreferencesSchema }).strict(),
        "Invalid preferences response.",
      ).preferences;
    },
    async exportData(): Promise<OwnerExport> {
      return parse(
        await readJson(await get(paths.export)),
        OwnerExportSchema,
        "Invalid export response.",
      );
    },
    async reset(full = false) {
      readNoContent(
        await mutate(
          paths.reset,
          full ? { full: true, confirmation: "DELETE ALL PRIVATE DATA" } : { full: false },
        ),
      );
    },
    async logout() {
      readNoContent(await mutate(paths.logout, undefined));
    },
  };
}
