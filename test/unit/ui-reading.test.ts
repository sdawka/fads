import { describe, expect, it } from "vitest";

import {
  describeDecisionFactor,
  describeControlValue,
  isSafeExternalUrl,
  moveReader,
  safeExternalLinkAttributes,
} from "../../src/components";

describe("reading controls", () => {
  it("describes curiosity and energy values in human language", () => {
    expect(describeControlValue("curiosity", 0)).toBe("familiar ground");
    expect(describeControlValue("curiosity", 64)).toBe("open to detours");
    expect(describeControlValue("energy", 100)).toBe("ready to concentrate");
  });

  it("describes signed ranking contributions without inventing percentages", () => {
    expect(
      describeDecisionFactor({
        factor: "manual-interest:systems",
        weight: 0.36,
        provenance: { source: "manual", observedAt: "2026-08-28T00:00:00.000Z" },
      }),
    ).toBe("+0.36 score · manual");
    expect(
      describeDecisionFactor({
        factor: "source-muted",
        weight: -1,
        provenance: { source: "policy", observedAt: "2026-08-28T00:00:00.000Z" },
      }),
    ).toBe("−1.00 score · policy");
  });

  it("stops at the finite end instead of continuing into another edition", () => {
    expect(moveReader({ position: 1, total: 2 }, "next")).toEqual({
      position: 1,
      atEnd: true,
    });
    expect(moveReader({ position: 0, total: 2 }, "previous")).toEqual({
      position: 0,
      atEnd: false,
    });
  });
});

describe("safe external links", () => {
  it("permits only credential-free HTTP(S) destinations", () => {
    expect(isSafeExternalUrl("https://example.com/essay")).toBe(true);
    expect(isSafeExternalUrl("https://person:secret@example.com/")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,hello")).toBe(false);
  });

  it("always isolates a new browsing context", () => {
    expect(safeExternalLinkAttributes("https://example.com/")).toEqual({
      href: "https://example.com/",
      target: "_blank",
      rel: "noopener noreferrer",
    });
    expect(safeExternalLinkAttributes("javascript:alert(1)")).toBeUndefined();
  });
});
