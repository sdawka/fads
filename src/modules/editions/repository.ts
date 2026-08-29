import {
  DecisionTraceSchema,
  FramedRecommendationSchema,
  RecommendationSlateSchema,
  type DecisionTrace,
  type FramedRecommendation,
  type RecommendationSlate,
} from "../../contracts";
import type { KeepRecord } from "../feedback";

export interface EditionProgress {
  editionId: string;
  ownerId: string;
  position: number;
  completed: boolean;
}

export interface ResumedEdition {
  edition: RecommendationSlate;
  position: number;
  completed: boolean;
  currentItem?: FramedRecommendation;
}

export interface EditionRepository {
  saveEdition(
    slate: RecommendationSlate,
    traces?: ReadonlyMap<string, DecisionTrace>,
  ): Promise<void>;
  getEdition(ownerId: string, editionId: string): Promise<RecommendationSlate | undefined>;
  listEditions(ownerId: string): Promise<RecommendationSlate[]>;
  resume(ownerId: string, editionId?: string): Promise<ResumedEdition | undefined>;
  setPosition(ownerId: string, editionId: string, position: number): Promise<EditionProgress>;
  markComplete(ownerId: string, editionId: string): Promise<EditionProgress>;
  saveKeep(ownerId: string, contentId: string, keptAt: string): Promise<KeepRecord>;
  removeKeep(ownerId: string, contentId: string): Promise<boolean>;
  listKeeps(ownerId: string): Promise<KeepRecord[]>;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function clampEditionPosition(position: number, itemCount: number): number {
  if (!Number.isFinite(position)) return 0;
  return Math.max(0, Math.min(itemCount, Math.trunc(position)));
}

function progressKey(ownerId: string, editionId: string): string {
  return `${ownerId}\u0000${editionId}`;
}

function validateTraces(
  traces: ReadonlyMap<string, DecisionTrace> | undefined,
): Map<string, DecisionTrace> {
  return new Map(
    [...(traces ?? new Map<string, DecisionTrace>())].map(([id, trace]) => [
      id,
      DecisionTraceSchema.parse(trace),
    ]),
  );
}

/** Deterministic repository double and a useful local-first implementation. */
export class MemoryEditionRepository implements EditionRepository {
  private readonly editions = new Map<string, Map<string, RecommendationSlate>>();
  private readonly traces = new Map<string, Map<string, DecisionTrace>>();
  private readonly progress = new Map<string, EditionProgress>();
  private readonly keeps = new Map<string, Map<string, KeepRecord>>();

  async saveEdition(
    slate: RecommendationSlate,
    traces?: ReadonlyMap<string, DecisionTrace>,
  ): Promise<void> {
    await Promise.resolve();
    const validated = RecommendationSlateSchema.parse(slate);
    const validatedTraces = validateTraces(traces);
    const ownerEditions =
      this.editions.get(validated.ownerId) ?? new Map<string, RecommendationSlate>();
    ownerEditions.set(validated.id, copy(validated));
    this.editions.set(validated.ownerId, ownerEditions);
    const key = progressKey(validated.ownerId, validated.id);
    const previous = this.progress.get(key);
    const position = clampEditionPosition(previous?.position ?? 0, validated.items.length);
    this.progress.set(key, {
      editionId: validated.id,
      ownerId: validated.ownerId,
      position,
      completed: previous?.completed === true,
    });
    this.traces.set(
      key,
      new Map([...validatedTraces.entries()].map(([id, trace]) => [id, copy(trace)])),
    );
    return Promise.resolve();
  }

  getEdition(ownerId: string, editionId: string): Promise<RecommendationSlate | undefined> {
    const slate = this.editions.get(ownerId)?.get(editionId);
    return Promise.resolve(slate ? copy(slate) : undefined);
  }

  listEditions(ownerId: string): Promise<RecommendationSlate[]> {
    return Promise.resolve(
      [...(this.editions.get(ownerId)?.values() ?? [])]
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        )
        .map(copy),
    );
  }

  async resume(ownerId: string, editionId?: string): Promise<ResumedEdition | undefined> {
    const edition = editionId
      ? await this.getEdition(ownerId, editionId)
      : (await this.listEditions(ownerId)).at(-1);
    if (!edition) return undefined;
    const key = progressKey(ownerId, edition.id);
    const previous = this.progress.get(key);
    const position = clampEditionPosition(previous?.position ?? 0, edition.items.length);
    const completed = previous?.completed === true;
    if (previous && (previous.position !== position || previous.completed !== completed)) {
      this.progress.set(key, { ...previous, position, completed });
    }
    return {
      edition,
      position,
      completed,
      currentItem: completed ? undefined : edition.items[position],
    };
  }

