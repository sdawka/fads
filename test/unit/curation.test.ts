import { describe, expect, it } from "vitest";
import {
  CurationEngine,
  ManualContentEnricher,
  deriveBootstrapSuggestions,
  estimateStructuralEnergy,
  mapCuriosityToExplorationSlots,
  type CurationProfile,
} from "../../src/modules/curation";
import type { ContentEnvelope } from "../../src/contracts";

const requestedAt = "2026-08-28T12:00:00.000Z";

function content(
  id: string,
  sourceId: string,
  tag: string,
  block: ContentEnvelope["blocks"][number] = { kind: "paragraph", text: `${id} body` },
): ContentEnvelope {
  return {
    id,
    canonicalUri: `https://example.com/${id}`,
    sourceId,
    publishedAt: requestedAt,
    capturedAt: requestedAt,
    blocks: [block],
    media: [],
    tags: [{ value: tag, provenance: { source: "owner", observedAt: requestedAt } }],
    labels: [],
  };
}

describe("deterministic curation", () => {
  it("reproduces ordered recommendations and traces for the same state and seed", () => {
    const items = [
      content("a", "one", "systems"),
      content("b", "two", "art"),
      content("c", "three", "systems"),
    ];
    const request = {
      ownerId: "owner",
      requestedAt,
      curiosity: 50,
      energy: 45,
      limit: 3,
    } as const;
    const profile: CurationProfile = { manualInterests: ["systems"] };
    const first = new CurationEngine().generate(request, items, { ...profile, seed: "fixed" });
    const second = new CurationEngine().generate(request, items, { ...profile, seed: "fixed" });

    expect(first).toEqual(second);
  });

  it("accepts a request-level seed for deterministic variation", () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      content(`seed-${index}`, `source-${index}`, "tag"),
    );
    const base = { ownerId: "owner", requestedAt, curiosity: 0, energy: 50, limit: 1 } as const;
    const outputs = new Set(
      ["request-a", "request-b", "request-c"].map((seed) =>
        new CurationEngine()
          .generate({ ...base, seed }, items, { manualInterests: ["tag"] })
          .slate.items.map((recommendation) => recommendation.contentId)
          .join(","),
      ),
    );

    expect(outputs.size).toBeGreaterThan(1);
  });

  it("applies every hard gate before scoring, including at maximum curiosity", () => {
    const items = [
      content("labelled", "safe", "systems"),
      content("muted", "muted-source", "systems"),
      { ...content("empty", "safe", "systems"), blocks: [] },
      content("later", "safe", "systems"),
      content("shown", "safe", "systems"),
      content("duplicate-a", "safe", "systems"),
      content("duplicate-b", "safe", "systems"),
      content("fresh", "fresh-source", "systems"),
    ];
    items[0].labels = [
      { value: "spoiler", provenance: { source: "labels", observedAt: requestedAt } },
    ];
    items[3].canonicalUri = "https://example.com/later";
    items[4].canonicalUri = "https://example.com/shown";
    items[5].canonicalUri = "https://example.com/same";
    items[6].canonicalUri = "https://example.com/same";

    const result = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 12 },
      items,
      {
        seed: "gate-proof",
        configuredLabels: ["spoiler"],
        mutedSources: ["muted-source"],
        notNow: [{ contentId: "later", until: "2026-09-04T12:00:00.000Z" }],
        recentlyShown: [{ contentId: "shown", shownAt: "2026-08-20T12:00:00.000Z" }],
      },
    );

    expect(result.slate.items).toHaveLength(2);
    expect(new Set(result.slate.items.map((item) => item.contentId))).toEqual(
      new Set(["duplicate-a", "fresh"]),
    );
    expect(result.excluded.map((decision) => decision.reason)).toEqual([
      "configured-label",
      "muted-source",
      "missing-content",
      "not-now",
      "already-shown",
      "duplicate-canonical",
    ]);
    const labelledTrace = result.excluded.find(
      (decision) => decision.reason === "configured-label",
    )?.decisionTrace;
    expect(labelledTrace?.factors).toEqual(
      expect.arrayContaining([expect.objectContaining({ factor: "label:spoiler", weight: 0 })]),
    );
    expect(
      labelledTrace?.factors.find((factor) => factor.factor === "label:spoiler")?.provenance,
    ).toMatchObject({
      source: "labels",
      observedAt: requestedAt,
      reference: "https://example.com/labelled",
    });
    const mutedTrace = result.excluded.find(
      (decision) => decision.reason === "muted-source",
    )?.decisionTrace;
    expect(mutedTrace?.factors.map((factor) => factor.factor)).toContain("source:muted-source");
  });

  it("checks content and canonical suppression aliases independently", () => {
    const candidate = content("alias-id", "source", "systems");
    candidate.canonicalUri = "https://example.com/alias";
    const notNowResult = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 12 },
      [candidate],
      {
        notNow: [
          { contentId: "alias-id", until: "not-a-date" },
          { canonicalUri: candidate.canonicalUri, until: "2026-09-01T12:00:00.000Z" },
        ],
      },
    );
    const shownResult = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 12 },
      [candidate],
      {
        recentlyShown: [
          { contentId: "alias-id", shownAt: "not-a-date" },
          { canonicalUri: candidate.canonicalUri, shownAt: "2026-08-20T12:00:00.000Z" },
        ],
      },
    );

    expect(notNowResult.slate.items).toEqual([]);
    expect(notNowResult.excluded[0]?.reason).toBe("not-now");
    expect(
      notNowResult.excluded[0]?.decisionTrace.factors.map((factor) => factor.factor),
    ).toContain("not-now-until:2026-09-01T12:00:00.000Z");
    expect(shownResult.slate.items).toEqual([]);
    expect(shownResult.excluded[0]?.reason).toBe("already-shown");
    expect(shownResult.excluded[0]?.decisionTrace.factors.map((factor) => factor.factor)).toContain(
      "shown-at:2026-08-20T12:00:00.000Z",
    );
  });

  it("honors exact seven-day and thirty-day suppression boundaries", () => {
    const candidate = content("boundary", "source", "systems");
    const notNowBoundary = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 1 },
      [candidate],
      { notNow: [{ contentId: candidate.id, until: requestedAt }] },
    );
    const shownBoundary = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 1 },
      [candidate],
      { recentlyShown: [{ contentId: candidate.id, shownAt: "2026-07-29T12:00:00.000Z" }] },
    );

    expect(notNowBoundary.slate.items).toHaveLength(1);
    expect(shownBoundary.slate.items).toHaveLength(1);
  });

  it("records numeric scoring contributions and named matched factors", () => {
    const candidate = content("trace", "source", "systems");
    const result = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 0, energy: 18, limit: 1 },
      [candidate],
      {
        manualInterests: ["systems"],
        learnedAdjustments: {
          "tag:systems": 3,
          "source:source": -2,
          "format:text": 1,
          "content:trace": 4,
        },
      },
    );

    const decision = result.decisions.find((entry) => entry.selected);
    const factors = decision?.decisionTrace.factors ?? [];
    expect(factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ factor: "interest-match", weight: 36 }),
        expect.objectContaining({ factor: "interest:systems", weight: 36 }),
        expect.objectContaining({ factor: "freshness", weight: 20 }),
        expect.objectContaining({ factor: "energy-fit", weight: 30 }),
        expect.objectContaining({ factor: "learned:tag:systems", weight: 3 }),
        expect.objectContaining({ factor: "learned:source:source", weight: -2 }),
        expect.objectContaining({ factor: "learned:format:text", weight: 1 }),
        expect.objectContaining({ factor: "learned:content:trace", weight: 4 }),
      ]),
    );
    expect(factors.some((factor) => /probability|confidence/i.test(factor.factor))).toBe(false);
  });

  it("retains duplicate-id decisions under distinct stable keys", () => {
    const first = content("same", "source-a", "systems");
    const second = content("same", "source-b", "systems");
    second.canonicalUri = "https://example.com/other";
    const result = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 0, energy: 50, limit: 12 },
      [first, second],
      { seed: "duplicate" },
    );

    expect(result.decisions).toHaveLength(2);
    expect(new Set(result.decisions.map((decision) => decision.decisionKey)).size).toBe(2);
    expect(result.decisions.map((decision) => decision.contentId)).toEqual(["same", "same"]);
    expect(result.traces.size).toBe(2);
  });

  it("traces malformed unsafe candidates without throwing while evaluating policy", () => {
    const malformed = undefined as unknown as ContentEnvelope;
    const result = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 12 },
      [malformed],
      { seed: "unsafe" },
    );

    expect(result.slate.items).toEqual([]);
    expect(result.excluded[0]).toMatchObject({ selected: false, reason: "unsafe-content" });
    expect(result.excluded[0]?.decisionTrace.factors[0]?.factor).toBe("excluded:unsafe-content");
  });

  it("maps curiosity monotonically from zero through five exploration slots", () => {
    const slots = [0, 1, 24, 25, 50, 75, 100].map(mapCuriosityToExplorationSlots);

    expect(slots).toEqual([0, 1, 2, 2, 3, 4, 5]);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
  });

  it("selects no surprise when curiosity is zero", () => {
    const result = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 0, energy: 18, limit: 2 },
      [content("familiar", "source-a", "known"), content("surprise", "source-b", "adjacent")],
      { seed: "no-surprise", manualInterests: ["known"] },
    );

    expect(result.slate.items.map((item) => item.contentId)).toEqual(["familiar"]);
    expect(
      result.slate.items.flatMap((item) =>
        item.decisionTrace.factors.map((factor) => factor.factor),
      ),
    ).not.toContain("exploration");
  });

  it("requires useful surprises and never spills past the curiosity quota", () => {
    const staleSurprise = content("stale-surprise", "surprise-stale", "adjacent", {
      kind: "video",
      src: "https://example.com/stale.mp4",
    });
    staleSurprise.publishedAt = "2020-01-01T00:00:00.000Z";
    const result = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 1, energy: 18, limit: 12 },
      [
        content("familiar-a", "familiar-a", "known"),
        content("familiar-b", "familiar-b", "known"),
        content("useful-surprise-a", "surprise-a", "adjacent"),
        content("useful-surprise-b", "surprise-b", "adjacent"),
        content("useful-surprise-c", "surprise-c", "adjacent"),
        staleSurprise,
      ],
      { seed: "bounded-surprise", manualInterests: ["known"] },
    );
    const surprises = result.slate.items.filter((item) =>
      item.decisionTrace.factors.some((factor) => factor.factor === "exploration"),
    );

    expect(surprises).toHaveLength(1);
    expect(result.slate.items).toHaveLength(3);
    expect(result.slate.items.map((item) => item.contentId)).not.toContain("stale-surprise");
  });

  it("keeps reserved exploration slots, source caps, format diversity, and truthful short pools", () => {
    const items = [
      content("text-1", "source-a", "known"),
      content("text-2", "source-a", "known"),
      content("text-3", "source-a", "known"),
      content("quote", "source-b", "unfamiliar", { kind: "quote", text: "A quote" }),
      content("image", "source-c", "unfamiliar", {
        kind: "image",
        src: "https://example.com/a.jpg",
        alt: "art",
      }),
    ];

    const result = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 100, energy: 50, limit: 12 },
      items,
      { seed: "quota", manualInterests: ["known"] },
    );

    expect(result.slate.items).toHaveLength(4);
    expect(
      result.slate.items.filter((item) => ["quote", "image"].includes(item.contentId)),
    ).toHaveLength(2);
    expect(
      result.slate.items.filter((item) => item.contentId.startsWith("text")).length,
    ).toBeLessThanOrEqual(2);
    expect(new Set(result.slate.items.map((item) => item.frame)).size).toBeGreaterThan(1);
    expect(result.slate.items.map((item) => item.position)).toEqual([0, 1, 2, 3]);
  });

  it("uses structural format, length, density, and media for energy without sentiment inference", () => {
    const quiet = content("quiet", "source", "tag", { kind: "paragraph", text: "short" });
    const electric = {
      ...content("electric", "source", "tag", { kind: "video", src: "https://example.com/v.mp4" }),
      blocks: [
        { kind: "video", src: "https://example.com/v.mp4" } as const,
        { kind: "paragraph", text: "x".repeat(8000) } as const,
      ],
      media: [
        {
          id: "media",
          kind: "video" as const,
          url: "https://example.com/v.mp4",
          provenance: { source: "feed", observedAt: requestedAt },
        },
      ],
    };

    expect(estimateStructuralEnergy(quiet)).toBeLessThan(estimateStructuralEnergy(electric));
    expect(
      new CurationEngine().generate(
        { ownerId: "owner", requestedAt, curiosity: 0, energy: 0, limit: 1 },
        [quiet, electric],
        { seed: "seed-13", manualInterests: ["tag"] },
      ).slate.items[0]?.contentId,
    ).toBe("quiet");
    expect(
      new CurationEngine().generate(
        { ownerId: "owner", requestedAt, curiosity: 0, energy: 100, limit: 1 },
        [quiet, electric],
        { seed: "seed-13", manualInterests: ["tag"] },
      ).slate.items[0]?.contentId,
    ).toBe("electric");
  });

  it("keeps bootstrap suggestions proposed until explicitly confirmed", () => {
    const evidence = [
      {
        sourceId: "source",
        subjectUri: "https://example.com/a",
        observedAt: requestedAt,
        tags: [{ value: "systems", provenance: { source: "source", observedAt: requestedAt } }],
      },
    ];
    const suggestions = deriveBootstrapSuggestions(evidence);
    expect(suggestions[0]).toMatchObject({ value: "systems", confirmed: false });

    const items = [content("systems", "source", "systems")];
    const proposed = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 0, energy: 50, limit: 1 },
      items,
      { seed: "bootstrap", proposedInterests: ["systems"] },
    );
    const confirmed = new CurationEngine().generate(
      { ownerId: "owner", requestedAt, curiosity: 0, energy: 50, limit: 1 },
      items,
      { seed: "bootstrap", confirmedInterests: ["systems"] },
    );

    expect(proposed.slate.items).toEqual([]);
    expect(
      confirmed.slate.items[0]?.decisionTrace.factors.map((factor) => factor.factor),
    ).toContain("interest-match");
  });

  it("preserves the owner's observed tag spelling while grouping suggestions case-insensitively", () => {
    const suggestions = deriveBootstrapSuggestions([
      {
        sourceId: "source",
        subjectUri: "https://example.com/a",
        observedAt: requestedAt,
        tags: [
          { value: "Systems", provenance: { source: "source", observedAt: requestedAt } },
          { value: "systems", provenance: { source: "source", observedAt: requestedAt } },
        ],
      },
    ]);

    expect(suggestions).toMatchObject([{ value: "Systems", evidenceCount: 2 }]);
  });

  it("adds only confirmed manual tags with provenance", async () => {
    const enricher = new ManualContentEnricher({ article: ["systems"] });
    const patches = await enricher.enrich([content("article", "source", "feed")], {
      ownerId: "owner",
      requestedAt,
    });

    expect(patches).toEqual([
      {
        contentId: "article",
        tags: [
          {
            value: "systems",
            provenance: {
              source: "owner",
              observedAt: requestedAt,
              reference: "https://example.com/article",
            },
          },
        ],
      },
    ]);
  });

  it("ignores empty manual tag values instead of creating invalid patches", async () => {
    const enricher = new ManualContentEnricher({ article: ["  "] });

    await expect(
      enricher.enrich([content("article", "source", "feed")], { ownerId: "owner", requestedAt }),
    ).resolves.toEqual([]);
  });
});
