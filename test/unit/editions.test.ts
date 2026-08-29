import { describe, expect, it } from "vitest";
import { MemoryEditionRepository } from "../../src/modules/editions";
import type { DecisionTrace, RecommendationSlate } from "../../src/contracts";
import type { CandidateDecision } from "../../src/modules/curation";

const createdAt = "2026-08-28T12:00:00.000Z";

function slate(id = "edition-1", count = 2, ownerId = "owner"): RecommendationSlate {
  return {
    id,
    ownerId,
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

function decision(decisionKey: string, contentId: string, selected = false): CandidateDecision {
  const trace: DecisionTrace = {
    factors: [
      {
        factor: selected ? "selected" : "excluded:not-selected",
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
    decisionTrace: trace,
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

  it("keeps same edition ids and lossless decisions isolated by owner", async () => {
    const repository = new MemoryEditionRepository();
    const ownerEdition = slate("shared-id", 1, "owner");
    const otherEdition = slate("shared-id", 1, "other");
    otherEdition.items[0] = { ...otherEdition.items[0]!, contentId: "other-content" };

    await repository.saveEdition(ownerEdition, [decision("same#0", "owner-content", true)]);
    await repository.saveEdition(otherEdition, [
      decision("same#0", "other-content", false),
      decision("same#1", "other-content", false),
    ]);

    expect(await repository.getEdition("owner", "shared-id")).toEqual(ownerEdition);
    expect(await repository.getEdition("other", "shared-id")).toEqual(otherEdition);
    expect(await repository.getEdition("unknown", "shared-id")).toBeUndefined();
    expect(await repository.getDecisions("owner", "shared-id")).toHaveLength(1);
    expect(await repository.getDecisions("other", "shared-id")).toHaveLength(2);
  });
});
