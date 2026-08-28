import { describe, expect, it } from "vitest";
import {
  ContentEnvelopeSchema,
  InteractionEventSchema,
  QueueMessageSchema,
  RecommendationSlateSchema,
  SafeBlockSchema,
} from "../../src/contracts";

const timestamp = "2026-08-28T12:00:00.000Z";

describe("foundation contracts", () => {
  it("accepts a provenance-bearing content envelope with safe blocks", () => {
    const result = ContentEnvelopeSchema.safeParse({
      id: "post-1",
      canonicalUri: "at://did:plc:alice/app.bsky.feed.post/1",
      sourceId: "atproto",
      publishedAt: timestamp,
      capturedAt: timestamp,
      blocks: [
        { kind: "heading", text: "A lucid heading" },
        { kind: "link", href: "https://example.com/essay", text: "Read it" },
      ],
      tags: [{ value: "systems", provenance: { source: "atproto", observedAt: timestamp } }],
      labels: [{ value: "general", provenance: { source: "atproto", observedAt: timestamp } }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects executable SafeBlock payloads", () => {
    const result = SafeBlockSchema.safeParse({ kind: "html", html: "<script>alert(1)</script>" });

    expect(result.success).toBe(false);
  });

  it("rejects curiosity and energy outside the 0..100 integer range", () => {
    const result = RecommendationSlateSchema.safeParse({
      id: "slate-1",
      ownerId: "owner-1",
      createdAt: timestamp,
      curiosity: 101,
      energy: 60,
      items: [],
      decisionTrace: {
        factors: [
          {
            factor: "freshness",
            weight: 0.4,
            provenance: { source: "ranker", observedAt: timestamp },
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts only the frozen interaction kinds", () => {
    const result = InteractionEventSchema.safeParse({
      id: "interaction-1",
      ownerId: "owner-1",
      kind: "good_surprise",
      occurredAt: timestamp,
      provenance: { source: "owner", observedAt: timestamp },
    });

    expect(result.success).toBe(true);
    expect(InteractionEventSchema.safeParse({ ...result.data, kind: "bookmark" }).success).toBe(
      false,
    );
  });

  it("keeps queue messages versioned and structured-clone serializable", () => {
    const message = QueueMessageSchema.parse({
      version: 1,
      kind: "sync_source",
      sourceId: "atproto",
      cursor: "cursor-1",
    });

    expect(structuredClone(message)).toEqual(message);
  });
});
