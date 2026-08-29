import {
  DecisionTraceSchema,
  FramedRecommendationSchema,
  RecommendationSlateSchema,
  type DecisionTrace,
  type FramedRecommendation,
  type RecommendationSlate,
} from "../../contracts";
import type { CandidateDecision } from "../curation";
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

export type EditionDecision = CandidateDecision;

export interface EditionRepository {
  saveEdition(
    slate: RecommendationSlate,
    decisions?: readonly CandidateDecision[] | ReadonlyMap<string, DecisionTrace>,
  ): Promise<void>;
  getEdition(ownerId: string, editionId: string): Promise<RecommendationSlate | undefined>;
  listEditions(ownerId: string): Promise<RecommendationSlate[]>;
  resume(ownerId: string, editionId?: string): Promise<ResumedEdition | undefined>;
  setPosition(ownerId: string, editionId: string, position: number): Promise<EditionProgress>;
  markComplete(ownerId: string, editionId: string): Promise<EditionProgress>;
  getDecisions(ownerId: string, editionId: string): Promise<readonly CandidateDecision[]>;
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

function decisionKeyFallback(contentId: string, index: number): string {
  const normalized = contentId.trim();
  return normalized ? `${normalized}#${index}` : `candidate-${index}`;
}

function validateDecisions(
  slate: RecommendationSlate,
  input: readonly CandidateDecision[] | ReadonlyMap<string, DecisionTrace> | undefined,
): CandidateDecision[] {
  if (!input) return [];
  if (input instanceof Map) {
    const traces = input as ReadonlyMap<string, DecisionTrace>;
    return [...traces.entries()].map(([key, decisionTrace], index) => {
      const trace = DecisionTraceSchema.parse(decisionTrace);
      const item = slate.items.find((candidate) => candidate.contentId === key);
      return {
        decisionKey: key || decisionKeyFallback(key, index),
        contentId: key,
        selected: Boolean(item),
        reason: item ? undefined : "not-selected",
        decisionTrace: trace,
      };
    });
  }
  const decisions = input as readonly CandidateDecision[];
  return decisions.map((decision, index) => {
    const contentId = String(decision.contentId ?? "").trim();
    if (!contentId) throw new Error(`Decision ${index} is missing contentId`);
    const decisionKey = String(
      decision.decisionKey ?? decisionKeyFallback(contentId, index),
    ).trim();
    if (!decisionKey) throw new Error(`Decision ${index} is missing decisionKey`);
    return {
      ...copy(decision),
      decisionKey,
      contentId,
      decisionTrace: DecisionTraceSchema.parse(decision.decisionTrace),
    };
  });
}

/** Deterministic repository double and a useful local-first implementation. */
export class MemoryEditionRepository implements EditionRepository {
  private readonly editions = new Map<string, Map<string, RecommendationSlate>>();
  private readonly decisions = new Map<string, Map<string, CandidateDecision[]>>();
  private readonly progress = new Map<string, EditionProgress>();
  private readonly keeps = new Map<string, Map<string, KeepRecord>>();