  async setPosition(
    ownerId: string,
    editionId: string,
    position: number,
  ): Promise<EditionProgress> {
    const edition = await this.getEdition(ownerId, editionId);
    if (!edition) throw new Error("Edition not found");
    const clamped = clampEditionPosition(position, edition.items.length);
    const next: EditionProgress = {
      editionId,
      ownerId,
      position: clamped,
      completed: clamped >= edition.items.length,
    };
    this.progress.set(progressKey(ownerId, editionId), next);
    return { ...next };
  }

  async markComplete(ownerId: string, editionId: string): Promise<EditionProgress> {
    const edition = await this.getEdition(ownerId, editionId);
    if (!edition) throw new Error("Edition not found");
    const next: EditionProgress = {
      editionId,
      ownerId,
      position: edition.items.length,
      completed: true,
    };
    this.progress.set(progressKey(ownerId, editionId), next);
    return { ...next };
  }

  saveKeep(ownerId: string, contentId: string, keptAt: string): Promise<KeepRecord> {
    const ownerKeeps = this.keeps.get(ownerId) ?? new Map<string, KeepRecord>();
    const existing = ownerKeeps.get(contentId);
    const keep = existing ? { ...existing, keptAt } : { ownerId, contentId, keptAt };
    ownerKeeps.set(contentId, keep);
    this.keeps.set(ownerId, ownerKeeps);
    return Promise.resolve({ ...keep });
  }

  removeKeep(ownerId: string, contentId: string): Promise<boolean> {
    const ownerKeeps = this.keeps.get(ownerId);
    if (!ownerKeeps) return Promise.resolve(false);
    const removed = ownerKeeps.delete(contentId);
    if (!ownerKeeps.size) this.keeps.delete(ownerId);
    return Promise.resolve(removed);
  }

  listKeeps(ownerId: string): Promise<KeepRecord[]> {
    return Promise.resolve(
      [...(this.keeps.get(ownerId)?.values() ?? [])]
        .sort(
          (left, right) =>
            left.keptAt.localeCompare(right.keptAt) ||
            left.contentId.localeCompare(right.contentId),
        )
        .map((keep) => ({ ...keep })),
    );
  }

  getDecisionTraces(ownerId: string, editionId: string): ReadonlyMap<string, DecisionTrace> {
    return new Map(
      [...(this.traces.get(progressKey(ownerId, editionId))?.entries() ?? [])].map(
        ([id, trace]) => [id, copy(trace)],
      ),
    );
  }
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}

interface EditionRow {
  id: string;
  owner_id: string;
  requested_at: string;
  trace_json: string;
  created_at: string;
}

interface EditionItemRow {
  content_id: string;
  recommendation_json: string;
}

interface KeepRow {
  owner_id: string;
  content_id: string;
  kept_at: string;
}

/** D1 adapter for the frozen schema; progress remains process-local until a migration adds columns. */
export class D1EditionRepository implements EditionRepository {
  private readonly progress = new Map<string, EditionProgress>();
  private readonly slates = new Map<string, RecommendationSlate>();
  private readonly traces = new Map<string, Map<string, DecisionTrace>>();

  constructor(private readonly db: D1DatabaseLike) {}

  async saveEdition(
    slate: RecommendationSlate,
    traces?: ReadonlyMap<string, DecisionTrace>,
  ): Promise<void> {
    const validated = RecommendationSlateSchema.parse(slate);
    const validatedTraces = validateTraces(traces);
    const statements: D1StatementLike[] = [
      this.db
        .prepare(
          "INSERT INTO editions (id, owner_id, requested_at, trace_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, requested_at = excluded.requested_at, trace_json = excluded.trace_json, created_at = excluded.created_at",
        )
        .bind(
          validated.id,
          validated.ownerId,
          validated.createdAt,
          JSON.stringify(validated.decisionTrace),
          validated.createdAt,
        ),
      this.db.prepare("DELETE FROM edition_items WHERE edition_id = ?").bind(validated.id),
    ];
    statements.push(
      ...validated.items.map((item) =>
        this.db
          .prepare(
            "INSERT INTO edition_items (edition_id, content_id, position, recommendation_json) VALUES (?, ?, ?, ?)",
          )
          .bind(validated.id, item.contentId, item.position, JSON.stringify(item)),
      ),
    );
    await this.db.batch(statements);
    const key = progressKey(validated.ownerId, validated.id);
    this.slates.set(key, copy(validated));
    this.traces.set(
      key,
      new Map([...validatedTraces.entries()].map(([id, trace]) => [id, copy(trace)])),
    );
    const previous = this.progress.get(key);
    const position = clampEditionPosition(previous?.position ?? 0, validated.items.length);
    this.progress.set(key, {
      editionId: validated.id,
      ownerId: validated.ownerId,
      position,
      completed: previous?.completed === true,
    });
  }

