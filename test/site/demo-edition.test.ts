import { describe, expect, it } from "vitest";
import { commitDemoEdition, createDemoEdition } from "../../site/lib/demo-edition";

describe("public demo editions", () => {
  it("keeps the active edition until the selected direction is committed", () => {
    const draftChanged = {
      draftMode: "surprise" as const,
      activeMode: "familiar" as const,
      position: 2,
      completed: true,
    };
    expect(draftChanged.activeMode).toBe("familiar");
    expect(commitDemoEdition(draftChanged)).toEqual({
      draftMode: "surprise",
      activeMode: "surprise",
      position: 0,
      completed: false,
    });
  });

  it("uses the deterministic curation engine and reserves surprise stories for the detour edition", () => {
    const familiar = createDemoEdition("familiar");
    const surprise = createDemoEdition("surprise");
    expect(familiar.edition.items.map((item) => item.contentId)).toEqual(
      expect.arrayContaining(["moss-map", "paper-inventory", "window-seats"]),
    );
    expect(surprise.edition.items).toHaveLength(3);
    expect(
      surprise.edition.items.every((item) =>
        item.decisionTrace.factors.some((factor) => factor.factor === "exploration"),
      ),
    ).toBe(true);
  });
});
