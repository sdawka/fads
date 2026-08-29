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

export interface OwnerExport {
  ownerId: string;
  exportedAt: string;
  data: Record<string, unknown>;
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
  setSourceStatus(ownerId: string, sourceId: string, patch: SourceStatusPatch): Promise<OwnerSource | undefined>;
  listInterests(ownerId: string): Promise<ManualInterest[]>;
  saveInterest(interest: ManualInterest): Promise<ManualInterest>;
  removeInterest(ownerId: string, interestId: string): Promise<boolean>;
  listSuggestions(ownerId: string): Promise<InterestSuggestion[]>;
  decideSuggestion(ownerId: string, suggestionId: string, decision: "confirm" | "reject", at: string): Promise<InterestSuggestion | undefined>;
  getPreferences(ownerId: string): Promise<OwnerPreferences>;
  savePreferences(ownerId: string, preferences: OwnerPreferences, updatedAt?: string): Promise<OwnerPreferences>;
  listCandidates(ownerId: string): Promise<ContentEnvelope[]>;
  getCurationState(ownerId: string): Promise<OwnerCurationState>;
  recordInteraction(event: InteractionEvent): Promise<InteractionEvent>;
  listKeeps(ownerId: string): Promise<KeepRecord[]>;
  saveKeep(keep: KeepRecord): Promise<KeepRecord>;
  removeKeep(ownerId: string, contentId: string): Promise<boolean>;
  exportOwnerData(ownerId: string): Promise<OwnerExport>;
  resetOwnerData(ownerId: string, full: boolean): Promise<void>;
  getIdempotentResponse(input: IdempotencyLookup): Promise<{ conflict: true } | { conflict: false; response: Response } | undefined>;
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

function sourceFromRow(row: SourceRow): OwnerSource {
  return SourceSchema.parse({
    id: row.id,
    ownerId: row.owner_id,
    adapter: row.adapter,
    displayName: row.display_name,
    ...(row.url ? { url: row.url } : {}),
    config: JSON.parse(row.config_json),
    status: row.status,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  });
}

const SOURCE_COLUMNS = "id, owner_id, adapter, display_name, url, config_json, status, last_error, last_synced_at, created_at, updated_at";

export class D1OwnerDataRepository implements OwnerDataRepository {
  constructor(private readonly db: Database) {}

  async listSources(ownerId: string): Promise<OwnerSource[]> {
    const rows = await this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`).bind(ownerId).all<SourceRow>();
    return rows.results.map(sourceFromRow);
  }

  async getSource(ownerId: string, sourceId: string): Promise<OwnerSource | undefined> {
    const row = await this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`).bind(ownerId, sourceId).first<SourceRow>();
    return row ? sourceFromRow(row) : undefined;
  }

  async saveSource(input: OwnerSource): Promise<OwnerSource> {
    const source = SourceSchema.parse(input);
    await this.db.prepare(
      "INSERT INTO sources (id, owner_id, adapter, display_name, url, config_json, status, last_error, last_synced_at, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET adapter = excluded.adapter, display_name = excluded.display_name, url = excluded.url, config_json = excluded.config_json, status = excluded.status, last_error = excluded.last_error, last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at, deleted_at = NULL WHERE sources.owner_id = excluded.owner_id",
    ).bind(source.id, source.ownerId, source.adapter, source.displayName, source.url ?? null, JSON.stringify(source.config), source.status, source.lastError ?? null, source.lastSyncedAt ?? null, source.createdAt, source.updatedAt).run();
    const stored = await this.getSource(source.ownerId, source.id);
    if (!stored) throw new Error("Source identifier is already owned by another account");
    return stored;
  }

  async removeSource(ownerId: string, sourceId: string): Promise<boolean> {
    const result = await this.db.prepare("UPDATE sources SET deleted_at = updated_at WHERE owner_id = ? AND id = ? AND deleted_at IS NULL").bind(ownerId, sourceId).run();
    return changes(result) > 0;
  }

  async setSourceStatus(ownerId: string, sourceId: string, patch: SourceStatusPatch): Promise<OwnerSource | undefined> {
    const current = await this.getSource(ownerId, sourceId);
    if (!current) return undefined;
    return this.saveSource(SourceSchema.parse({ ...current, status: patch.status, ...(patch.lastError ? { lastError: patch.lastError } : { lastError: undefined }), ...(patch.lastSyncedAt ? { lastSyncedAt: patch.lastSyncedAt } : {}), updatedAt: patch.updatedAt ?? patch.lastSyncedAt ?? current.updatedAt }));
  }

