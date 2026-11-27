import { describe, expect, it } from "vitest";

import {
  acquiredItems,
  gradableNow,
  itemStanding,
  keptAttempt,
  latestAttempt,
  partialRetakeRefusal,
  partialRetakesOn,
  retakeRefusal,
  retakeScopeFits,
  retakeScopeOf,
  retakesAllowedFor,
  retakesOn,
  patchFieldWritable,
  retakesWidenableUnder,
  retakesWidening,
  settingsWidenRetakesOnly,
  type RetakeInput,
  type RetakePolicy,
  type ScoredAttempt,
} from "./retake.js";

const now = new Date("2026-09-25T10:00:00Z");

const base: RetakeInput = {
  mode: "exercise",
  retakes: { enabled: true, keep: "best", maxAttempts: null },
  evaluationState: "running",
  closesAt: null,
  now,
  attempts: [{ attemptNumber: 1, state: "submitted" }],
};

describe("retakesAllowedFor / retakesOn (F-EVAL-15)", () => {
  it("allows the setting on an exercise only", () => {
    expect(retakesAllowedFor("exercise")).toBe(true);
    expect(retakesAllowedFor("exam")).toBe(false);
    expect(retakesAllowedFor("poll")).toBe(false);
  });

  it("is off when the switch is off, and on an exam whatever the switch says", () => {
    expect(retakesOn("exercise", { ...base.retakes, enabled: false })).toBe(false);
    expect(retakesOn("exam", base.retakes)).toBe(false);
    expect(retakesOn("exercise", base.retakes)).toBe(true);
  });
});

describe("retakeRefusal", () => {
  it("allows a retake once the previous attempt is finished", () => {
    expect(retakeRefusal(base)).toBeNull();
    expect(retakeRefusal({ ...base, attempts: [{ attemptNumber: 1, state: "expired" }] })).toBeNull();
  });

  it("refuses an exam and an exercise with the setting off", () => {
    expect(retakeRefusal({ ...base, mode: "exam" })).toBe("not_allowed");
    expect(retakeRefusal({ ...base, retakes: { ...base.retakes, enabled: false } })).toBe(
      "not_allowed",
    );
  });

  it("refuses outside a running evaluation", () => {
    for (const state of ["draft", "scheduled", "lobby", "paused", "closed", "grading", "released"] as const) {
      expect(retakeRefusal({ ...base, evaluationState: state }), state).toBe("not_open");
    }
  });

  it("refuses at and after the common end, before the ticker closes", () => {
    expect(retakeRefusal({ ...base, closesAt: new Date(now.getTime() + 1000) })).toBeNull();
    expect(retakeRefusal({ ...base, closesAt: now })).toBe("closed");
    expect(retakeRefusal({ ...base, closesAt: new Date(now.getTime() - 1000) })).toBe("closed");
  });

  it("refuses without a first attempt, and beside an open one", () => {
    expect(retakeRefusal({ ...base, attempts: [] })).toBe("no_attempt");
    expect(
      retakeRefusal({
        ...base,
        attempts: [
          { attemptNumber: 1, state: "submitted" },
          { attemptNumber: 2, state: "in_progress" },
        ],
      }),
    ).toBe("unfinished");
    expect(retakeRefusal({ ...base, attempts: [{ attemptNumber: 1, state: "not_started" }] })).toBe(
      "unfinished",
    );
  });

  it("refuses once the maximum is reached, and never with no maximum", () => {
    const two = [
      { attemptNumber: 1, state: "submitted" as const },
      { attemptNumber: 2, state: "expired" as const },
    ];
    expect(retakeRefusal({ ...base, retakes: { ...base.retakes, maxAttempts: 3 }, attempts: two })).toBeNull();
    expect(retakeRefusal({ ...base, retakes: { ...base.retakes, maxAttempts: 2 }, attempts: two })).toBe(
      "max_attempts",
    );
    const many = Array.from({ length: 40 }, (_, i) => ({
      attemptNumber: i + 1,
      state: "submitted" as const,
    }));
    expect(retakeRefusal({ ...base, attempts: many })).toBeNull();
  });
});

