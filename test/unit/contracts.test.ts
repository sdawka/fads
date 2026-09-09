import { describe, expect, it } from "vitest";
import {
  ContentEnvelopeSchema,
  EditionRequestSchema,
  InteractionEventSchema,
  MediaAttachmentSchema,
  ProvenanceSchema,
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

  it("rejects unsafe renderable URL protocols", () => {
    const unsafeUrls = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"];

    for (const url of unsafeUrls) {
      expect(SafeBlockSchema.safeParse({ kind: "link", href: url, text: "unsafe" }).success).toBe(
        false,
      );
      expect(
        MediaAttachmentSchema.safeParse({
          id: "media-1",
          kind: "image",
          url,
          provenance: { source: "atproto", observedAt: timestamp },
        }).success,
      ).toBe(false);
    }
  });

  it("accepts canonical AT URIs as non-rendered provenance references", () => {
    expect(
      ProvenanceSchema.safeParse({
        source: "atproto",
        observedAt: timestamp,
        reference: "at://did:plc:alice/app.bsky.feed.post/1",
      }).success,
    ).toBe(true);
  });

  it("rejects executable extra fields instead of stripping them", () => {
    expect(
      SafeBlockSchema.safeParse({
        kind: "paragraph",
        text: "A paragraph",
        html: "<script>alert(1)</script>",
      }).success,
    ).toBe(false);
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

  it("defaults an edition request to the approved 12-item size", () => {
    const request = EditionRequestSchema.parse({
      ownerId: "owner-1",
      requestedAt: timestamp,
      curiosity: 50,
      energy: 50,
    });

    expect(request.limit).toBe(12);
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