  async listInterests(ownerId: string): Promise<ManualInterest[]> {
    const rows = await this.db.prepare("SELECT id, owner_id, value, created_at FROM manual_interests WHERE owner_id = ? ORDER BY created_at ASC, id ASC").bind(ownerId).all<{ id: string; owner_id: string; value: string; created_at: string }>();
    return rows.results.map((row) => ManualInterestSchema.parse({ id: row.id, ownerId: row.owner_id, value: row.value, createdAt: row.created_at }));
  }

  async saveInterest(input: ManualInterest): Promise<ManualInterest> {
    const interest = ManualInterestSchema.parse(input);
    const provenance = { source: "manual", observedAt: interest.createdAt };
    await this.db.prepare("INSERT INTO manual_interests (id, owner_id, value, provenance_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value WHERE manual_interests.owner_id = excluded.owner_id").bind(interest.id, interest.ownerId, interest.value, JSON.stringify(provenance), interest.createdAt).run();
    return interest;
  }

  async removeInterest(ownerId: string, interestId: string): Promise<boolean> {
    return changes(await this.db.prepare("DELETE FROM manual_interests WHERE owner_id = ? AND id = ?").bind(ownerId, interestId).run()) > 0;
  }

  async listSuggestions(ownerId: string): Promise<InterestSuggestion[]> {
    const rows = await this.db.prepare("SELECT owner_id, id, value, evidence_count, provenance_json, status, created_at, decided_at FROM interest_suggestions WHERE owner_id = ? ORDER BY created_at ASC, id ASC").bind(ownerId).all<Record<string, unknown>>();
    return rows.results.map((row) => InterestSuggestionSchema.parse({ ownerId: row.owner_id, id: row.id, value: row.value, evidenceCount: row.evidence_count, provenance: JSON.parse(String(row.provenance_json)), status: row.status, createdAt: row.created_at, ...(row.decided_at ? { decidedAt: row.decided_at } : {}) }));
  }

  async decideSuggestion(ownerId: string, suggestionId: string, decision: "confirm" | "reject", at: string): Promise<InterestSuggestion | undefined> {
    await this.db.prepare("UPDATE interest_suggestions SET status = ?, decided_at = ? WHERE owner_id = ? AND id = ? AND status = 'pending'").bind(decision === "confirm" ? "confirmed" : "rejected", at, ownerId, suggestionId).run();
    return (await this.listSuggestions(ownerId)).find((item) => item.id === suggestionId);
  }

  async getPreferences(ownerId: string): Promise<OwnerPreferences> {
    const row = await this.db.prepare("SELECT preferences_json FROM owner_preferences WHERE owner_id = ?").bind(ownerId).first<{ preferences_json: string }>();
    const stored = row ? OwnerPreferencesSchema.parse(JSON.parse(row.preferences_json)) : { blockedLabels: [], mutedSourceIds: [] };
    const muted = await this.db.prepare("SELECT source_id FROM owner_muted_sources WHERE owner_id = ? ORDER BY source_id ASC").bind(ownerId).all<{ source_id: string }>();
    return { ...stored, mutedSourceIds: muted.results.map((item) => item.source_id) };
  }

  async savePreferences(ownerId: string, input: OwnerPreferences, updatedAt = new Date().toISOString()): Promise<OwnerPreferences> {
    const preferences = OwnerPreferencesSchema.parse(input);
    await this.db.batch([
      this.db.prepare("INSERT INTO owner_preferences (owner_id, preferences_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET preferences_json = excluded.preferences_json, updated_at = excluded.updated_at").bind(ownerId, JSON.stringify({ ...preferences, mutedSourceIds: [] }), updatedAt),
      this.db.prepare("DELETE FROM owner_muted_sources WHERE owner_id = ?").bind(ownerId),
      ...preferences.mutedSourceIds.map((sourceId) => this.db.prepare("INSERT INTO owner_muted_sources (owner_id, source_id, muted_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM sources WHERE owner_id = ? AND id = ?)").bind(ownerId, sourceId, updatedAt, ownerId, sourceId)),
    ]);
    return preferences;
  }