describe("latestAttempt", () => {
  it("is the highest number, whatever the order", () => {
    expect(latestAttempt([{ attemptNumber: 2 }, { attemptNumber: 3 }, { attemptNumber: 1 }])).toEqual({
      attemptNumber: 3,
    });
    expect(latestAttempt([])).toBeNull();
  });
});

describe("keptAttempt (F-EVAL-15)", () => {
  const a = (attemptNumber: number, points: number, state: ScoredAttempt["state"] = "submitted") => ({
    attemptNumber,
    points,
    state,
  });

  it("keeps the best score, a tie going to the latest", () => {
    expect(keptAttempt([a(1, 4), a(2, 7), a(3, 5)], "best")?.attemptNumber).toBe(2);
    expect(keptAttempt([a(1, 7), a(2, 7), a(3, 5)], "best")?.attemptNumber).toBe(2);
  });

  it("keeps the last finished attempt", () => {
    expect(keptAttempt([a(1, 9), a(2, 3)], "last")?.attemptNumber).toBe(2);
  });

  it("ignores an attempt still being written", () => {
    expect(keptAttempt([a(1, 4), a(2, 0, "in_progress")], "last")?.attemptNumber).toBe(1);
    expect(keptAttempt([a(1, 4), a(2, 9, "in_progress")], "best")?.attemptNumber).toBe(1);
  });

  it("falls back to the latest attempt when none is finished, and to null for none", () => {
    expect(keptAttempt([a(1, 0, "in_progress")], "best")?.attemptNumber).toBe(1);
    expect(keptAttempt([], "last")).toBeNull();
  });

  it("is the only attempt of a student who took one", () => {
    expect(keptAttempt([a(1, 2, "expired")], "best")?.attemptNumber).toBe(1);
    expect(keptAttempt([a(1, 2, "expired")], "last")?.attemptNumber).toBe(1);
  });
});

describe("gradableNow (ADR-067)", () => {
  it("grades only a finished attempt while the evaluation runs", () => {
    for (const evaluation of ["running", "paused"] as const) {
      expect(gradableNow(evaluation, { state: "submitted" })).toBe(true);
      expect(gradableNow(evaluation, { state: "expired" })).toBe(true);
      expect(gradableNow(evaluation, { state: "in_progress" })).toBe(false);
      expect(gradableNow(evaluation, { state: "not_started" })).toBe(false);
    }
  });

  it("grades every attempt once the evaluation is over", () => {
    expect(gradableNow("closed", { state: "in_progress" })).toBe(true);
    expect(gradableNow("released", { state: "submitted" })).toBe(true);
  });

  it("grades a checked question of an exercise while its attempt is open (ADR-124 §3)", () => {
    const checked = { mode: "exercise" as const, checked: true };
    expect(gradableNow("running", { state: "in_progress" }, checked)).toBe(true);
    expect(gradableNow("paused", { state: "in_progress" }, checked)).toBe(true);
    // A practice attempt (ADR-122), still being written.
    expect(gradableNow("closed", { state: "in_progress", afterDue: true }, checked)).toBe(true);
    // Not checked, or not an exercise: the attempt's own rule.
    expect(gradableNow("running", { state: "in_progress" }, { mode: "exercise", checked: false })).toBe(false);
    expect(gradableNow("running", { state: "in_progress" }, { mode: "exam", checked: true })).toBe(false);
    expect(gradableNow("closed", { state: "in_progress", afterDue: true }, { mode: "exercise", checked: false })).toBe(
      false,
    );
  });
});