  async saveEdition(
    slate: RecommendationSlate,
    decisions?: readonly CandidateDecision[] | ReadonlyMap<string, DecisionTrace>,
  ): Promise<void> {
    await Promise.resolve();
    const validated = RecommendationSlateSchema.parse(slate);
    const validatedDecisions = validateDecisions(validated, decisions);
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
    const ownerDecisions =
      this.decisions.get(validated.ownerId) ?? new Map<string, CandidateDecision[]>();
    ownerDecisions.set(validated.id, copy(validatedDecisions));
    this.decisions.set(validated.ownerId, ownerDecisions);
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

  getDecisions(ownerId: string, editionId: string): Promise<readonly CandidateDecision[]> {
    return Promise.resolve(copy(this.decisions.get(ownerId)?.get(editionId) ?? []));
  }

  getDecisionTraces(ownerId: string, editionId: string): ReadonlyMap<string, DecisionTrace> {
    return new Map(
      (this.decisions.get(ownerId)?.get(editionId) ?? []).map((decision) => [
        decision.decisionKey,
        copy(decision.decisionTrace),
      ]),
    );
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
  curiosity: number;
  energy: number;
  trace_json: string;
  position: number;
  completed: number;
  created_at: string;
}

interface EditionItemRow {
  owner_id: string;
  edition_id: string;
  content_id: string;
  position: number;
  recommendation_json: string;
}

interface EditionDecisionRow {
  owner_id: string;
  edition_id: string;
  decision_key: string;
  content_id: string;
  canonical_uri: string | null;
  selected: number;
  reason: string | null;
  trace_json: string;
}

interface KeepRow {
  owner_id: string;
  content_id: string;
  kept_at: string;
}

/** D1 adapter for the owner-scoped edition and decision schema. */
export class D1EditionRepository implements EditionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async saveEdition(
    slate: RecommendationSlate,
    decisions?: readonly CandidateDecision[] | ReadonlyMap<string, DecisionTrace>,
  ): Promise<void> {
    const validated = RecommendationSlateSchema.parse(slate);
    const validatedDecisions = validateDecisions(validated, decisions);
    const statements: D1StatementLike[] = [
      this.db
        .prepare(
          "INSERT INTO editions (owner_id, id, requested_at, curiosity, energy, trace_json, position, completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, id) DO UPDATE SET requested_at = excluded.requested_at, curiosity = excluded.curiosity, energy = excluded.energy, trace_json = excluded.trace_json, created_at = excluded.created_at",
        )
        .bind(
          validated.ownerId,
          validated.id,
          validated.createdAt,
          validated.curiosity,
          validated.energy,
          JSON.stringify(validated.decisionTrace),
          0,
          0,
          validated.createdAt,
        ),
      this.db
        .prepare("DELETE FROM edition_items WHERE owner_id = ? AND edition_id = ?")
        .bind(validated.ownerId, validated.id),
      this.db
        .prepare("DELETE FROM edition_decisions WHERE owner_id = ? AND edition_id = ?")
        .bind(validated.ownerId, validated.id),
      ...validated.items.map((item) =>
        this.db
          .prepare(
            "INSERT INTO edition_items (owner_id, edition_id, content_id, position, recommendation_json) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            validated.ownerId,
            validated.id,
            item.contentId,
            item.position,
            JSON.stringify(item),
          ),
      ),
      ...validatedDecisions.map((decision) =>
        this.db
          .prepare(
            "INSERT INTO edition_decisions (owner_id, edition_id, decision_key, content_id, canonical_uri, selected, reason, trace_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            validated.ownerId,
            validated.id,
            decision.decisionKey,
            decision.contentId,
            decision.canonicalUri ?? null,
            decision.selected ? 1 : 0,
            decision.reason ?? null,
            JSON.stringify(decision.decisionTrace),
          ),
      ),
    ];
    await this.db.batch(statements);
  }

  private async row(ownerId: string, editionId: string): Promise<EditionRow | null> {
    return this.db
      .prepare(
        "SELECT id, owner_id, requested_at, curiosity, energy, trace_json, position, completed, created_at FROM editions WHERE owner_id = ? AND id = ?",
      )
      .bind(ownerId, editionId)
      .first<EditionRow>();
  }

  async getEdition(ownerId: string, editionId: string): Promise<RecommendationSlate | undefined> {
    const row = await this.row(ownerId, editionId);
    if (!row) return undefined;
    const result = await this.db
      .prepare(
        "SELECT owner_id, edition_id, content_id, position, recommendation_json FROM edition_items WHERE owner_id = ? AND edition_id = ? ORDER BY position ASC",
      )
      .bind(ownerId, editionId)
      .all<EditionItemRow>();
    const items = result.results.map((item) =>
      FramedRecommendationSchema.parse(JSON.parse(item.recommendation_json)),
    );
    return RecommendationSlateSchema.parse({
      id: row.id,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      curiosity: row.curiosity,
      energy: row.energy,
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
    const row = await this.row(ownerId, edition.id);
    if (!row) return undefined;
    const position = clampEditionPosition(row.position, edition.items.length);
    const completed =
      row.completed === 1 || (edition.items.length > 0 && position >= edition.items.length);
    if (row.position !== position || row.completed !== (completed ? 1 : 0)) {
      await this.db
        .prepare("UPDATE editions SET position = ?, completed = ? WHERE owner_id = ? AND id = ?")
        .bind(position, completed ? 1 : 0, ownerId, edition.id)
        .run();
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
    const completed = clamped >= edition.items.length;
    const result = (await this.db
      .prepare("UPDATE editions SET position = ?, completed = ? WHERE owner_id = ? AND id = ?")
      .bind(clamped, completed ? 1 : 0, ownerId, editionId)
      .run()) as { meta?: { changes?: number } };
    if (result.meta?.changes === 0) throw new Error("Edition not found");
    return { editionId, ownerId, position: clamped, completed };
  }

  async markComplete(ownerId: string, editionId: string): Promise<EditionProgress> {
    const edition = await this.getEdition(ownerId, editionId);
    if (!edition) throw new Error("Edition not found");
    const result = (await this.db
      .prepare("UPDATE editions SET position = ?, completed = ? WHERE owner_id = ? AND id = ?")
      .bind(edition.items.length, 1, ownerId, editionId)
      .run()) as { meta?: { changes?: number } };
    if (result.meta?.changes === 0) throw new Error("Edition not found");
    return { editionId, ownerId, position: edition.items.length, completed: true };
  }

  async getDecisions(ownerId: string, editionId: string): Promise<readonly CandidateDecision[]> {
    const result = await this.db
      .prepare(
        "SELECT decision_key, content_id, canonical_uri, selected, reason, trace_json FROM edition_decisions WHERE owner_id = ? AND edition_id = ? ORDER BY rowid ASC",
      )
      .bind(ownerId, editionId)
      .all<EditionDecisionRow>();
    return result.results.map((row) => ({
      decisionKey: row.decision_key,
      contentId: row.content_id,
      ...(row.canonical_uri ? { canonicalUri: row.canonical_uri } : {}),
      selected: row.selected === 1,
      ...(row.reason ? { reason: row.reason as CandidateDecision["reason"] } : {}),
      decisionTrace: DecisionTraceSchema.parse(JSON.parse(row.trace_json)),
    }));
  }

  async getDecisionTraces(
    ownerId: string,
    editionId: string,
  ): Promise<ReadonlyMap<string, DecisionTrace>> {
    const decisions = await this.getDecisions(ownerId, editionId);
    return new Map(decisions.map((decision) => [decision.decisionKey, decision.decisionTrace]));
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
}

export function createD1EditionRepository(db: D1Database): EditionRepository {
  return new D1EditionRepository(db);
}
