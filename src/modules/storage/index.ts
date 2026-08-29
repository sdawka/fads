import {
  ContentEnvelopeSchema,
  InteractionEventSchema,
  type ContentEnvelope,
  type InteractionEvent,
} from "../../contracts";
import {
  InterestSuggestionSchema,
  ManualInterestSchema,
  OwnerPreferencesSchema,
  SourceSchema,
  SyncSourceMessageSchema,
  type InterestSuggestion,
  type ManualInterest,
  type OwnerPreferences,
} from "../../contracts/api";
import type { RssSyncRepository } from "../sources/rss";
import { z } from "zod";

export type OwnerSource = ReturnType<typeof SourceSchema.parse>;

export interface SourceStatusPatch {
  status: OwnerSource["status"];
  lastError?: string;
  lastSyncedAt?: string;
  updatedAt?: string;
}

export interface KeepRecord {
  ownerId: string;
  contentId: string;
  keptAt: string;
}

const TimestampSchema = z.iso.datetime({ offset: true });
const KeepRecordSchema = z
  .object({ ownerId: z.string().min(1), contentId: z.string().min(1), keptAt: TimestampSchema })
  .strict();
const SyncCursorExportSchema = z
  .object({ sourceId: z.string().min(1), cursor: z.string().nullable(), syncedAt: TimestampSchema })
  .strict();
const LearnedAdjustmentExportSchema = z
  .object({
    factor: z.string().min(1),
    adjustment: z.number(),
    provenance: z.json(),
    updatedAt: TimestampSchema,
  })
  .strict();
const SuppressionExportSchema = z
  .object({
    contentId: z.string().min(1).nullable(),
    canonicalUri: z.string().min(1).nullable(),
    until: TimestampSchema,
    createdAt: TimestampSchema,
  })
  .strict();