  private async row(ownerId: string, editionId: string): Promise<EditionRow | null> {
    return this.db
      .prepare(
        "SELECT id, owner_id, requested_at, trace_json, created_at FROM editions WHERE owner_id = ? AND id = ?",
      )
      .bind(ownerId, editionId)
      .first<EditionRow>();
  }

  async getEdition(ownerId: string, editionId: string): Promise<RecommendationSlate | undefined> {
    const row = await this.row(ownerId, editionId);
    if (!row) return undefined;
    const result = await this.db
      .prepare(
        "SELECT content_id, recommendation_json FROM edition_items WHERE edition_id = ? ORDER BY position ASC",
      )
      .bind(editionId)
      .all<EditionItemRow>();
    const items = result.results.map((item) =>
      FramedRecommendationSchema.parse(JSON.parse(item.recommendation_json)),
    );
    const cached = this.slates.get(progressKey(ownerId, editionId));
    return RecommendationSlateSchema.parse({
      id: row.id,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      curiosity: cached?.curiosity ?? 0,
      energy: cached?.energy ?? 0,
      items,
      decisionTrace: DecisionTraceSchema.parse(JSON.parse(row.trace_json)),
    });
  }

  async listEditions(ownerId: string): Promise<RecommendationSlate[]> {
    const rows = await this.db
      .prepare("SELECT id FROM editions WHERE owner_id = ? ORDER BY created_at ASC, id ASC")
      .bind(ownerId)
      .all<{ id: string }>();
    const editions = await Promise.all(rows.results.map((row) => this.getEdition(ownerId, row.id)));
    return editions.filter((edition): edition is RecommendationSlate => Boolean(edition));
  }

  async resume(ownerId: string, editionId?: string): Promise<ResumedEdition | undefined> {
    const edition = editionId
      ? await this.getEdition(ownerId, editionId)
      : (await this.listEditions(ownerId)).at(-1);
    if (!edition) return undefined;
    const key = progressKey(ownerId, edition.id);
    const previous = this.progress.get(key);
    const position = clampEditionPosition(previous?.position ?? 0, edition.items.length);
    const completed = previous?.completed === true;
    this.progress.set(key, { editionId: edition.id, ownerId, position, completed });
    return {
      edition,
      position,
      completed,
      currentItem: completed ? undefined : edition.items[position],
    };
  }

  async setPosition(
    ownerId: string,
    editionId: string,
    position: number,
  ): Promise<EditionProgress> {
    const edition = await this.getEdition(ownerId, editionId);
    if (!edition) throw new Error("Edition not found");
    const next: EditionProgress = {
      editionId,
      ownerId,
      position: clampEditionPosition(position, edition.items.length),
      completed: clampEditionPosition(position, edition.items.length) >= edition.items.length,
    };
    this.progress.set(progressKey(ownerId, editionId), next);
    return { ...next };
  }

  async markComplete(ownerId: string, editionId: string): Promise<EditionProgress> {
    const edition = await this.getEdition(ownerId, editionId);
    if (!edition) throw new Error("Edition not found");
    const next: EditionProgress = {
      editionId,
      ownerId,
      position: edition.items.length,
      completed: true,
    };
    this.progress.set(progressKey(ownerId, editionId), next);
    return { ...next };
  }

  async saveKeep(ownerId: string, contentId: string, keptAt: string): Promise<KeepRecord> {
    await this.db
      .prepare(
        "INSERT INTO keeps (owner_id, content_id, kept_at) VALUES (?, ?, ?) ON CONFLICT(owner_id, content_id) DO UPDATE SET kept_at = excluded.kept_at",
      )
      .bind(ownerId, contentId, keptAt)
      .run();
    return { ownerId, contentId, keptAt };
  }

  async removeKeep(ownerId: string, contentId: string): Promise<boolean> {
    const result = (await this.db
      .prepare("DELETE FROM keeps WHERE owner_id = ? AND content_id = ?")
      .bind(ownerId, contentId)
      .run()) as { meta?: { changes?: number } };
    return (result.meta?.changes ?? 0) > 0;
  }

  async listKeeps(ownerId: string): Promise<KeepRecord[]> {
    const result = await this.db
      .prepare(
        "SELECT owner_id, content_id, kept_at FROM keeps WHERE owner_id = ? ORDER BY kept_at ASC, content_id ASC",
      )
      .bind(ownerId)
      .all<KeepRow>();
    return result.results.map((row) => ({
      ownerId: row.owner_id,
      contentId: row.content_id,
      keptAt: row.kept_at,
    }));
  }

  getDecisionTraces(ownerId: string, editionId: string): ReadonlyMap<string, DecisionTrace> {
    return new Map(
      [...(this.traces.get(progressKey(ownerId, editionId))?.entries() ?? [])].map(
        ([id, trace]) => [id, copy(trace)],
      ),
    );
  }
}

export function createD1EditionRepository(db: D1Database): EditionRepository {
  return new D1EditionRepository(db);
}
