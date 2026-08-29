import { describe, expect, it } from "vitest";
import {
  D1EditionRepository,
  type D1DatabaseLike,
  type D1StatementLike,
} from "../../src/modules/editions";
import type { DecisionTrace, RecommendationSlate } from "../../src/contracts";
import type { CandidateDecision } from "../../src/modules/curation";

const createdAt = "2026-08-28T12:00:00.000Z";

function slate(id = "edition-d1", ownerId = "owner", contentId = "content"): RecommendationSlate {
  return {
    id,
    ownerId,
    createdAt,
    curiosity: 80,
    energy: 20,
    items: [
      {
        id: `${id}:${contentId}`,
        contentId,
        frame: "text",
        position: 0,
        decisionTrace: {
          factors: [
            {
              factor: "selected",
              weight: 1,
              provenance: { source: "curation", observedAt: createdAt },
            },
          ],
        },
      },
    ],
    decisionTrace: {
      factors: [
        {
          factor: "edition",
          weight: 1,
          provenance: { source: "curation", observedAt: createdAt },
        },
      ],
    },
  };
}

function decision(decisionKey: string, contentId: string, selected: boolean): CandidateDecision {
  const trace: DecisionTrace = {
    factors: [
      {
        factor: selected ? "selected" : "excluded:duplicate-content",
        weight: selected ? 1 : 0,
        provenance: { source: "curation", observedAt: createdAt },
      },
    ],
  };
  return {
    decisionKey,
    contentId,
    canonicalUri: `https://example.com/${decisionKey}`,
    selected,
    reason: selected ? undefined : "duplicate-content",
    decisionTrace: trace,
  };
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

interface ItemRow {
  owner_id: string;
  edition_id: string;
  content_id: string;
  position: number;
  recommendation_json: string;
}

interface DecisionRow {
  owner_id: string;
  edition_id: string;
  decision_key: string;
  content_id: string;
  canonical_uri: string | null;
  selected: number;
  reason: string | null;
  trace_json: string;
}

class FakeD1 implements D1DatabaseLike {
  editions: EditionRow[] = [];
  items: ItemRow[] = [];
  decisions: DecisionRow[] = [];
  batchCalls = 0;
  lastBatchSize = 0;

  prepare(query: string): D1StatementLike {
    return new FakeStatement(this, query);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
    this.batchCalls += 1;
    this.lastBatchSize = statements.length;
    for (const statement of statements) await statement.run();
    return [];
  }
}

class FakeStatement implements D1StatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    this.values = values;
    return this;
  }

  async run(): Promise<unknown> {
    let changes = 0;
    if (this.query.startsWith("INSERT INTO editions")) {
      const [ownerId, id, requestedAt, curiosity, energy, trace, position, completed, createdAt] =
        this.values as [string, string, string, number, number, string, number, number, string];
      const existing = this.db.editions.find((row) => row.owner_id === ownerId && row.id === id);
      const row: EditionRow = {
        owner_id: ownerId,
        id,
        requested_at: requestedAt,
        curiosity,
        energy,
        trace_json: trace,
        position,
        completed,
        created_at: createdAt,
      };
      if (existing) Object.assign(existing, row);
      else this.db.editions.push(row);
      changes = 1;
    } else if (this.query.startsWith("DELETE FROM edition_items")) {
      const [ownerId, editionId] = this.values as [string, string];
      const before = this.db.items.length;
      this.db.items = this.db.items.filter(
        (row) => row.owner_id !== ownerId || row.edition_id !== editionId,
      );
      changes = before - this.db.items.length;
    } else if (this.query.startsWith("INSERT INTO edition_items")) {
      const [ownerId, editionId, contentId, position, recommendation] = this.values as [
        string,
        string,
        string,
        number,
        string,
      ];
      this.db.items.push({
        owner_id: ownerId,
        edition_id: editionId,
        content_id: contentId,
        position,
        recommendation_json: recommendation,
      });
      changes = 1;
    } else if (this.query.startsWith("DELETE FROM edition_decisions")) {
      const [ownerId, editionId] = this.values as [string, string];
      const before = this.db.decisions.length;
      this.db.decisions = this.db.decisions.filter(
        (row) => row.owner_id !== ownerId || row.edition_id !== editionId,
      );
      changes = before - this.db.decisions.length;
    } else if (this.query.startsWith("INSERT INTO edition_decisions")) {
      const [ownerId, editionId, decisionKey, contentId, canonicalUri, selected, reason, trace] =
        this.values as [
          string,
          string,
          string,
          string,
          string | null,
          number,
          string | null,
          string,
        ];
      this.db.decisions.push({
        owner_id: ownerId,
        edition_id: editionId,
        decision_key: decisionKey,
        content_id: contentId,
        canonical_uri: canonicalUri,
        selected,
        reason,
        trace_json: trace,
      });
      changes = 1;
    } else if (this.query.startsWith("UPDATE editions")) {
      const [position, completed, ownerId, editionId] = this.values as [
        number,
        number,
        string,
        string,
      ];
      const row = this.db.editions.find(
        (entry) => entry.owner_id === ownerId && entry.id === editionId,
      );
      if (row) {
        row.position = position;
        row.completed = completed;
        changes = 1;
      }
    }
    return { meta: { changes } };
  }

  async first<T>(): Promise<T | null> {
    if (this.query.startsWith("SELECT id, owner_id")) {
      const [ownerId, editionId] = this.values as [string, string];
      return (
        (this.db.editions.find((row) => row.owner_id === ownerId && row.id === editionId) as
          T | undefined) ?? null
      );
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.query.startsWith("SELECT owner_id, edition_id, content_id")) {
      const [ownerId, editionId] = this.values as [string, string];
      return {
        results: this.db.items
          .filter((row) => row.owner_id === ownerId && row.edition_id === editionId)
          .sort((left, right) => left.position - right.position) as T[],
      };
    }
    if (this.query.startsWith("SELECT decision_key, content_id")) {
      const [ownerId, editionId] = this.values as [string, string];
      return {
        results: this.db.decisions
          .filter((row) => row.owner_id === ownerId && row.edition_id === editionId)
          .sort((left, right) => left.decision_key.localeCompare(right.decision_key)) as T[],
      };
    }
    if (this.query.startsWith("SELECT id FROM editions")) {
      const [ownerId] = this.values as [string];
      return {
        results: this.db.editions
          .filter((row) => row.owner_id === ownerId)
          .sort(
            (left, right) =>
              left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id),
          ) as T[],
      };
    }
    return { results: [] };
  }
}

