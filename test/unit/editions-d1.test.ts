import { describe, expect, it } from "vitest";
import {
  D1EditionRepository,
  type D1DatabaseLike,
  type D1StatementLike,
} from "../../src/modules/editions";
import type { RecommendationSlate } from "../../src/contracts";

const createdAt = "2026-08-28T12:00:00.000Z";

function slate(): RecommendationSlate {
  return {
    id: "edition-d1",
    ownerId: "owner",
    createdAt,
    curiosity: 80,
    energy: 20,
    items: [
      {
        id: "edition-d1:item",
        contentId: "content",
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

class FakeD1 implements D1DatabaseLike {
  editions: Array<Record<string, string>> = [];
  items: Array<Record<string, string | number>> = [];
  keeps: Array<Record<string, string>> = [];

  prepare(query: string): D1StatementLike {
    return new FakeStatement(this, query);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
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
    if (this.query.startsWith("INSERT INTO editions")) {
      const [id, ownerId, requestedAt, trace, createdAt] = this.values as string[];
      this.db.editions = this.db.editions.filter((row) => row.id !== id);
      this.db.editions.push({
        id,
        owner_id: ownerId,
        requested_at: requestedAt,
        trace_json: trace,
        created_at: createdAt,
      });
    } else if (this.query.startsWith("DELETE FROM edition_items")) {
      this.db.items = this.db.items.filter((row) => row.edition_id !== this.values[0]);
    } else if (this.query.startsWith("INSERT INTO edition_items")) {
      const [editionId, contentId, position, recommendation] = this.values as [
        string,
        string,
        number,
        string,
      ];
      this.db.items.push({
        edition_id: editionId,
        content_id: contentId,
        position,
        recommendation_json: recommendation,
      });
    }
    return { meta: { changes: 1 } };
  }

  async first<T>(): Promise<T | null> {
    if (this.query.startsWith("SELECT id, owner_id")) {
      const [ownerId, editionId] = this.values as string[];
      return (
        (this.db.editions.find((row) => row.owner_id === ownerId && row.id === editionId) as
          T | undefined) ?? null
      );
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.query.startsWith("SELECT content_id, recommendation_json")) {
      const [editionId] = this.values;
      const results = this.db.items
        .filter((row) => row.edition_id === editionId)
        .sort((left, right) => Number(left.position) - Number(right.position)) as T[];
      return { results };
    }
    if (this.query.startsWith("SELECT id FROM editions")) {
      const [ownerId] = this.values;
      return { results: this.db.editions.filter((row) => row.owner_id === ownerId) as T[] };
    }
    return { results: [] };
  }
}

describe("D1 edition repository", () => {
  it("round-trips edition request settings while saving items in one batch", async () => {
    const database = new FakeD1();
    const repository = new D1EditionRepository(database);

    await repository.saveEdition(slate());
    const loaded = await repository.getEdition("owner", "edition-d1");

    expect(loaded).toEqual(slate());
    expect(database.items).toHaveLength(1);
  });
});
