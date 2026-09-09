import {
  EditionProgressResponseSchema,
  EditionResponseSchema,
  InterestResponseSchema,
  InterestsResponseSchema,
  InteractionResponseSchema,
  KeepResponseSchema,
  LearnedPreferencesResponseSchema,
  KeepsResponseSchema,
  OpmlImportResponseSchema,
  OwnerExportSchema,
  OwnerPreferencesSchema,
  PreferencesResponseSchema,
  SessionResponseSchema,
  SourceCreateSchema,
  SourceResponseSchema,
  SourcesResponseSchema,
  SuggestionDecisionSchema,
  SuggestionResponseSchema,
  SuggestionsResponseSchema,
} from "../contracts";
import { clearOfflineState, isValidActiveEditionResponse } from "../modules/offline";
import { z } from "zod";
import type { ActiveEditionView, FadsUiClient, FeedbackKind } from "./models";

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

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random()}`;
}

async function assertOk(response: Response): Promise<Response> {
  if (!response.ok) {
    if (response.status === 401) {
      await clearOfflineState().catch(() => undefined);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("fads:session-expired"));
    }
    throw new Error(response.status === 401 ? "Your session expired." : "The request failed.");
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  return (await assertOk(response)).json();
}

async function readNoContent(response: Response): Promise<void> {
  await assertOk(response);
}

function parse<T>(value: unknown, schema: z.ZodType<T>, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(message);
  return parsed.data;
}

function parseActiveEdition(value: unknown): ActiveEditionView {
  const parsed = EditionResponseSchema.safeParse(value);
  if (!parsed.success || !isValidActiveEditionResponse(value)) {
    throw new Error("Invalid edition response.");
  }
  return parsed.data;
}

function isOfflineQueued(response: Response): boolean {
  return response.status === 202 && response.headers.get("x-offline-queued") === "true";
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
      return parse(
        await readJson(await get(paths.session)),
        SessionResponseSchema,
        "Invalid session response.",
      );
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
      const response = await mutate(paths.progress(editionId), { position }, "PATCH");
      if (isOfflineQueued(response)) return;
      parse(await readJson(response), EditionProgressResponseSchema, "Invalid progress response.");
    },
    async complete(editionId) {
      const response = await mutate(paths.complete(editionId), {});
      if (isOfflineQueued(response)) return;
      parse(await readJson(response), EditionProgressResponseSchema, "Invalid progress response.");
    },
    async interact(input: {
      editionId: string;
      contentId: string;
      sourceId: string;
      kind: FeedbackKind;
    }) {
      const response = await mutate(paths.interaction, input);
      if (isOfflineQueued(response)) return;
      parse(await readJson(response), InteractionResponseSchema, "Invalid interaction response.");
    },
    async listKeeps() {
      const value = await readJson(await get(paths.keeps));
      return parse(value, KeepsResponseSchema, "Invalid keeps response.");
    },
    async addKeep(contentId: string) {
      const value = await readJson(await mutate(paths.keeps, { contentId }));
      return parse(value, KeepResponseSchema, "Invalid keep response.").keep;
    },
    async removeKeep(contentId: string) {
      await readNoContent(await mutate(paths.keep(contentId), undefined, "DELETE"));
    },
    async listSources() {
      const value = await readJson(await get(paths.sources));
      return parse(value, SourcesResponseSchema, "Invalid sources response.").sources;
    },
    async addSource(input) {
      const body = parse(input, SourceCreateSchema, "Invalid source request.");
      const value = await readJson(await mutate(paths.sources, body));
      return parse(value, SourceResponseSchema, "Invalid source response.").source;
    },
    async removeSource(sourceId: string) {
      await readNoContent(await mutate(paths.source(sourceId), undefined, "DELETE"));
    },
    async refreshSource(sourceId: string) {
      const value = await readJson(await mutate(paths.sourceRefresh(sourceId), {}));
      return parse(value, SourceResponseSchema, "Invalid source response.").source;
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
      const response = await assertOk(await get(paths.opml));
      const value = await response.text();
      if (!value.trim() || value.length > 2 * 1024 * 1024)
        throw new Error("Invalid OPML response.");
      return value;
    },
    async listInterests() {
      const value = await readJson(await get(paths.interests));
      return parse(value, InterestsResponseSchema, "Invalid interests response.").interests;
    },
    async listLearnedPreferences() {
      return parse(
        await readJson(await get("/api/v1/profile/learned")),
        LearnedPreferencesResponseSchema,
        "Invalid learned preferences response.",
      ).learnedAdjustments;
    },
    async addInterest(value: string) {
      const response = await readJson(await mutate(paths.interests, { value }));
      return parse(response, InterestResponseSchema, "Invalid interest response.").interest;
    },
    async removeInterest(interestId: string) {
      await readNoContent(await mutate(paths.interest(interestId), undefined, "DELETE"));
    },
    async listSuggestions() {
      const value = await readJson(await get(paths.suggestions));
      return parse(value, SuggestionsResponseSchema, "Invalid suggestions response.").suggestions;
    },
    async decideSuggestion(suggestionId: string, decision: "confirm" | "reject") {
      const body = parse({ decision }, SuggestionDecisionSchema, "Invalid suggestion decision.");
      const value = await readJson(await mutate(paths.suggestion(suggestionId), body));
      return parse(value, SuggestionResponseSchema, "Invalid suggestion response.").suggestion;
    },
    async getPreferences() {
      const value = await readJson(await get(paths.preferences));
      return parse(value, PreferencesResponseSchema, "Invalid preferences response.").preferences;
    },
    async savePreferences(preferences) {
      const body = parse(preferences, OwnerPreferencesSchema, "Invalid preferences request.");
      const value = await readJson(await mutate(paths.preferences, body, "PUT"));
      return parse(value, PreferencesResponseSchema, "Invalid preferences response.").preferences;
    },
    async exportData() {
      return parse(
        await readJson(await get(paths.export)),
        OwnerExportSchema,
        "Invalid export response.",
      );
    },
    async reset(full = false) {
      await readNoContent(
        await mutate(
          paths.reset,
          full ? { full: true, confirmation: "DELETE ALL PRIVATE DATA" } : { full: false },
        ),
      );
    },
    async logout() {
      await readNoContent(await mutate(paths.logout, undefined));
    },
  };
}