describe("D1 edition repository", () => {
  it("round-trips settings, progress, completion, and decisions across fresh instances", async () => {
    const database = new FakeD1();
    const decisions = [
      decision("content#0", "content", true),
      decision("content#1", "content", false),
    ];

    await new D1EditionRepository(database).saveEdition(slate(), decisions);
    expect(database.lastBatchSize).toBe(6);

    const loaded = await new D1EditionRepository(database).getEdition("owner", "edition-d1");
    expect(loaded).toEqual(slate());
    expect(await new D1EditionRepository(database).getDecisions("owner", "edition-d1")).toEqual(
      decisions,
    );

    const positioned = await new D1EditionRepository(database).setPosition(
      "owner",
      "edition-d1",
      99,
    );
    expect(positioned).toMatchObject({ position: 1, completed: true });

    const resumed = await new D1EditionRepository(database).resume("owner", "edition-d1");
    expect(resumed).toMatchObject({ position: 1, completed: true, currentItem: undefined });

    await new D1EditionRepository(database).markComplete("owner", "edition-d1");
    expect(await new D1EditionRepository(database).resume("owner", "edition-d1")).toMatchObject({
      position: 1,
      completed: true,
    });
  });

  it("isolates same edition ids, item replacement, decisions, and progress by owner", async () => {
    const database = new FakeD1();
    const repository = new D1EditionRepository(database);
    const ownerSlate = slate("shared-id", "owner", "owner-content");
    const otherSlate = slate("shared-id", "other", "other-content");

    await repository.saveEdition(ownerSlate, [decision("owner#0", "owner-content", true)]);
    await repository.saveEdition(otherSlate, [decision("other#0", "other-content", true)]);
    await repository.setPosition("owner", "shared-id", 1);

    expect(await new D1EditionRepository(database).getEdition("owner", "shared-id")).toEqual(
      ownerSlate,
    );
    expect(await new D1EditionRepository(database).getEdition("other", "shared-id")).toEqual(
      otherSlate,
    );
    expect(
      await new D1EditionRepository(database).getEdition("unknown", "shared-id"),
    ).toBeUndefined();
    expect(await new D1EditionRepository(database).getDecisions("owner", "shared-id")).toEqual([
      decision("owner#0", "owner-content", true),
    ]);
    expect(await new D1EditionRepository(database).resume("other", "shared-id")).toMatchObject({
      position: 0,
      completed: false,
    });

    await new D1EditionRepository(database).saveEdition(ownerSlate, [
      decision("owner#1", "owner-content", false),
    ]);
    expect(await new D1EditionRepository(database).getDecisions("other", "shared-id")).toEqual([
      decision("other#0", "other-content", true),
    ]);
  });
});