const EditionExportSchema = z
  .object({
    id: z.string().min(1),
    requestedAt: TimestampSchema,
    curiosity: z.int(),
    energy: z.int(),
    trace: z.json(),
    position: z.int(),
    completed: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict();
const EditionItemExportSchema = z
  .object({
    editionId: z.string().min(1),
    contentId: z.string().min(1),
    position: z.int(),
    recommendation: z.json(),
  })
  .strict();
const EditionDecisionExportSchema = z
  .object({
    editionId: z.string().min(1),
    decisionKey: z.string().min(1),
    contentId: z.string().min(1),
    canonicalUri: z.string().nullable(),
    selected: z.boolean(),
    reason: z.string().nullable(),
    trace: z.json(),
  })
  .strict();
const EditionProgressExportSchema = z
  .object({ editionId: z.string().min(1), position: z.int(), completed: z.boolean() })
  .strict();

export const OwnerExportSchema = z
  .object({
    ownerId: z.string().min(1),
    exportedAt: TimestampSchema,
    data: z
      .object({
        sources: z.array(SourceSchema),
        syncCursors: z.array(SyncCursorExportSchema),
        content: z.array(ContentEnvelopeSchema),
        interests: z.array(ManualInterestSchema),
        suggestions: z.array(InterestSuggestionSchema),
        preferences: OwnerPreferencesSchema,
        learnedAdjustments: z.array(LearnedAdjustmentExportSchema),
        suppressions: z.array(SuppressionExportSchema),
        interactions: z.array(InteractionEventSchema),
        keeps: z.array(KeepRecordSchema),
        editions: z.array(EditionExportSchema),
        editionItems: z.array(EditionItemExportSchema),
        editionDecisions: z.array(EditionDecisionExportSchema),
        progress: z.array(EditionProgressExportSchema),
      })
      .strict(),
  })
  .strict();
export type OwnerExport = z.infer<typeof OwnerExportSchema>;

export interface OwnerContentContext {
  contentId: string;
  sourceId: string;
  canonicalUri: string;
  format: string;
  tags: string[];
  labels: string[];
}

export type IdempotencyClaimResult =
  | { status: "claimed"; claimToken: string }
  | { status: "pending" }
  | { status: "completed"; response: Response }
  | { status: "conflict" };

export interface IdempotencyClaimInput {
  ownerId: string;
  scope: string;
  key: string;
  requestHash: string;
  now: string;
  expiresAt: string;
  claimToken?: string;
}

export interface IdempotencyCompleteInput {
  ownerId: string;
  scope: string;
  key: string;
  requestHash: string;
  claimToken: string;
  response: Response;
  completedAt: string;
}

export interface SourceImportResult {
  inserted: OwnerSource[];
  duplicates: Array<{ id: string; url: string; reason: "request" | "existing" }>;
}

export interface SyncWorkClaimInput {
  ownerId: string;
  sourceId: string;
  fingerprint: string;
  now: string;
  claimToken?: string;
  reclaimAfterMs?: number;
}

export type SyncWorkClaimResult =
  | { status: "claimed"; claimToken: string }
  | { status: "pending" }
  | { status: "duplicate"; outcome: "processed" | "duplicate" | "retry" | "failed" };

export interface SyncWorkCompleteInput {
  ownerId: string;
  sourceId: string;
  fingerprint: string;
  claimToken: string;
  outcome: "processed" | "duplicate" | "retry" | "failed";
  completedAt: string;
}

/** Atomic and owner-scoped seams used by the Worker API and queue consumer. */
export interface OwnerStorageHardeningRepository {
  claimIdempotency(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  completeIdempotency(input: IdempotencyCompleteInput): Promise<boolean>;
  hydrateContent(ownerId: string, contentIds: readonly string[]): Promise<ContentEnvelope[]>;
  importSourcesAtomically(ownerId: string, input: readonly OwnerSource[]): Promise<SourceImportResult>;
  upsertBootstrapSuggestions(ownerId: string, input: readonly InterestSuggestion[]): Promise<InterestSuggestion[]>;
  listConfirmedSuggestions(ownerId: string): Promise<string[]>;
  getContentContext(ownerId: string, contentId: string): Promise<OwnerContentContext | undefined>;
  validateEditionContentMembership(ownerId: string, editionId: string, contentId: string): Promise<boolean>;
  claimSyncWork(input: SyncWorkClaimInput): Promise<SyncWorkClaimResult>;
  completeSyncWork(input: SyncWorkCompleteInput): Promise<boolean>;
}

export interface OwnerCurationState {
  learnedAdjustments: Record<string, number>;
  notNow: Array<{ contentId?: string; canonicalUri?: string; until: string }>;
  recentlyShown: Array<{ contentId?: string; canonicalUri?: string; shownAt: string }>;
}

interface IdempotencyLookup {
  ownerId: string;
  scope: string;
  key: string;
  requestHash: string;
  now: string;
}

interface IdempotencySave extends Omit<IdempotencyLookup, "now"> {
  response: Response;
  createdAt: string;
  expiresAt: string;
}

export interface OwnerDataRepository {
  listSources(ownerId: string): Promise<OwnerSource[]>;
  getSource(ownerId: string, sourceId: string): Promise<OwnerSource | undefined>;
  saveSource(source: OwnerSource): Promise<OwnerSource>;
  removeSource(ownerId: string, sourceId: string): Promise<boolean>;
  setSourceStatus(
    ownerId: string,
    sourceId: string,
    patch: SourceStatusPatch,
  ): Promise<OwnerSource | undefined>;
  listInterests(ownerId: string): Promise<ManualInterest[]>;
  saveInterest(interest: ManualInterest): Promise<ManualInterest>;
  removeInterest(ownerId: string, interestId: string): Promise<boolean>;
  listSuggestions(ownerId: string): Promise<InterestSuggestion[]>;
  decideSuggestion(
    ownerId: string,
    suggestionId: string,
    decision: "confirm" | "reject",
    at: string,
  ): Promise<InterestSuggestion | undefined>;
  getPreferences(ownerId: string): Promise<OwnerPreferences>;
  savePreferences(
    ownerId: string,
    preferences: OwnerPreferences,
    updatedAt?: string,
  ): Promise<OwnerPreferences>;
  listCandidates(ownerId: string): Promise<ContentEnvelope[]>;
  getCurationState(ownerId: string): Promise<OwnerCurationState>;
  recordInteraction(event: InteractionEvent): Promise<InteractionEvent>;
  listKeeps(ownerId: string): Promise<KeepRecord[]>;
  saveKeep(keep: KeepRecord): Promise<KeepRecord>;
  removeKeep(ownerId: string, contentId: string): Promise<boolean>;
  exportOwnerData(ownerId: string): Promise<OwnerExport>;
  resetOwnerData(
    ownerId: string,
    full: boolean,
    preserveIdempotency?: { scope: string; key: string },
  ): Promise<void>;
  getIdempotentResponse(
    input: IdempotencyLookup,
  ): Promise<{ conflict: true } | { conflict: false; response: Response } | undefined>;
  saveIdempotentResponse(input: IdempotencySave): Promise<void>;
}

interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

interface Database {
  prepare(query: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}

interface SourceRow {
  id: string;
  owner_id: string;
  adapter: string;
  display_name: string;
  url: string | null;
  config_json: string;
  status: string;
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ContentRow {
  id: string;
  source_id: string;
  canonical_uri: string;
  published_at: string;
  captured_at: string;
  blocks_json: string;
  media_json: string;
}

function changes(result: unknown): number {
  return (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

function parseStoredJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseStoredHeaders(value: string): Record<string, string> {
  return z.record(z.string(), z.string()).parse(parseStoredJson(value));
}

function sourceFromRow(row: SourceRow): OwnerSource {
  return SourceSchema.parse({
    id: row.id,
    ownerId: row.owner_id,
    adapter: row.adapter,
    displayName: row.display_name,
    ...(row.url ? { url: row.url } : {}),
    config: parseStoredJson(row.config_json),
    status: row.status,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  });
}

const SOURCE_COLUMNS =
  "id, owner_id, adapter, display_name, url, config_json, status, last_error, last_synced_at, created_at, updated_at";

function canonicalSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

export class D1OwnerDataRepository
  implements OwnerDataRepository, OwnerStorageHardeningRepository
{
  constructor(private readonly db: Database) {}

  private async envelopeFromRow(row: ContentRow): Promise<ContentEnvelope> {
    const [tags, labels] = await Promise.all([
      this.db
        .prepare(
          "SELECT value, provenance_json FROM content_tags WHERE content_id = ? ORDER BY value ASC",
        )
        .bind(row.id)
        .all<{ value: string; provenance_json: string }>(),
      this.db
        .prepare(
          "SELECT value, provenance_json FROM content_labels WHERE content_id = ? ORDER BY value ASC",
        )
        .bind(row.id)
        .all<{ value: string; provenance_json: string }>(),
    ]);
    return ContentEnvelopeSchema.parse({
      id: row.id,
      canonicalUri: row.canonical_uri,
      sourceId: row.source_id,
      publishedAt: row.published_at,
      capturedAt: row.captured_at,
      blocks: parseStoredJson(row.blocks_json),
      media: parseStoredJson(row.media_json),
      tags: tags.results.map((tag) => ({
        value: tag.value,
        provenance: parseStoredJson(tag.provenance_json),
      })),
      labels: labels.results.map((label) => ({
        value: label.value,
        provenance: parseStoredJson(label.provenance_json),
      })),
    });
  }

  async listSources(ownerId: string): Promise<OwnerSource[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM sources WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`,
      )
      .bind(ownerId)
      .all<SourceRow>();
    return rows.results.map(sourceFromRow);
  }

  async getSource(ownerId: string, sourceId: string): Promise<OwnerSource | undefined> {
    const row = await this.db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM sources WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .bind(ownerId, sourceId)
      .first<SourceRow>();
    return row ? sourceFromRow(row) : undefined;
  }

  async saveSource(input: OwnerSource): Promise<OwnerSource> {
    const parsed = SourceSchema.parse(input);
    const source = SourceSchema.parse({
      ...parsed,
      ...(parsed.url ? { url: canonicalSourceUrl(parsed.url) } : {}),
    });
    await this.db
      .prepare(
        "INSERT INTO sources (id, owner_id, adapter, display_name, url, config_json, status, last_error, last_synced_at, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET adapter = excluded.adapter, display_name = excluded.display_name, url = excluded.url, config_json = excluded.config_json, status = excluded.status, last_error = excluded.last_error, last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at, deleted_at = NULL WHERE sources.owner_id = excluded.owner_id",
      )
      .bind(
        source.id,
        source.ownerId,
        source.adapter,
        source.displayName,
        source.url ?? null,
        JSON.stringify(source.config),
        source.status,
        source.lastError ?? null,
        source.lastSyncedAt ?? null,
        source.createdAt,
        source.updatedAt,
      )
      .run();
    const stored = await this.getSource(source.ownerId, source.id);
    if (!stored) throw new Error("Source identifier is already owned by another account");
    return stored;
  }

  async importSourcesAtomically(
    ownerId: string,
    input: readonly OwnerSource[],
  ): Promise<SourceImportResult> {
    const parsed = input.map((candidate) => {
      const source = SourceSchema.parse(candidate);
      if (source.ownerId !== ownerId || source.adapter !== "rss" || !source.url) {
        throw new Error("Imported source does not belong to owner");
      }
      return SourceSchema.parse({ ...source, url: canonicalSourceUrl(source.url) });
    });
    const ids = parsed.map((source) => source.id);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      const collision = await this.db
        .prepare(`SELECT id FROM sources WHERE id IN (${placeholders}) AND owner_id <> ? LIMIT 1`)
        .bind(...ids, ownerId)
        .first<{ id: string }>();
      if (collision) throw new Error("Source identifier is already owned by another account");
    }
    const existing = new Set(
      (await this.listSources(ownerId)).flatMap((source) =>
        source.url ? [canonicalSourceUrl(source.url)] : [],
      ),
    );
    const requestUrls = new Set<string>();
    const inserted: OwnerSource[] = [];
    const duplicates: Array<{ id: string; url: string; reason: "request" | "existing" }> = [];
    for (const source of parsed) {
      const url = source.url!;
      if (requestUrls.has(url)) {
        duplicates.push({ id: source.id, url, reason: "request" });
      } else if (existing.has(url)) {
        duplicates.push({ id: source.id, url, reason: "existing" });
      } else {
        requestUrls.add(url);
        inserted.push(source);
      }
    }
    if (inserted.length) {
      await this.db.batch(
        inserted.map((source) =>
          this.db
            .prepare(
              "INSERT INTO sources (id, owner_id, adapter, display_name, url, config_json, status, last_error, last_synced_at, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
            )
            .bind(
              source.id,
              source.ownerId,
              source.adapter,
              source.displayName,
              source.url,
              JSON.stringify(source.config),
              source.status,
              source.lastError ?? null,
              source.lastSyncedAt ?? null,
              source.createdAt,
              source.updatedAt,
            ),
        ),
      );
    }
    return { inserted, duplicates };
  }

  async removeSource(ownerId: string, sourceId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE sources SET deleted_at = updated_at WHERE owner_id = ? AND id = ? AND deleted_at IS NULL",
      )
      .bind(ownerId, sourceId)
      .run();
    return changes(result) > 0;
  }

  async setSourceStatus(
    ownerId: string,
    sourceId: string,
    patch: SourceStatusPatch,
  ): Promise<OwnerSource | undefined> {
    const current = await this.getSource(ownerId, sourceId);
    if (!current) return undefined;
    return this.saveSource(
      SourceSchema.parse({
        ...current,
        status: patch.status,
        ...(patch.lastError ? { lastError: patch.lastError } : { lastError: undefined }),
        ...(patch.lastSyncedAt ? { lastSyncedAt: patch.lastSyncedAt } : {}),
        updatedAt: patch.updatedAt ?? patch.lastSyncedAt ?? current.updatedAt,
      }),
    );
  }

  async listInterests(ownerId: string): Promise<ManualInterest[]> {
    const rows = await this.db
      .prepare(
        "SELECT id, owner_id, value, created_at FROM manual_interests WHERE owner_id = ? ORDER BY created_at ASC, id ASC",
      )
      .bind(ownerId)
      .all<{ id: string; owner_id: string; value: string; created_at: string }>();
    return rows.results.map((row) =>
      ManualInterestSchema.parse({
        id: row.id,
        ownerId: row.owner_id,
        value: row.value,
        createdAt: row.created_at,
      }),
    );
  }

  async saveInterest(input: ManualInterest): Promise<ManualInterest> {
    const interest = ManualInterestSchema.parse(input);
    const provenance = { source: "manual", observedAt: interest.createdAt };
    await this.db
      .prepare(
        "INSERT INTO manual_interests (id, owner_id, value, provenance_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value WHERE manual_interests.owner_id = excluded.owner_id",
      )
      .bind(
        interest.id,
        interest.ownerId,
        interest.value,
        JSON.stringify(provenance),
        interest.createdAt,
      )
      .run();
    return interest;
  }

  async removeInterest(ownerId: string, interestId: string): Promise<boolean> {
    return (
      changes(
        await this.db
          .prepare("DELETE FROM manual_interests WHERE owner_id = ? AND id = ?")
          .bind(ownerId, interestId)
          .run(),
      ) > 0
    );
  }

  async listSuggestions(ownerId: string): Promise<InterestSuggestion[]> {
    const rows = await this.db
      .prepare(
        "SELECT owner_id, id, value, evidence_count, provenance_json, status, created_at, decided_at FROM interest_suggestions WHERE owner_id = ? ORDER BY created_at ASC, id ASC",
      )
      .bind(ownerId)
      .all<Record<string, unknown>>();
    return rows.results.map((row) =>
      InterestSuggestionSchema.parse({
        ownerId: row.owner_id,
        id: row.id,
        value: row.value,
        evidenceCount: row.evidence_count,
        provenance: parseStoredJson(String(row.provenance_json)),
        status: row.status,
        createdAt: row.created_at,
        ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
      }),
    );
  }

  async upsertBootstrapSuggestions(
    ownerId: string,
    input: readonly InterestSuggestion[],
  ): Promise<InterestSuggestion[]> {
    const suggestions = input.map((candidate) => {
      const suggestion = InterestSuggestionSchema.parse(candidate);
      if (suggestion.ownerId !== ownerId) throw new Error("Suggestion does not belong to owner");
      return suggestion;
    });
    if (suggestions.length) {
      await this.db.batch(
        suggestions.map((suggestion) =>
          this.db
            .prepare(
              "INSERT INTO interest_suggestions (owner_id, id, value, evidence_count, provenance_json, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, id) DO UPDATE SET value = excluded.value, evidence_count = excluded.evidence_count, provenance_json = excluded.provenance_json WHERE interest_suggestions.status = 'pending'",
            )
            .bind(
              ownerId,
              suggestion.id,
              suggestion.value,
              suggestion.evidenceCount,
              JSON.stringify(suggestion.provenance),
              suggestion.status,
              suggestion.createdAt,
              suggestion.decidedAt ?? null,
            ),
        ),
      );
    }
    return this.listSuggestions(ownerId);
  }

  async listConfirmedSuggestions(ownerId: string): Promise<string[]> {
    const rows = await this.db
      .prepare(
        "SELECT value FROM interest_suggestions WHERE owner_id = ? AND status = 'confirmed' ORDER BY decided_at ASC, id ASC",
      )
      .bind(ownerId)
      .all<{ value: string }>();
    return rows.results.map((row) => row.value);
  }

  async decideSuggestion(
    ownerId: string,
    suggestionId: string,
    decision: "confirm" | "reject",
    at: string,
  ): Promise<InterestSuggestion | undefined> {
    await this.db
      .prepare(
        "UPDATE interest_suggestions SET status = ?, decided_at = ? WHERE owner_id = ? AND id = ? AND status = 'pending'",
      )
      .bind(decision === "confirm" ? "confirmed" : "rejected", at, ownerId, suggestionId)
      .run();
    return (await this.listSuggestions(ownerId)).find((item) => item.id === suggestionId);
  }

  async getPreferences(ownerId: string): Promise<OwnerPreferences> {
    const row = await this.db
      .prepare("SELECT preferences_json FROM owner_preferences WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ preferences_json: string }>();
    const stored = row
      ? OwnerPreferencesSchema.parse(parseStoredJson(row.preferences_json))
      : { blockedLabels: [], mutedSourceIds: [] };
    const muted = await this.db
      .prepare(
        "SELECT source_id FROM owner_muted_sources WHERE owner_id = ? ORDER BY source_id ASC",
      )
      .bind(ownerId)
      .all<{ source_id: string }>();
    return { ...stored, mutedSourceIds: muted.results.map((item) => item.source_id) };
  }

  async savePreferences(
    ownerId: string,
    input: OwnerPreferences,
    updatedAt = new Date().toISOString(),
  ): Promise<OwnerPreferences> {
    const preferences = OwnerPreferencesSchema.parse(input);
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO owner_preferences (owner_id, preferences_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET preferences_json = excluded.preferences_json, updated_at = excluded.updated_at",
        )
        .bind(ownerId, JSON.stringify({ ...preferences, mutedSourceIds: [] }), updatedAt),
      this.db.prepare("DELETE FROM owner_muted_sources WHERE owner_id = ?").bind(ownerId),
      ...preferences.mutedSourceIds.map((sourceId) =>
        this.db
          .prepare(
            "INSERT INTO owner_muted_sources (owner_id, source_id, muted_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM sources WHERE owner_id = ? AND id = ?)",
          )
          .bind(ownerId, sourceId, updatedAt, ownerId, sourceId),
      ),
    ]);
    return preferences;
  }

  async listCandidates(ownerId: string): Promise<ContentEnvelope[]> {
    const rows = await this.db
      .prepare(
        "SELECT ci.id, ci.source_id, ci.canonical_uri, ci.published_at, ci.captured_at, ci.blocks_json, ci.media_json FROM content_items ci JOIN sources s ON s.id = ci.source_id WHERE s.owner_id = ? AND s.deleted_at IS NULL ORDER BY ci.published_at DESC, ci.id ASC",
      )
      .bind(ownerId)
      .all<ContentRow>();
    return Promise.all(rows.results.map((row) => this.envelopeFromRow(row)));
  }

  async hydrateContent(ownerId: string, contentIds: readonly string[]): Promise<ContentEnvelope[]> {
    if (contentIds.length > 12) throw new Error("At most twelve content items can be hydrated");
    if (!contentIds.length) return [];
    const uniqueIds = [...new Set(contentIds)];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = await this.db
      .prepare(
        `SELECT ci.id, ci.source_id, ci.canonical_uri, ci.published_at, ci.captured_at, ci.blocks_json, ci.media_json FROM content_items ci JOIN sources s ON s.id = ci.source_id WHERE s.owner_id = ? AND s.deleted_at IS NULL AND ci.id IN (${placeholders})`,
      )
      .bind(ownerId, ...uniqueIds)
      .all<ContentRow>();
    const byId = new Map(
      await Promise.all(
        rows.results.map(async (row) => [row.id, await this.envelopeFromRow(row)] as const),
      ),
    );
    return contentIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }

  async getContentContext(
    ownerId: string,
    contentId: string,
  ): Promise<OwnerContentContext | undefined> {
    const [item] = await this.hydrateContent(ownerId, [contentId]);
    if (!item) return undefined;
    return {
      contentId: item.id,
      sourceId: item.sourceId,
      canonicalUri: item.canonicalUri,
      format: item.blocks[0]?.kind ?? "unknown",
      tags: item.tags.map((tag) => tag.value),
      labels: item.labels.map((label) => label.value),
    };
  }

  async validateEditionContentMembership(
    ownerId: string,
    editionId: string,
    contentId: string,
  ): Promise<boolean> {
    return Boolean(
      await this.db
        .prepare(
          "SELECT 1 AS present FROM edition_items WHERE owner_id = ? AND edition_id = ? AND content_id = ?",
        )
        .bind(ownerId, editionId, contentId)
        .first(),
    );
  }

  async getCurationState(ownerId: string): Promise<OwnerCurationState> {
    const adjustments = await this.db
      .prepare(
        "SELECT factor, adjustment FROM learned_adjustments WHERE owner_id = ? ORDER BY factor ASC",
      )
      .bind(ownerId)
      .all<{ factor: string; adjustment: number }>();
    const suppressions = await this.db
      .prepare(
        "SELECT content_id, canonical_uri, until_at FROM content_suppressions WHERE owner_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .bind(ownerId)
      .all<{ content_id: string | null; canonical_uri: string | null; until_at: string }>();
    const shown = await this.db
      .prepare(
        "SELECT ei.content_id, ci.canonical_uri, e.created_at FROM edition_items ei JOIN editions e ON e.owner_id = ei.owner_id AND e.id = ei.edition_id LEFT JOIN content_items ci ON ci.id = ei.content_id WHERE ei.owner_id = ? ORDER BY e.created_at ASC, ei.position ASC",
      )
      .bind(ownerId)
      .all<{ content_id: string; canonical_uri: string | null; created_at: string }>();
    return {
      learnedAdjustments: Object.fromEntries(
        adjustments.results.map((row) => [row.factor, row.adjustment]),
      ),
      notNow: suppressions.results.map((row) => ({
        ...(row.content_id ? { contentId: row.content_id } : {}),
        ...(row.canonical_uri ? { canonicalUri: row.canonical_uri } : {}),
        until: row.until_at,
      })),
      recentlyShown: shown.results.map((row) => ({
        contentId: row.content_id,
        ...(row.canonical_uri ? { canonicalUri: row.canonical_uri } : {}),
        shownAt: row.created_at,
      })),
    };
  }

  async recordInteraction(input: InteractionEvent): Promise<InteractionEvent> {
    const event = InteractionEventSchema.parse(input);
    const context = event.contentId
      ? await this.getContentContext(event.ownerId, event.contentId)
      : undefined;
    if (event.contentId && !context) throw new Error("Content not found for owner");
    if (event.sourceId && !(await this.getSource(event.ownerId, event.sourceId))) {
      throw new Error("Source not found for owner");
    }
    if (context && event.sourceId && context.sourceId !== event.sourceId) {
      throw new Error("Content does not belong to source");
    }
    const existing = await this.db
      .prepare("SELECT owner_id FROM interactions WHERE id = ?")
      .bind(event.id)
      .first<{ owner_id: string }>();
    if (existing && existing.owner_id !== event.ownerId) {
      throw new Error("Interaction identifier is already owned by another account");
    }
    const statements: Statement[] = [];
    const delta =
      event.kind === "more_like_this"
        ? 1
        : event.kind === "less_like_this"
          ? -1
          : event.kind === "good_surprise"
            ? 0.5
            : 0;
    const factors = [
      ...new Set([
        ...(event.contentId ? [`content:${event.contentId}`] : []),
        ...(event.sourceId ? [`source:${event.sourceId}`] : []),
      ]),
    ];
    for (const factor of delta ? factors : []) {
      const adjustmentId = `${event.ownerId}\u0000${factor}`;
      statements.push(
        this.db
          .prepare(
            "INSERT INTO learned_adjustments (id, owner_id, factor, adjustment, provenance_json, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM interactions WHERE id = ?) ON CONFLICT(id) DO UPDATE SET adjustment = learned_adjustments.adjustment + excluded.adjustment, provenance_json = excluded.provenance_json, updated_at = excluded.updated_at",
          )
          .bind(
            adjustmentId,
            event.ownerId,
            factor,
            delta,
            JSON.stringify(event.provenance),
            event.occurredAt,
            event.id,
          ),
      );
    }
    if (event.kind === "not_now" && event.contentId) {
      const canonical = await this.db
        .prepare(
          "SELECT canonical_uri FROM content_items ci JOIN sources s ON s.id = ci.source_id WHERE s.owner_id = ? AND ci.id = ?",
        )
        .bind(event.ownerId, event.contentId)
        .first<{ canonical_uri: string }>();
      const until = new Date(
        new Date(event.occurredAt).getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      statements.push(
        this.db
          .prepare(
            "INSERT INTO content_suppressions (owner_id, content_id, canonical_uri, until_at, created_at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM interactions WHERE id = ?)",
          )
          .bind(
            event.ownerId,
            event.contentId,
            canonical?.canonical_uri ?? null,
            until,
            event.occurredAt,
            event.id,
          ),
      );
    }
    if (event.kind === "mute_source" && event.sourceId) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO owner_muted_sources (owner_id, source_id, muted_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM interactions WHERE id = ?) AND EXISTS (SELECT 1 FROM sources WHERE owner_id = ? AND id = ?) ON CONFLICT(owner_id, source_id) DO NOTHING",
          )
          .bind(
            event.ownerId,
            event.sourceId,
            event.occurredAt,
            event.id,
            event.ownerId,
            event.sourceId,
          ),
      );
    }
    if (event.kind === "keep" && event.contentId) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO keeps (owner_id, content_id, kept_at) SELECT ?, ci.id, ? FROM content_items ci JOIN sources s ON s.id = ci.source_id WHERE ci.id = ? AND s.owner_id = ? AND NOT EXISTS (SELECT 1 FROM interactions WHERE id = ?) ON CONFLICT(owner_id, content_id) DO NOTHING",
          )
          .bind(event.ownerId, event.occurredAt, event.contentId, event.ownerId, event.id),
      );
    }
    statements.push(
      this.db
        .prepare(
          "INSERT INTO interactions (id, owner_id, content_id, source_id, kind, occurred_at, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(
          event.id,
          event.ownerId,
          event.contentId ?? null,
          event.sourceId ?? null,
          event.kind,
          event.occurredAt,
          JSON.stringify(event.provenance),
        ),
    );
    await this.db.batch(statements);
    return event;
  }

  async listKeeps(ownerId: string): Promise<KeepRecord[]> {
    const rows = await this.db
      .prepare(
        "SELECT owner_id, content_id, kept_at FROM keeps WHERE owner_id = ? ORDER BY kept_at DESC, content_id ASC",
      )
      .bind(ownerId)
      .all<{ owner_id: string; content_id: string; kept_at: string }>();
    return rows.results.map((row) => ({
      ownerId: row.owner_id,
      contentId: row.content_id,
      keptAt: row.kept_at,
    }));
  }

  async saveKeep(keep: KeepRecord): Promise<KeepRecord> {
    const result = await this.db
      .prepare(
        "INSERT INTO keeps (owner_id, content_id, kept_at) SELECT ?, ci.id, ? FROM content_items ci JOIN sources s ON s.id = ci.source_id WHERE ci.id = ? AND s.owner_id = ? ON CONFLICT(owner_id, content_id) DO UPDATE SET kept_at = excluded.kept_at",
      )
      .bind(keep.ownerId, keep.keptAt, keep.contentId, keep.ownerId)
      .run();
    if (changes(result) === 0) throw new Error("Content not found for owner");
    return keep;
  }

  async removeKeep(ownerId: string, contentId: string): Promise<boolean> {
    return (
      changes(
        await this.db
          .prepare("DELETE FROM keeps WHERE owner_id = ? AND content_id = ?")
          .bind(ownerId, contentId)
          .run(),
      ) > 0
    );
  }

  async exportOwnerData(ownerId: string): Promise<OwnerExport> {
    const [
      sources,
      syncCursors,
      content,
      interests,
      suggestions,
      preferences,
      learnedAdjustments,
      suppressions,
      interactions,
      keeps,
      editions,
      editionItems,
      editionDecisions,
    ] = await Promise.all([
      this.listSources(ownerId),
      this.db
        .prepare(
          "SELECT sc.source_id, sc.cursor, sc.synced_at FROM sync_cursors sc JOIN sources s ON s.id = sc.source_id WHERE s.owner_id = ? ORDER BY sc.source_id ASC",
        )
        .bind(ownerId)
        .all<{ source_id: string; cursor: string | null; synced_at: string }>(),
      this.listCandidates(ownerId),
      this.listInterests(ownerId),
      this.listSuggestions(ownerId),
      this.getPreferences(ownerId),
      this.db
        .prepare(
          "SELECT factor, adjustment, provenance_json, updated_at FROM learned_adjustments WHERE owner_id = ? ORDER BY factor ASC",
        )
        .bind(ownerId)
        .all<{ factor: string; adjustment: number; provenance_json: string; updated_at: string }>(),
      this.db
        .prepare(
          "SELECT content_id, canonical_uri, until_at, created_at FROM content_suppressions WHERE owner_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .bind(ownerId)
        .all<{
          content_id: string | null;
          canonical_uri: string | null;
          until_at: string;
          created_at: string;
        }>(),
      this.db
        .prepare(
          "SELECT id, owner_id, content_id, source_id, kind, occurred_at, provenance_json FROM interactions WHERE owner_id = ? ORDER BY occurred_at ASC, id ASC",
        )
        .bind(ownerId)
        .all<{
          id: string;
          owner_id: string;
          content_id: string | null;
          source_id: string | null;
          kind: string;
          occurred_at: string;
          provenance_json: string;
        }>(),
      this.listKeeps(ownerId),
      this.db
        .prepare(
          "SELECT id, requested_at, curiosity, energy, trace_json, position, completed, created_at FROM editions WHERE owner_id = ? ORDER BY created_at ASC, id ASC",
        )
        .bind(ownerId)
        .all<{
          id: string;
          requested_at: string;
          curiosity: number;
          energy: number;
          trace_json: string;
          position: number;
          completed: number;
          created_at: string;
        }>(),
      this.db
        .prepare(
          "SELECT edition_id, content_id, position, recommendation_json FROM edition_items WHERE owner_id = ? ORDER BY edition_id ASC, position ASC",
        )
        .bind(ownerId)
        .all<{
          edition_id: string;
          content_id: string;
          position: number;
          recommendation_json: string;
        }>(),
      this.db
        .prepare(
          "SELECT edition_id, decision_key, content_id, canonical_uri, selected, reason, trace_json FROM edition_decisions WHERE owner_id = ? ORDER BY edition_id ASC, decision_key ASC",
        )
        .bind(ownerId)
        .all<{
          edition_id: string;
          decision_key: string;
          content_id: string;
          canonical_uri: string | null;
          selected: number;
          reason: string | null;
          trace_json: string;
        }>(),
    ]);
    return OwnerExportSchema.parse({
      ownerId,
      exportedAt: new Date().toISOString(),
      data: {
        sources,
        syncCursors: syncCursors.results.map((row) => ({
          sourceId: row.source_id,
          cursor: row.cursor,
          syncedAt: row.synced_at,
        })),
        content,
        interests,
        suggestions,
        preferences,
        learnedAdjustments: learnedAdjustments.results.map((row) => ({
          factor: row.factor,
          adjustment: row.adjustment,
          provenance: parseStoredJson(row.provenance_json),
          updatedAt: row.updated_at,
        })),
        suppressions: suppressions.results.map((row) => ({
          contentId: row.content_id,
          canonicalUri: row.canonical_uri,
          until: row.until_at,
          createdAt: row.created_at,
        })),
        interactions: interactions.results.map((row) =>
          InteractionEventSchema.parse({
            id: row.id,
            ownerId: row.owner_id,
            ...(row.content_id ? { contentId: row.content_id } : {}),
            ...(row.source_id ? { sourceId: row.source_id } : {}),
            kind: row.kind,
            occurredAt: row.occurred_at,
            provenance: parseStoredJson(row.provenance_json),
          }),
        ),
        keeps,
        editions: editions.results.map((row) => ({
          id: row.id,
          requestedAt: row.requested_at,
          curiosity: row.curiosity,
          energy: row.energy,
          trace: parseStoredJson(row.trace_json),
          position: row.position,
          completed: Boolean(row.completed),
          createdAt: row.created_at,
        })),
        editionItems: editionItems.results.map((row) => ({
          editionId: row.edition_id,
          contentId: row.content_id,
          position: row.position,
          recommendation: parseStoredJson(row.recommendation_json),
        })),
        editionDecisions: editionDecisions.results.map((row) => ({
          editionId: row.edition_id,
          decisionKey: row.decision_key,
          contentId: row.content_id,
          canonicalUri: row.canonical_uri,
          selected: Boolean(row.selected),
          reason: row.reason,
          trace: parseStoredJson(row.trace_json),
        })),
        progress: editions.results.map((row) => ({
          editionId: row.id,
          position: row.position,
          completed: Boolean(row.completed),
        })),
      },
    });
  }

  async resetOwnerData(
    ownerId: string,
    full: boolean,
    preserveIdempotency?: { scope: string; key: string },
  ): Promise<void> {
    if (!full) {
      await this.db.batch([
        this.db.prepare("DELETE FROM learned_adjustments WHERE owner_id = ?").bind(ownerId),
        this.db.prepare("DELETE FROM content_suppressions WHERE owner_id = ?").bind(ownerId),
        this.db.prepare("DELETE FROM owner_muted_sources WHERE owner_id = ?").bind(ownerId),
      ]);
      return;
    }
    const deleteIdempotency = preserveIdempotency
      ? this.db
          .prepare(
            "DELETE FROM api_idempotency WHERE owner_id = ? AND NOT (scope = ? AND key = ?)",
          )
          .bind(ownerId, preserveIdempotency.scope, preserveIdempotency.key)
      : this.db.prepare("DELETE FROM api_idempotency WHERE owner_id = ?").bind(ownerId);
    await this.db.batch([
      this.db.prepare("DELETE FROM keeps WHERE owner_id = ?").bind(ownerId),
      this.db.prepare("DELETE FROM interactions WHERE owner_id = ?").bind(ownerId),
      this.db.prepare("DELETE FROM editions WHERE owner_id = ?").bind(ownerId),
      this.db.prepare("DELETE FROM learned_adjustments WHERE owner_id = ?").bind(ownerId),
      this.db.prepare("DELETE FROM manual_interests WHERE owner_id = ?").bind(ownerId),
      this.db.prepare("DELETE FROM interest_suggestions WHERE owner_id = ?").bind(ownerId),
      this.db.prepare("DELETE FROM owner_preferences WHERE owner_id = ?").bind(ownerId),
      this.db.prepare("DELETE FROM owner_muted_sources WHERE owner_id = ?").bind(ownerId),
      this.db.prepare("DELETE FROM content_suppressions WHERE owner_id = ?").bind(ownerId),
      deleteIdempotency,
      this.db
        .prepare(
          "DELETE FROM content_items WHERE source_id IN (SELECT id FROM sources WHERE owner_id = ?)",
        )
        .bind(ownerId),
      this.db.prepare("DELETE FROM sources WHERE owner_id = ?").bind(ownerId),
    ]);
  }

  async claimIdempotency(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const claimToken = input.claimToken ?? crypto.randomUUID();
    await this.db
      .prepare(
        "INSERT INTO api_idempotency (owner_id, scope, key, request_hash, response_status, response_headers_json, response_body, created_at, expires_at, state, claim_token, claimed_at, completed_at) VALUES (?, ?, ?, ?, 0, '{}', '', ?, ?, 'pending', ?, ?, NULL) ON CONFLICT(owner_id, scope, key) DO UPDATE SET request_hash = excluded.request_hash, response_status = 0, response_headers_json = '{}', response_body = '', created_at = excluded.created_at, expires_at = excluded.expires_at, state = 'pending', claim_token = excluded.claim_token, claimed_at = excluded.claimed_at, completed_at = NULL WHERE api_idempotency.expires_at <= excluded.claimed_at",
      )
      .bind(
        input.ownerId,
        input.scope,
        input.key,
        input.requestHash,
        input.now,
        input.expiresAt,
        claimToken,
        input.now,
      )
      .run();
    const row = await this.db
      .prepare(
        "SELECT request_hash, response_status, response_headers_json, response_body, state, claim_token FROM api_idempotency WHERE owner_id = ? AND scope = ? AND key = ?",
      )
      .bind(input.ownerId, input.scope, input.key)
      .first<{
        request_hash: string;
        response_status: number;
        response_headers_json: string;
        response_body: string;
        state: string;
        claim_token: string | null;
      }>();
    if (!row) throw new Error("Idempotency claim was not persisted");
    if (row.request_hash !== input.requestHash) return { status: "conflict" };
    if (row.state === "completed") {
      return {
        status: "completed",
        response: new Response(row.response_body || null, {
          status: row.response_status,
          headers: parseStoredHeaders(row.response_headers_json),
        }),
      };
    }
    return row.claim_token === claimToken
      ? { status: "claimed", claimToken }
      : { status: "pending" };
  }

  async completeIdempotency(input: IdempotencyCompleteInput): Promise<boolean> {
    const response = input.response.clone();
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "location"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    const result = await this.db
      .prepare(
        "UPDATE api_idempotency SET response_status = ?, response_headers_json = ?, response_body = ?, state = 'completed', completed_at = ? WHERE owner_id = ? AND scope = ? AND key = ? AND request_hash = ? AND claim_token = ? AND state = 'pending'",
      )
      .bind(
        response.status,
        JSON.stringify(headers),
        await response.text(),
        input.completedAt,
        input.ownerId,
        input.scope,
        input.key,
        input.requestHash,
        input.claimToken,
      )
      .run();
    return changes(result) > 0;
  }

  async getIdempotentResponse(
    input: IdempotencyLookup,
  ): Promise<{ conflict: true } | { conflict: false; response: Response } | undefined> {
    const row = await this.db
      .prepare(
        "SELECT request_hash, response_status, response_headers_json, response_body FROM api_idempotency WHERE owner_id = ? AND scope = ? AND key = ? AND expires_at > ? AND state = 'completed'",
      )
      .bind(input.ownerId, input.scope, input.key, input.now)
      .first<{
        request_hash: string;
        response_status: number;
        response_headers_json: string;
        response_body: string;
      }>();
    if (!row) return undefined;
    if (row.request_hash !== input.requestHash) return { conflict: true };
    return {
      conflict: false,
      response: new Response(row.response_body || null, {
        status: row.response_status,
        headers: parseStoredHeaders(row.response_headers_json),
      }),
    };
  }

  async saveIdempotentResponse(input: IdempotencySave): Promise<void> {
    const response = input.response.clone();
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "location"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    await this.db
      .prepare(
        "INSERT INTO api_idempotency (owner_id, scope, key, request_hash, response_status, response_headers_json, response_body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, scope, key) DO NOTHING",
      )
      .bind(
        input.ownerId,
        input.scope,
        input.key,
        input.requestHash,
        response.status,
        JSON.stringify(headers),
        await response.text(),
        input.createdAt,
        input.expiresAt,
      )
      .run();
  }

  async claimSyncWork(input: SyncWorkClaimInput): Promise<SyncWorkClaimResult> {
    if (!(await this.getSource(input.ownerId, input.sourceId))) throw new Error("Source not found");
    const claimToken = input.claimToken ?? crypto.randomUUID();
    const reclaimBefore = new Date(
      new Date(input.now).getTime() - (input.reclaimAfterMs ?? 15 * 60 * 1000),
    ).toISOString();
    await this.db
      .prepare(
        "INSERT INTO source_sync_work (owner_id, source_id, fingerprint, state, claim_token, claimed_at, outcome, completed_at) VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL) ON CONFLICT(owner_id, source_id, fingerprint) DO UPDATE SET state = 'pending', claim_token = excluded.claim_token, claimed_at = excluded.claimed_at, outcome = NULL, completed_at = NULL WHERE source_sync_work.state = 'pending' AND source_sync_work.claimed_at <= ?",
      )
      .bind(input.ownerId, input.sourceId, input.fingerprint, claimToken, input.now, reclaimBefore)
      .run();
    const row = await this.db
      .prepare(
        "SELECT state, claim_token, outcome FROM source_sync_work WHERE owner_id = ? AND source_id = ? AND fingerprint = ?",
      )
      .bind(input.ownerId, input.sourceId, input.fingerprint)
      .first<{
        state: string;
        claim_token: string;
        outcome: "processed" | "duplicate" | "retry" | "failed" | null;
      }>();
    if (!row) throw new Error("Queue work claim was not persisted");
    if (row.state === "completed") {
      if (!row.outcome) throw new Error("Completed queue work has no outcome");
      return { status: "duplicate", outcome: row.outcome };
    }
    return row.claim_token === claimToken
      ? { status: "claimed", claimToken }
      : { status: "pending" };
  }

  async completeSyncWork(input: SyncWorkCompleteInput): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE source_sync_work SET state = 'completed', outcome = ?, completed_at = ? WHERE owner_id = ? AND source_id = ? AND fingerprint = ? AND claim_token = ? AND state = 'pending'",
      )
      .bind(
        input.outcome,
        input.completedAt,
        input.ownerId,
        input.sourceId,
        input.fingerprint,
        input.claimToken,
      )
      .run();
    return changes(result) > 0;
  }

  rssSyncRepository(
    ownerId: string,
    expectedSourceId: string,
    now: () => string = () => new Date().toISOString(),
  ): RssSyncRepository {
    const assertSource = async (sourceId: string) => {
      if (sourceId !== expectedSourceId || !(await this.getSource(ownerId, sourceId)))
        throw new Error("Source not found");
    };
    return {
      loadCursor: async ({ sourceId }) => {
        await assertSource(sourceId);
        return (
          (
            await this.db
              .prepare(
                "SELECT sc.cursor FROM sync_cursors sc JOIN sources s ON s.id = sc.source_id WHERE s.owner_id = ? AND sc.source_id = ?",
              )
              .bind(ownerId, sourceId)
              .first<{ cursor: string | null }>()
          )?.cursor ?? undefined
        );
      },
      isKnownContent: async ({ id, canonicalUri }) =>
        Boolean(
          await this.db
            .prepare(
              "SELECT ci.id FROM content_items ci JOIN sources s ON s.id = ci.source_id WHERE s.owner_id = ? AND (ci.id = ? OR ci.canonical_uri = ?)",
            )
            .bind(ownerId, id, canonicalUri)
            .first(),
        ),
      commitSync: async ({ sourceId, items, nextCursor }) => {
        await assertSource(sourceId);
        const captured = items.map((item) => ContentEnvelopeSchema.parse(item));
        if (captured.some((item) => item.sourceId !== sourceId))
          throw new Error("Content source does not match sync source");
        if (new Set(captured.map((item) => item.id)).size !== captured.length) {
          throw new Error("Duplicate content identifier in sync batch");
        }
        if (new Set(captured.map((item) => item.canonicalUri)).size !== captured.length) {
          throw new Error("Duplicate canonical URI in sync batch");
        }
        if (captured.length) {
          const idPlaceholders = captured.map(() => "?").join(", ");
          const idCollision = await this.db
            .prepare(
              `SELECT id FROM content_items WHERE id IN (${idPlaceholders}) AND source_id <> ? LIMIT 1`,
            )
            .bind(...captured.map((item) => item.id), sourceId)
            .first<{ id: string }>();
          if (idCollision) throw new Error("Content identifier belongs to another source");
          const uriPlaceholders = captured.map(() => "?").join(", ");
          const uriRows = await this.db
            .prepare(
              `SELECT id, source_id, canonical_uri FROM content_items WHERE canonical_uri IN (${uriPlaceholders})`,
            )
            .bind(...captured.map((item) => item.canonicalUri))
            .all<{ id: string; source_id: string; canonical_uri: string }>();
          const expectedByUri = new Map(captured.map((item) => [item.canonicalUri, item.id]));
          if (
            uriRows.results.some(
              (row) =>
                row.source_id !== sourceId || expectedByUri.get(row.canonical_uri) !== row.id,
            )
          ) {
            throw new Error("Canonical URI belongs to another content item");
          }
        }
        const statements: Statement[] = [];
        for (const item of captured) {
          statements.push(
            this.db
              .prepare(
                "INSERT INTO content_items (id, source_id, canonical_uri, published_at, captured_at, blocks_json, media_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at, captured_at = excluded.captured_at, blocks_json = excluded.blocks_json, media_json = excluded.media_json WHERE content_items.source_id = excluded.source_id",
              )
              .bind(
                item.id,
                sourceId,
                item.canonicalUri,
                item.publishedAt,
                item.capturedAt,
                JSON.stringify(item.blocks),
                JSON.stringify(item.media),
              ),
          );
          statements.push(
            this.db
              .prepare(
                "DELETE FROM content_tags WHERE content_id = ? AND EXISTS (SELECT 1 FROM content_items WHERE id = ? AND source_id = ?)",
              )
              .bind(item.id, item.id, sourceId),
          );
          statements.push(
            this.db
              .prepare(
                "DELETE FROM content_labels WHERE content_id = ? AND EXISTS (SELECT 1 FROM content_items WHERE id = ? AND source_id = ?)",
              )
              .bind(item.id, item.id, sourceId),
          );
          for (const tag of item.tags)
            statements.push(
              this.db
                .prepare(
                  "INSERT INTO content_tags (content_id, value, provenance_json) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND source_id = ?)",
                )
                .bind(item.id, tag.value, JSON.stringify(tag.provenance), item.id, sourceId),
            );
          for (const label of item.labels)
            statements.push(
              this.db
                .prepare(
                  "INSERT INTO content_labels (content_id, value, provenance_json) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND source_id = ?)",
                )
                .bind(item.id, label.value, JSON.stringify(label.provenance), item.id, sourceId),
            );
        }
        if (nextCursor !== undefined)
          statements.push(
            this.db
              .prepare(
                "INSERT INTO sync_cursors (source_id, cursor, synced_at) VALUES (?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET cursor = excluded.cursor, synced_at = excluded.synced_at",
              )
              .bind(sourceId, nextCursor, now()),
          );
        statements.push(
          this.db
            .prepare(
              "UPDATE sources SET status = 'ready', last_error = NULL, last_synced_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
            )
            .bind(now(), now(), ownerId, sourceId),
        );
        await this.db.batch(statements);
      },
    };
  }
}

export interface SyncQueueResult {
  outcome: "processed" | "duplicate" | "retry" | "failed";
}

export function planStaleSourceSyncs(
  ownerId: string,
  sources: readonly OwnerSource[],
  now: string,
  staleAfterMs = 15 * 60 * 1000,
) {
  const cutoff = new Date(now).getTime() - staleAfterMs;
  return sources
    .filter((source) => !source.lastSyncedAt || new Date(source.lastSyncedAt).getTime() <= cutoff)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((source) =>
      SyncSourceMessageSchema.parse({
        version: 1,
        kind: "sync_source",
        ownerId,
        sourceId: source.id,
        workId: `sync:${ownerId}:${source.id}:${now}`,
      }),
    );
}

export async function consumeSourceSyncMessage(
  input: unknown,
  sync: (
    message: ReturnType<typeof SyncSourceMessageSchema.parse>,
  ) => Promise<"processed" | "duplicate" | "retry" | void>,
): Promise<SyncQueueResult> {
  let message: ReturnType<typeof SyncSourceMessageSchema.parse>;
  try {
    message = SyncSourceMessageSchema.parse(input);
  } catch {
    return { outcome: "failed" };
  }
  try {
    const result = await sync(message);
    return {
      outcome:
        result === "duplicate" ? "duplicate" : result === "retry" ? "retry" : "processed",
    };
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : undefined;
    return {
      outcome: status === 429 || (status !== undefined && status >= 500) ? "retry" : "failed",
    };
  }
}
