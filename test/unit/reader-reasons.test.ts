import { describeReasons } from "../../src/components/reader/reasons";
import { expect, it } from "vitest";

it("explains contributing evidence without inventing reasons from zero or negative weights", () => {
  const provenance = { source: "test", observedAt: "2026-09-08T12:00:00Z" };
  expect(
    describeReasons({
      factors: [
        { factor: "interest:gardening", weight: 36, provenance },
        { factor: "energy-fit", weight: 12, provenance },
        { factor: "freshness", weight: 0, provenance },
        { factor: "learned:source:muted", weight: -2, provenance },
      ],
    }),
  ).toEqual(["Matches your interest in gardening.", "Fits the reading energy you chose."]);
});

it("distinguishes an exploration choice from a guaranteed taste match", () => {
  expect(
    describeReasons({
      factors: [
        {
          factor: "exploration",
          weight: 1,
          provenance: { source: "test", observedAt: "2026-09-08T12:00:00Z" },
        },
      ],
    }),
  ).toEqual(["A deliberate detour within your allowed sources and content."]);
});