  async listCandidates(ownerId: string): Promise<ContentEnvelope[]> {
    const rows = await this.db.prepare("SELECT ci.id, ci.source_id, ci.canonical_uri, ci.published_at, ci.captured_at, ci.blocks_json, ci.media_json FROM content_items ci JOIN sources s ON s.id = ci.source_id WHERE s.owner_id = ? AND s.deleted_at IS NULL ORDER BY ci.published_at DESC, ci.id ASC").bind(ownerId).all<ContentRow>();
    const output: ContentEnvelope[] = [];
    for (const row of rows.results) {
      const tags = await this.db.prepare("SELECT value, provenance_json FROM content_tags WHERE content_id = ? ORDER BY value ASC").bind(row.id).all<{ value: string; provenance_json: string }>();
      const labels = await this.db.prepare("SELECT value, provenance_json FROM content_labels WHERE content_id = ? ORDER BY value ASC").bind(row.id).all<{ value: string; provenance_json: string }>();
      output.push(ContentEnvelopeSchema.parse({ id: row.id, canonicalUri: row.canonical_uri, sourceId: row.source_id, publishedAt: row.published_at, capturedAt: row.captured_at, blocks: JSON.parse(row.blocks_json), media: JSON.parse(row.media_json), tags: tags.results.map((tag) => ({ value: tag.value, provenance: JSON.parse(tag.provenance_json) })), labels: labels.results.map((label) => ({ value: label.value, provenance: JSON.parse(label.provenance_json) })) }));
    }
    return output;
  }

  async getCurationState(ownerId: string): Promise<OwnerCurationState> {
    const adjustments = await this.db.prepare("SELECT factor, adjustment FROM learned_adjustments WHERE owner_id = ? ORDER BY factor ASC").bind(ownerId).all<{ factor: string; adjustment: number }>();
    const suppressions = await this.db.prepare("SELECT content_id, canonical_uri, until_at FROM content_suppressions WHERE owner_id = ? ORDER BY created_at ASC, rowid ASC").bind(ownerId).all<{ content_id: string | null; canonical_uri: string | null; until_at: string }>();
    const shown = await this.db.prepare("SELECT ei.content_id, ci.canonical_uri, e.created_at FROM edition_items ei JOIN editions e ON e.owner_id = ei.owner_id AND e.id = ei.edition_id LEFT JOIN content_items ci ON ci.id = ei.content_id WHERE ei.owner_id = ? ORDER BY e.created_at ASC, ei.position ASC").bind(ownerId).all<{ content_id: string; canonical_uri: string | null; created_at: string }>();
    return {
      learnedAdjustments: Object.fromEntries(adjustments.results.map((row) => [row.factor, row.adjustment])),
      notNow: suppressions.results.map((row) => ({ ...(row.content_id ? { contentId: row.content_id } : {}), ...(row.canonical_uri ? { canonicalUri: row.canonical_uri } : {}), until: row.until_at })),
      recentlyShown: shown.results.map((row) => ({ contentId: row.content_id, ...(row.canonical_uri ? { canonicalUri: row.canonical_uri } : {}), shownAt: row.created_at })),
    };
  }

