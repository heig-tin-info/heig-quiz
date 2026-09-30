import { describe, expect, it } from "vitest";

import { EVALUATION_STATES } from "./itemList.js";
import {
  correctionPublishRefusal,
  feedbackGate,
  isDebriefOpen,
} from "./correction.js";

describe("isDebriefOpen (ADR-033 §1, ADR-050)", () => {
  it("opens at the close, or earlier once the correction is published", () => {
    expect(EVALUATION_STATES.filter((state) => isDebriefOpen({ state, correctionPublished: false })))
      .toEqual(["closed", "grading", "released"]);
    expect(isDebriefOpen({ state: "running", correctionPublished: true })).toBe(true);
    expect(isDebriefOpen({ state: "lobby", correctionPublished: true })).toBe(true);
  });
});

describe("correctionPublishRefusal (ADR-050)", () => {
  it("refuses an exam and a poll whatever their state, the mode first", () => {
    expect(correctionPublishRefusal({ mode: "exam", state: "running" })).toBe("exam");
    expect(correctionPublishRefusal({ mode: "poll", state: "running" })).toBe("poll");
    expect(correctionPublishRefusal({ mode: "exam", state: "draft" })).toBe("exam");
  });

  it("accepts a running exercise, paused or not, and only then", () => {
    const accepted = EVALUATION_STATES.filter(
      (state) => correctionPublishRefusal({ mode: "exercise", state }) === null,
    );
    expect(accepted).toEqual(["running", "paused"]);
    expect(correctionPublishRefusal({ mode: "exercise", state: "lobby" })).toBe("not_open");
    expect(correctionPublishRefusal({ mode: "exercise", state: "closed" })).toBe("not_open");
  });
});

describe("feedbackGate (F-RES-04, ADR-025 §4, ADR-050)", () => {
  const base = {
    attemptOpen: false,
    retakesOpen: false,
    released: false,
    correctionPublished: false,
  } as const;

  describe("without retakes", () => {
    it("on_release: pending until the release, or until the correction is published", () => {
      expect(feedbackGate({ ...base, when: "on_release" })).toEqual({
        ok: false,
        reason: "results_pending",
      });
      expect(feedbackGate({ ...base, when: "on_release", released: true })).toEqual({ ok: true });
      expect(feedbackGate({ ...base, when: "on_release", correctionPublished: true })).toEqual({
        ok: true,
      });
    });

    it("immediate: at the hand-in, published or not", () => {
      expect(feedbackGate({ ...base, when: "immediate" })).toEqual({ ok: true });
      expect(feedbackGate({ ...base, when: "immediate", correctionPublished: true })).toEqual({
        ok: true,
      });
    });

    it("none: nothing, even published", () => {
      expect(feedbackGate({ ...base, when: "none", correctionPublished: true })).toEqual({
        ok: false,
        reason: "no_feedback",
      });
    });

    it("an attempt still open reads nothing, even published", () => {
      for (const when of ["on_release", "immediate"] as const) {
        expect(
          feedbackGate({ ...base, when, attemptOpen: true, correctionPublished: true }),
        ).toEqual({ ok: false, reason: "attempt_open" });
      }
    });
  });

  describe("an exercise with retakes, open", () => {
    const open = { ...base, retakesOpen: true } as const;

    it("reads the score only until the correction is published, whatever the policy", () => {
      for (const when of ["none", "on_release", "immediate"] as const) {
        expect(feedbackGate({ ...open, when })).toEqual({ ok: false, reason: "retakes_open" });
      }
    });

    it("reads the correction once it is published, under on_release and immediate", () => {
      for (const when of ["on_release", "immediate"] as const) {
        expect(feedbackGate({ ...open, when, correctionPublished: true })).toEqual({ ok: true });
      }
    });

    it("keeps the score under none once published: the retakes still need it", () => {
      expect(feedbackGate({ ...open, when: "none", correctionPublished: true })).toEqual({
        ok: false,
        reason: "retakes_open",
      });
    });

    it("an attempt in progress reads nothing, published or not", () => {
      for (const correctionPublished of [false, true]) {
        expect(
          feedbackGate({ ...open, when: "on_release", attemptOpen: true, correctionPublished }),
        ).toEqual({ ok: false, reason: "attempt_open" });
      }
    });
  });
});
