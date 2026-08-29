import { describe, expect, it } from "vitest";

import {
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