describe("retake scope (ADR-091)", () => {
  const partial = { ...base.retakes, scope: "to_review" as const };

  it("reads an absent scope as `all`", () => {
    expect(retakeScopeOf(base.retakes)).toBe("all");
    expect(retakeScopeOf(partial)).toBe("to_review");
  });

  it("is partial only on an exercise that takes retakes and chose `to_review`", () => {
    expect(partialRetakesOn("exercise", partial)).toBe(true);
    expect(partialRetakesOn("exercise", base.retakes)).toBe(false);
    expect(partialRetakesOn("exercise", { ...partial, enabled: false })).toBe(false);
    expect(partialRetakesOn("exam", partial)).toBe(false);
  });

  it("fits free navigation only, while partial retakes are on", () => {
    expect(retakeScopeFits("exercise", partial, "free")).toBe(true);
    expect(retakeScopeFits("exercise", partial, "forward_only")).toBe(false);
    expect(retakeScopeFits("exercise", partial, "milestones")).toBe(false);
    expect(retakeScopeFits("exercise", base.retakes, "milestones")).toBe(true);
    expect(retakeScopeFits("exercise", { ...partial, enabled: false }, "forward_only")).toBe(true);
    expect(retakeScopeFits("exam", partial, "forward_only")).toBe(true);
  });
});

describe("itemStanding / acquiredItems (ADR-091)", () => {
  it("is acquired at the maximum, to review below it", () => {
    expect(itemStanding({ maxPoints: 2, validatedPoints: 2 })).toBe("acquired");
    expect(itemStanding({ maxPoints: 2, validatedPoints: 1.5 })).toBe("to_review");
    expect(itemStanding({ maxPoints: 2, validatedPoints: 0 })).toBe("to_review");
    // Negative marking (ADR-026): below zero is still to review.
    expect(itemStanding({ maxPoints: 1, validatedPoints: -0.5 })).toBe("to_review");
  });

  it("is pending without a validated grading", () => {
    expect(itemStanding({ maxPoints: 3, validatedPoints: null })).toBe("pending");
  });

  it("never asks again a question worth nothing", () => {
    expect(itemStanding({ maxPoints: 0, validatedPoints: null })).toBe("acquired");
    expect(itemStanding({ maxPoints: 0, validatedPoints: 0 })).toBe("acquired");
  });

  it("lists the acquired ids in their order", () => {
    expect(
      acquiredItems([
        { id: "a", standing: "acquired" },
        { id: "b", standing: "to_review" },
        { id: "c", standing: "pending" },
        { id: "d", standing: "acquired" },
      ]),
    ).toEqual(["a", "d"]);
  });
});

describe("partialRetakeRefusal (ADR-091)", () => {
  const partial = { ...base.retakes, scope: "to_review" as const };
  const items = [{ standing: "acquired" as const }, { standing: "to_review" as const }];

  it("allows a partial retake when something is to review", () => {
    expect(partialRetakeRefusal({ mode: "exercise", retakes: partial, items })).toBeNull();
    expect(partialRetakeRefusal({ mode: "exercise", retakes: partial, items: [{ standing: "pending" }] })).toBeNull();
  });

  it("refuses it when the teacher chose every question", () => {
    expect(partialRetakeRefusal({ mode: "exercise", retakes: base.retakes, items })).toBe("scope_all");
  });

  it("refuses it when everything is acquired", () => {
    expect(partialRetakeRefusal({ mode: "exercise", retakes: partial, items: [items[0]!] })).toBe("nothing_to_review");
  });
});

