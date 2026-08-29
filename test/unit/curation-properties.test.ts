import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CurationEngine } from "../../src/modules/curation";
import type { ContentEnvelope } from "../../src/contracts";

const requestedAt = "2026-08-28T12:00:00.000Z";

function item(id: string, sourceId: string, canonicalUri: string): ContentEnvelope {
  return {
    id,
    sourceId,
    canonicalUri,
    publishedAt: requestedAt,
    capturedAt: requestedAt,
    blocks: [{ kind: "paragraph", text: id }],
    media: [],
    tags: [],
    labels: [],
  };
}

describe("curation invariants", () => {
  it("keeps every generated edition within hard structural invariants", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/), { minLength: 0, maxLength: 30 }),
        (ids) => {
          const candidates = ids.map((id, index) =>
            item(id, `source-${index % 5}`, `https://example.com/${id}`),
          );
          const result = new CurationEngine().generate(
            { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 12 },
            candidates,
            { seed: "property" },
          );
          const sourceCounts = new Map<string, number>();
          for (const recommendation of result.slate.items) {
            const source = candidates.find(
              (candidate) => candidate.id === recommendation.contentId,
            )?.sourceId;
            if (source) sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
          }
          expect(result.slate.items.length).toBeLessThanOrEqual(12);
          expect(
            new Set(result.slate.items.map((recommendation) => recommendation.contentId)).size,
          ).toBe(result.slate.items.length);
          expect([...sourceCounts.values()].every((count) => count <= 2)).toBe(true);
          expect(result.slate.items.map((recommendation) => recommendation.position)).toEqual(
            result.slate.items.map((_, position) => position),
          );
          expect(
            result.slate.items.every((recommendation) =>
              result.traces.has(recommendation.contentId),
            ),
          ).toBe(true);
        },
      ),
    );
  });

  it("allows different seeds to vary eligible choices while preserving invariants", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      item(`item-${index}`, `source-${index}`, `https://example.com/${index}`),
    );
    const outputs = new Set(
      ["seed-a", "seed-b", "seed-c", "seed-d"].map((seed) =>
        new CurationEngine()
          .generate(
            { ownerId: "owner", requestedAt, curiosity: 0, energy: 50, limit: 1 },
            candidates,
            { seed },
          )
          .slate.items.map((recommendation) => recommendation.contentId)
          .join(","),
      ),
    );

    expect(outputs.size).toBeGreaterThan(1);
  });
});
