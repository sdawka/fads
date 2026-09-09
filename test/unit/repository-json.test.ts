import { describe, expect, it } from "vitest";
import {
  serializeBlocks,
  serializeDecisionTrace,
  serializeMedia,
} from "../../src/repositories/json";

const timestamp = "2026-08-28T12:00:00.000Z";

describe("repository JSON boundaries", () => {
  it("serializes validated blocks, media, and decision traces as JSON text", () => {
    expect(serializeBlocks([{ kind: "paragraph", text: "A careful note" }])).toBe(
      '[{"kind":"paragraph","text":"A careful note"}]',
    );
    expect(
      serializeMedia([
        {
          id: "media-1",
          kind: "image",
          url: "https://example.com/cover.jpg",
          provenance: { source: "atproto", observedAt: timestamp },
        },
      ]),
    ).toContain('"media-1"');
    expect(
      serializeDecisionTrace({
        factors: [
          {
            factor: "freshness",
            weight: 0.4,
            provenance: { source: "ranker", observedAt: timestamp },
          },
        ],
      }),
    ).toContain('"freshness"');
  });

  it("refuses executable block data before it can reach a JSON column", () => {
    expect(() => serializeBlocks([{ kind: "script", code: "alert(1)" }])).toThrow();
  });
});