  async recordInteraction(input: InteractionEvent): Promise<InteractionEvent> {
    const event = InteractionEventSchema.parse(input);
    const statements: Statement[] = [];
    const delta = event.kind === "more_like_this" ? 1 : event.kind === "less_like_this" ? -1 : event.kind === "good_surprise" ? 0.5 : 0;
    const factors = [...new Set([
      ...(event.contentId ? [`content:${event.contentId}`] : []),
      ...(event.sourceId ? [`source:${event.sourceId}`] : []),
    ])];
    for (const factor of delta ? factors : []) {
      const adjustmentId = `${event.ownerId}\u0000${factor}`;
      statements.push(this.db.prepare("INSERT INTO learned_adjustments (id, owner_id, factor, adjustment, provenance_json, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM interactions WHERE id = ?) ON CONFLICT(id) DO UPDATE SET adjustment = learned_adjustments.adjustment + excluded.adjustment, provenance_json = excluded.provenance_json, updated_at = excluded.updated_at").bind(adjustmentId, event.ownerId, factor, delta, JSON.stringify(event.provenance), event.occurredAt, event.id));
    }
    if (event.kind === "not_now" && event.contentId) {
      const canonical = await this.db.prepare("SELECT canonical_uri FROM content_items ci JOIN sources s ON s.id = ci.source_id WHERE s.owner_id = ? AND ci.id = ?").bind(event.ownerId, event.contentId).first<{ canonical_uri: string }>();
      const until = new Date(new Date(event.occurredAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      statements.push(this.db.prepare("INSERT INTO content_suppressions (owner_id, content_id, canonical_uri, until_at, created_at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM interactions WHERE id = ?)").bind(event.ownerId, event.contentId, canonical?.canonical_uri ?? null, until, event.occurredAt, event.id));
    }
    if (event.kind === "mute_source" && event.sourceId) {
      statements.push(this.db.prepare("INSERT INTO owner_muted_sources (owner_id, source_id, muted_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM interactions WHERE id = ?) AND EXISTS (SELECT 1 FROM sources WHERE owner_id = ? AND id = ?) ON CONFLICT(owner_id, source_id) DO NOTHING").bind(event.ownerId, event.sourceId, event.occurredAt, event.id, event.ownerId, event.sourceId));
    }
    if (event.kind === "keep" && event.contentId) {
      statements.push(this.db.prepare("INSERT INTO keeps (owner_id, content_id, kept_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM interactions WHERE id = ?) ON CONFLICT(owner_id, content_id) DO NOTHING").bind(event.ownerId, event.contentId, event.occurredAt, event.id));
    }
    statements.push(this.db.prepare("INSERT INTO interactions (id, owner_id, content_id, source_id, kind, occurred_at, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").bind(event.id, event.ownerId, event.contentId ?? null, event.sourceId ?? null, event.kind, event.occurredAt, JSON.stringify(event.provenance)));
    await this.db.batch(statements);
    return event;
  }

  async listKeeps(ownerId: string): Promise<KeepRecord[]> {
    const rows = await this.db.prepare("SELECT owner_id, content_id, kept_at FROM keeps WHERE owner_id = ? ORDER BY kept_at DESC, content_id ASC").bind(ownerId).all<{ owner_id: string; content_id: string; kept_at: string }>();
    return rows.results.map((row) => ({ ownerId: row.owner_id, contentId: row.content_id, keptAt: row.kept_at }));
  }

  async saveKeep(keep: KeepRecord): Promise<KeepRecord> {
    await this.db.prepare("INSERT INTO keeps (owner_id, content_id, kept_at) VALUES (?, ?, ?) ON CONFLICT(owner_id, content_id) DO UPDATE SET kept_at = excluded.kept_at").bind(keep.ownerId, keep.contentId, keep.keptAt).run();
    return keep;
  }

  async removeKeep(ownerId: string, contentId: string): Promise<boolean> {
    return changes(await this.db.prepare("DELETE FROM keeps WHERE owner_id = ? AND content_id = ?").bind(ownerId, contentId).run()) > 0;
  }

  async exportOwnerData(ownerId: string): Promise<OwnerExport> {
    return { ownerId, exportedAt: new Date().toISOString(), data: { sources: await this.listSources(ownerId), interests: await this.listInterests(ownerId), suggestions: await this.listSuggestions(ownerId), preferences: await this.getPreferences(ownerId), interactions: (await this.db.prepare("SELECT id, content_id, source_id, kind, occurred_at, provenance_json FROM interactions WHERE owner_id = ? ORDER BY occurred_at ASC, id ASC").bind(ownerId).all<Record<string, unknown>>()).results, keeps: await this.listKeeps(ownerId) } };
  }

  async resetOwnerData(ownerId: string, full: boolean): Promise<void> {
    if (!full) {
      await this.db.prepare("DELETE FROM learned_adjustments WHERE owner_id = ?").bind(ownerId).run();
      return;
    }
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
      this.db.prepare("DELETE FROM api_idempotency WHERE owner_id = ?").bind(ownerId),
      this.db.prepare("DELETE FROM content_items WHERE source_id IN (SELECT id FROM sources WHERE owner_id = ?)").bind(ownerId),
      this.db.prepare("DELETE FROM sources WHERE owner_id = ?").bind(ownerId),
    ]);
  }

  async getIdempotentResponse(input: IdempotencyLookup): Promise<{ conflict: true } | { conflict: false; response: Response } | undefined> {
    const row = await this.db.prepare("SELECT request_hash, response_status, response_headers_json, response_body FROM api_idempotency WHERE owner_id = ? AND scope = ? AND key = ? AND expires_at > ?").bind(input.ownerId, input.scope, input.key, input.now).first<{ request_hash: string; response_status: number; response_headers_json: string; response_body: string }>();
    if (!row) return undefined;
    if (row.request_hash !== input.requestHash) return { conflict: true };
    return { conflict: false, response: new Response(row.response_body || null, { status: row.response_status, headers: JSON.parse(row.response_headers_json) }) };
  }

  async saveIdempotentResponse(input: IdempotencySave): Promise<void> {
    const response = input.response.clone();
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "location"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    await this.db.prepare("INSERT INTO api_idempotency (owner_id, scope, key, request_hash, response_status, response_headers_json, response_body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, scope, key) DO NOTHING").bind(input.ownerId, input.scope, input.key, input.requestHash, response.status, JSON.stringify(headers), await response.text(), input.createdAt, input.expiresAt).run();
  }

