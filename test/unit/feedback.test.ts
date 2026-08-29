import { describe, expect, it } from "vitest";
import { applyInteraction, createFeedbackState, resetFeedback } from "../../src/modules/feedback";
import type { InteractionEvent } from "../../src/contracts";

const first = "2026-08-28T12:00:00.000Z";

function event(
  kind: InteractionEvent["kind"],
  id: string,
  extra: Partial<InteractionEvent> = {},
): InteractionEvent {
  return {
    id,
    ownerId: "owner",
    contentId: "content",
    sourceId: "source",
    kind,
    occurredAt: first,
    provenance: { source: "owner", observedAt: first },
    ...extra,
  };
}

describe("feedback state", () => {
  it("changes learned taste only for directional interactions", () => {
    const initial = createFeedbackState({ ownerId: "owner", manualInterests: ["manual"] });
    const more = applyInteraction(initial, event("more_like_this", "more"));
    const less = applyInteraction(initial, event("less_like_this", "less"));
    const surprise = applyInteraction(initial, event("good_surprise", "surprise"));
    const keep = applyInteraction(more, event("keep", "keep"));

    expect(keep.learnedAdjustments["tag:content"]).toBeUndefined();
    expect(Object.values(more.learnedAdjustments).some((value) => value > 0)).toBe(true);
    expect(Object.values(less.learnedAdjustments).some((value) => value < 0)).toBe(true);
    expect(Object.values(surprise.learnedAdjustments).some((value) => value > 0)).toBe(true);
    expect(keep.keeps).toEqual([{ ownerId: "owner", contentId: "content", keptAt: first }]);
  });

  it("suppresses not-now for seven days with an exact expiry boundary", () => {
    const state = applyInteraction(
      createFeedbackState({ ownerId: "owner" }),
      event("not_now", "later"),
    );

    expect(state.notNow.content).toBe("2026-09-04T12:00:00.000Z");
    expect(state.isSuppressed("content", "2026-09-04T11:59:59.999Z")).toBe(true);
    expect(state.isSuppressed("content", "2026-09-04T12:00:00.000Z")).toBe(false);
  });

  it("keeps mutes as hard policy and ignores duplicate event ids", () => {
    const initial = createFeedbackState({ ownerId: "owner" });
    const muted = applyInteraction(initial, event("mute_source", "mute"));
    const repeated = applyInteraction(muted, event("more_like_this", "more"));
    const duplicate = applyInteraction(repeated, event("more_like_this", "more"));

    expect(muted.mutedSources).toEqual(["source"]);
    expect(duplicate.learnedAdjustments["source:source"]).toBe(1);
    expect(duplicate).toEqual(repeated);
  });

  it("resets learned state and suppressions while retaining manual interests unless full", () => {
    let state = createFeedbackState({ ownerId: "owner", manualInterests: ["manual"] });
    state = applyInteraction(state, event("more_like_this", "more"));
    state = applyInteraction(state, event("not_now", "later"));
    state = applyInteraction(state, event("mute_source", "mute"));

    const reset = resetFeedback(state);
    expect(reset.manualInterests).toEqual(["manual"]);
    expect(reset.learnedAdjustments).toEqual({});
    expect(reset.notNow).toEqual({});
    expect(reset.mutedSources).toEqual(["source"]);

    const full = resetFeedback(state, { full: true });
    expect(full.manualInterests).toEqual([]);
    expect(full.mutedSources).toEqual([]);
    expect(full.keeps).toEqual([]);
  });
});
