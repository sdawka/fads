import { describe, expect, it } from "vitest";
import { MemoryEditionRepository } from "../../src/modules/editions";
import type { RecommendationSlate } from "../../src/contracts";

const createdAt = "2026-08-28T12:00:00.000Z";

function slate(id = "edition-1", count = 2): RecommendationSlate {
  return {
    id,
    ownerId: "owner",
    createdAt,
    curiosity: 50,
    energy: 50,
    items: Array.from({ length: count }, (_, position) => ({
      id: `${id}-item-${position}`,
      contentId: `content-${position}`,
      frame: "text",
      position,
      decisionTrace: {
        factors: [
          {
            factor: "selected",
            weight: 1,
            provenance: { source: "curation", observedAt: createdAt },
          },
        ],
      },
    })),
    decisionTrace: {
      factors: [
        {
          factor: "edition",
          weight: count,
          provenance: { source: "curation", observedAt: createdAt },
        },
      ],
    },
  };
}

describe("edition repository lifecycle", () => {
  it("saves atomically, resumes and clamps position, and marks complete", async () => {
    const repository = new MemoryEditionRepository();
    const edition = slate();

    await repository.saveEdition(edition);
    expect(await repository.getEdition("owner", edition.id)).toEqual(edition);

    expect(await repository.resume("owner", edition.id)).toMatchObject({
      position: 0,
      completed: false,
    });
    expect(await repository.setPosition("owner", edition.id, 99)).toMatchObject({
      position: 2,
      completed: true,
    });
    expect(await repository.resume("owner", edition.id)).toMatchObject({
      position: 2,
      completed: true,
    });

    await repository.markComplete("owner", edition.id);
    expect(await repository.resume("owner", edition.id)).toMatchObject({
      position: 2,
      completed: true,
    });
  });

  it("does not mark an empty edition complete until its lifecycle is explicitly completed", async () => {
    const repository = new MemoryEditionRepository();
    await repository.saveEdition(slate("empty", 0));

    expect(await repository.resume("owner", "empty")).toMatchObject({
      position: 0,
      completed: false,
    });
    await repository.markComplete("owner", "empty");
    expect(await repository.resume("owner", "empty")).toMatchObject({
      position: 0,
      completed: true,
    });
  });

  it("validates traces before mutating the repository", async () => {
    const repository = new MemoryEditionRepository();
    const invalidTrace = {
      factors: [
        { factor: "", weight: Number.NaN, provenance: { source: "", observedAt: createdAt } },
      ],
    };

    await expect(
      repository.saveEdition(slate("invalid"), new Map([["content-0", invalidTrace]])),
    ).rejects.toThrow();
    await expect(repository.getEdition("owner", "invalid")).resolves.toBeUndefined();
  });

  it("isolates idempotent keep writes and removal by owner", async () => {
    const repository = new MemoryEditionRepository();

    await repository.saveKeep("owner", "content", createdAt);
    await repository.saveKeep("owner", "content", createdAt);
    await repository.saveKeep("owner", "content", "2026-08-29T12:00:00.000Z");
    await repository.saveKeep("other", "content", createdAt);

    expect(await repository.listKeeps("owner")).toEqual([
      { ownerId: "owner", contentId: "content", keptAt: "2026-08-29T12:00:00.000Z" },
    ]);
    expect(await repository.listKeeps("other")).toEqual([
      { ownerId: "other", contentId: "content", keptAt: createdAt },
    ]);

    await repository.removeKeep("owner", "content");
    expect(await repository.listKeeps("owner")).toEqual([]);
    expect(await repository.listKeeps("other")).not.toEqual([]);
  });
});