  rssSyncRepository(ownerId: string, expectedSourceId: string, now: () => string = () => new Date().toISOString()): RssSyncRepository {
    const assertSource = async (sourceId: string) => {
      if (sourceId !== expectedSourceId || !(await this.getSource(ownerId, sourceId))) throw new Error("Source not found");
    };
    return {
      loadCursor: async ({ sourceId }) => {
        await assertSource(sourceId);
        return (await this.db.prepare("SELECT sc.cursor FROM sync_cursors sc JOIN sources s ON s.id = sc.source_id WHERE s.owner_id = ? AND sc.source_id = ?").bind(ownerId, sourceId).first<{ cursor: string | null }>())?.cursor ?? undefined;
      },
      isKnownContent: async ({ id, canonicalUri }) => Boolean(await this.db.prepare("SELECT ci.id FROM content_items ci JOIN sources s ON s.id = ci.source_id WHERE s.owner_id = ? AND (ci.id = ? OR ci.canonical_uri = ?)").bind(ownerId, id, canonicalUri).first()),
      commitSync: async ({ sourceId, items, nextCursor }) => {
        await assertSource(sourceId);
        const captured = items.map((item) => ContentEnvelopeSchema.parse(item));
        if (captured.some((item) => item.sourceId !== sourceId)) throw new Error("Content source does not match sync source");
        const statements: Statement[] = [];
        for (const item of captured) {
          statements.push(this.db.prepare("INSERT INTO content_items (id, source_id, canonical_uri, published_at, captured_at, blocks_json, media_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at, captured_at = excluded.captured_at, blocks_json = excluded.blocks_json, media_json = excluded.media_json WHERE content_items.source_id = excluded.source_id").bind(item.id, sourceId, item.canonicalUri, item.publishedAt, item.capturedAt, JSON.stringify(item.blocks), JSON.stringify(item.media)));
          statements.push(this.db.prepare("DELETE FROM content_tags WHERE content_id = ?").bind(item.id));
          statements.push(this.db.prepare("DELETE FROM content_labels WHERE content_id = ?").bind(item.id));
          for (const tag of item.tags) statements.push(this.db.prepare("INSERT INTO content_tags (content_id, value, provenance_json) VALUES (?, ?, ?)").bind(item.id, tag.value, JSON.stringify(tag.provenance)));
          for (const label of item.labels) statements.push(this.db.prepare("INSERT INTO content_labels (content_id, value, provenance_json) VALUES (?, ?, ?)").bind(item.id, label.value, JSON.stringify(label.provenance)));
        }
        if (nextCursor !== undefined) statements.push(this.db.prepare("INSERT INTO sync_cursors (source_id, cursor, synced_at) VALUES (?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET cursor = excluded.cursor, synced_at = excluded.synced_at").bind(sourceId, nextCursor, now()));
        statements.push(this.db.prepare("UPDATE sources SET status = 'ready', last_error = NULL, last_synced_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?").bind(now(), now(), ownerId, sourceId));
        await this.db.batch(statements);
      },
    };
  }
}

export interface SyncQueueResult { outcome: "processed" | "duplicate" | "retry" | "failed"; }

export function planStaleSourceSyncs(ownerId: string, sources: readonly OwnerSource[], now: string, staleAfterMs = 15 * 60 * 1000) {
  const cutoff = new Date(now).getTime() - staleAfterMs;
  return sources.filter((source) => !source.lastSyncedAt || new Date(source.lastSyncedAt).getTime() <= cutoff).sort((a, b) => a.id.localeCompare(b.id)).map((source) => SyncSourceMessageSchema.parse({ version: 1, kind: "sync_source", ownerId, sourceId: source.id }));
}

export async function consumeSourceSyncMessage(input: unknown, sync: (message: ReturnType<typeof SyncSourceMessageSchema.parse>) => Promise<"processed" | "duplicate" | void>): Promise<SyncQueueResult> {
  let message: ReturnType<typeof SyncSourceMessageSchema.parse>;
  try { message = SyncSourceMessageSchema.parse(input); } catch { return { outcome: "failed" }; }
  try { const result = await sync(message); return { outcome: result === "duplicate" ? "duplicate" : "processed" }; } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
    return { outcome: status === 429 || (status !== undefined && status >= 500) ? "retry" : "failed" };
  }
}