describe("retakesWidening (ADR-025 §2, amended 2026-11-27)", () => {
  const off: RetakePolicy = { enabled: false, keep: "best", maxAttempts: null };
  const on = (maxAttempts: number | null, more: Partial<RetakePolicy> = {}): RetakePolicy => ({
    enabled: true,
    keep: "best",
    maxAttempts,
    ...more,
  });

  it("switches the rule on, with any maximum, kept attempt and scope", () => {
    expect(retakesWidening(off, on(null))).toBe(true);
    expect(retakesWidening(off, on(2))).toBe(true);
    expect(retakesWidening(off, on(5, { keep: "last", scope: "to_review" }))).toBe(true);
  });

  it("reads a rule switched off as one attempt, whatever it still stores", () => {
    const stale: RetakePolicy = { enabled: false, keep: "last", maxAttempts: 8, scope: "to_review" };
    expect(retakesWidening(stale, on(2))).toBe(true);
    expect(retakesWidening(stale, on(3, { keep: "best", scope: "all" }))).toBe(true);
    // Left off, it stays exactly what it stores: no change to call a widening.
    expect(retakesWidening(stale, stale)).toBe(true);
    expect(retakesWidening(stale, off)).toBe(false);
    expect(retakesWidening(off, { ...off, scope: "all" })).toBe(true);
  });

  it("raises the maximum, or lifts it", () => {
    expect(retakesWidening(on(2), on(3))).toBe(true);
    expect(retakesWidening(on(2), on(null))).toBe(true);
    expect(retakesWidening(on(null), on(null))).toBe(true);
    expect(retakesWidening(on(3), on(3))).toBe(true);
  });

  it("never switches it off, nor lowers or sets a maximum below no limit", () => {
    expect(retakesWidening(on(3), off)).toBe(false);
    expect(retakesWidening(on(null), { ...on(null), enabled: false })).toBe(false);
    expect(retakesWidening(on(4), on(3))).toBe(false);
    expect(retakesWidening(on(null), on(100))).toBe(false);
  });

  it("freezes the kept attempt and the scope once the rule is on", () => {
    expect(retakesWidening(on(3), on(4, { keep: "last" }))).toBe(false);
    expect(retakesWidening(on(3), on(3, { scope: "to_review" }))).toBe(false);
    expect(retakesWidening(on(3, { scope: "to_review" }), on(3, { scope: "all" }))).toBe(false);
    // An absent scope is `all`: sending it spelled out is no change.
    expect(retakesWidening(on(3), on(5, { scope: "all" }))).toBe(true);
  });

  it("applies to an exercise students are sitting, and to nothing else", () => {
    expect(retakesWidenableUnder("running", "exercise")).toBe(true);
    expect(retakesWidenableUnder("running", "exam")).toBe(false);
    expect(retakesWidenableUnder("running", "poll")).toBe(false);
    expect(retakesWidenableUnder("attempts", "exercise")).toBe(false);
    expect(retakesWidenableUnder(null, "exercise")).toBe(false);
  });
});

describe("settingsWidenRetakesOnly and patchFieldWritable (ADR-025 §2, amended 2026-11-27)", () => {
  const stored = { navigation: "free", lobby: "skip", retakes: { enabled: false, keep: "best", maxAttempts: null } } as const;
  const widened = { ...stored, retakes: { enabled: true, keep: "last", maxAttempts: 3 } } as const;

  it("lets the retake rule widen, and nothing else move", () => {
    expect(settingsWidenRetakesOnly(stored, widened)).toBe(true);
    expect(settingsWidenRetakesOnly(stored, stored)).toBe(true);
    expect(settingsWidenRetakesOnly(stored, { ...widened, lobby: "manual" })).toBe(false);
    expect(settingsWidenRetakesOnly(widened, stored)).toBe(false);
  });

  it("reads an absent rule as one attempt", () => {
    const { retakes: _omitted, ...bare } = stored;
    expect(settingsWidenRetakesOnly(bare, widened)).toBe(true);
    expect(settingsWidenRetakesOnly(bare, bare)).toBe(true);
    expect(settingsWidenRetakesOnly(widened, bare)).toBe(false);
  });

  it("opens the settings under the running lock to an exercise's widening only", () => {
    const settings = () => ({ stored, next: widened });
    expect(patchFieldWritable("running", "exercise", "settings", settings)).toBe(true);
    expect(patchFieldWritable("running", "exam", "settings", settings)).toBe(false);
    expect(patchFieldWritable("attempts", "exercise", "settings", settings)).toBe(false);
    expect(patchFieldWritable("running", "exercise", "settings", () => ({ stored: widened, next: stored }))).toBe(false);
    expect(patchFieldWritable("running", "exercise", "durationS", settings)).toBe(false);
    expect(patchFieldWritable("running", "exam", "title", settings)).toBe(true);
    expect(patchFieldWritable(null, "exam", "settings", settings)).toBe(true);
  });

  it("parses the settings only when they decide", () => {
    let asked = 0;
    const settings = () => {
      asked += 1;
      return { stored, next: widened };
    };
    patchFieldWritable("running", "exercise", "title", settings);
    patchFieldWritable("running", "exam", "settings", settings);
    expect(asked).toBe(0);
  });
});
