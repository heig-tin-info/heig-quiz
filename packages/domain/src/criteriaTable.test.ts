import { describe, expect, it } from "vitest";

import { criteriaScore, criteriaTable, currentCriterionRows, repoValidation, type CriterionGradeLike } from "./criteriaTable.js";

const snapshot = {
  leaves: [
    { id: "rendu.tests", sectionPath: ["rendu"], description: "Tests", maxPoints: 10 },
    { id: "rapport.style", sectionPath: ["rapport"], description: "Style", maxPoints: 4 },
    { id: "rapport.bonus", sectionPath: ["rapport"], description: "Bonus", maxPoints: 0, bonusPoints: 2 },
    { id: "identity", sectionPath: [], description: "Who committed", maxPoints: 2 },
  ],
};
const XSS = "<script>alert(1)</script>";
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 8, minutes));
const row = (over: Partial<CriterionGradeLike> & Pick<CriterionGradeLike, "criterionId">): CriterionGradeLike => ({
  points: 1,
  source: "llm",
  state: "proposed",
  rationale: null,
  reason: null,
  createdAt: at(0),
  lockedAt: null,
  ...over,
});

const rows: CriterionGradeLike[] = [
  row({ criterionId: "rendu.tests", source: "auto", points: 5, state: "superseded", rationale: "old" }),
  row({ criterionId: "rendu.tests", source: "auto", points: 7.5, createdAt: at(1) }),
  row({ criterionId: "rapport.style", points: 3, rationale: XSS, state: "validated" }),
  row({ criterionId: "rapport.style", points: 1, rationale: "a later proposal", createdAt: at(2) }),
  row({ criterionId: "rapport.bonus", points: 0, reason: "llm_budget", rationale: "provisional" }),
  row({ criterionId: "gone", points: 9 }),
];

describe("criteriaTable (ADR-106 §6)", () => {
  it("gives the staff each criterion's current row: points, state, source, rationale and reason", () => {
    const table = criteriaTable(snapshot, rows, { audience: "staff", frozen: true, released: false });
    expect(table).toEqual([
      { criterionId: "rendu.tests", section: "rendu", description: "Tests", max: 10, points: 7.5, state: "proposed", locked: false, source: "auto" },
      { criterionId: "rapport.style", section: "rapport", description: "Style", max: 4, points: 3, state: "validated", locked: false, source: "llm", rationale: XSS },
      {
        criterionId: "rapport.bonus",
        section: "rapport",
        description: "Bonus",
        max: 0,
        bonus: 2,
        points: 0,
        state: "proposed",
        locked: false,
        source: "llm",
        rationale: "provisional",
        reason: "llm_budget",
      },
      { criterionId: "identity", section: "", description: "Who committed", max: 2, points: null, state: "empty", locked: false },
    ]);
  });

  it("carries a rationale as the text it is, never as markup", () => {
    const [, style] = criteriaTable(snapshot, rows, { audience: "staff", frozen: false, released: false });
    expect(style!.rationale).toBe(XSS);
    expect(Object.keys(style!)).not.toContain("html");
  });

  it("gives a student no source, no reason, no superseded row, no rationale before the freeze, and nothing obtained from a failed pass", () => {
    const table = criteriaTable(snapshot, rows, { audience: "student", frozen: false, released: false });
    const text = JSON.stringify(table);
    for (const leak of ["source", "reason", "llm_budget", "old", "rationale", "provisional", "gone"]) expect(text).not.toContain(leak);
    expect(table.map((l) => [l.points, l.state])).toEqual([
      [7.5, "indicative"],
      [3, "indicative"],
      [null, "empty"],
      [null, "empty"],
    ]);
  });

  it("shows a student the provisional rationale after the freeze, and only the validated ones after the release", () => {
    const more = [...rows, row({ criterionId: "identity", source: "manual", rationale: "provisional" })];
    const frozen = criteriaTable(snapshot, more, { audience: "student", frozen: true, released: false });
    expect(frozen.map((l) => l.rationale)).toEqual([undefined, XSS, undefined, "provisional"]);
    const released = criteriaTable(snapshot, more, { audience: "student", frozen: true, released: true });
    expect(released.map((l) => [l.state, l.rationale])).toEqual([
      ["indicative", undefined],
      ["validated", XSS],
      ["empty", undefined],
      ["indicative", undefined],
    ]);
  });

  it("shows a student a teacher's validated row even when it records a failed pass", () => {
    const settled = [row({ criterionId: "rapport.bonus", points: 1, reason: "grader_error", state: "validated", source: "manual" })];
    const [, , bonus] = criteriaTable(snapshot, settled, { audience: "student", frozen: true, released: true });
    expect(bonus).toMatchObject({ points: 1, state: "validated" });
    expect(bonus).not.toHaveProperty("reason");
  });
  it("marks a milestone's locked row for both audiences, a failed pass's included, never naming the checkpoint (§5, §9)", () => {
    const locked = [
      row({ criterionId: "rendu.tests", source: "auto", points: 0, reason: "no_commit", lockedAt: at(4) }),
      row({ criterionId: "rapport.style", points: 2, lockedAt: null }),
      row({ criterionId: "rapport.bonus", points: 1, state: "superseded", lockedAt: at(4) }),
    ];
    for (const audience of ["staff", "student"] as const) {
      const table = criteriaTable(snapshot, locked, { audience, frozen: false, released: false });
      expect(table.map((l) => l.locked)).toEqual([true, false, false, false]);
    }
    const [tests] = criteriaTable(snapshot, locked, { audience: "student", frozen: false, released: false });
    expect(tests).toEqual({ criterionId: "rendu.tests", section: "rendu", description: "Tests", max: 10, points: null, state: "empty", locked: true });
  });

  it("stands on the newest validated row over any later proposal", () => {
    const mixed = [
      row({ criterionId: "identity", points: 1, state: "validated", createdAt: at(1) }),
      row({ criterionId: "identity", points: 0, createdAt: at(5) }),
      row({ criterionId: "identity", points: 2, state: "validated", createdAt: at(3) }),
    ];
    expect(currentCriterionRows(mixed).get("identity")).toMatchObject({ points: 2, state: "validated" });
  });

  it("stands on the newest proposal whatever the order of the rows", () => {
    const two = [row({ criterionId: "identity", points: 2, createdAt: at(9) }), row({ criterionId: "identity", points: 1, createdAt: at(3) })];
    expect(criteriaTable(snapshot, two, { audience: "staff", frozen: true, released: false })[3]!.points).toBe(2);
  });
});

describe("repoValidation (ADR-106 §8)", () => {
  const validated = (criterionId: string, points: number, createdAt = at(5)) =>
    row({ criterionId, points, state: "validated", createdAt });

  it("lists the criteria with no row and those still proposed, a superseded row counting as none", () => {
    expect(repoValidation(snapshot, rows)).toEqual({
      validated: false,
      missing: ["identity"],
      proposed: ["rendu.tests", "rapport.bonus"],
    });
    expect(repoValidation(snapshot, [row({ criterionId: "identity", state: "superseded" })]).missing).toContain("identity");
  });

  it("is validated once every criterion of the snapshot has a validated row, whatever a dropped criterion holds", () => {
    const all = [validated("rendu.tests", 8), validated("rapport.style", 3), validated("rapport.bonus", 2), validated("identity", 0), row({ criterionId: "gone" })];
    expect(repoValidation(snapshot, all)).toEqual({ validated: true, missing: [], proposed: [] });
  });
});

describe("criteriaScore (ADR-106 §7)", () => {
  const validated = (criterionId: string, points: number) => row({ criterionId, points, state: "validated" });

  it("is empty — never 0 — until the repository is validated", () => {
    expect(criteriaScore(snapshot, rows)).toBeNull();
    expect(criteriaScore(snapshot, [])).toBeNull();
  });

  it("totals the validated rows over the positive maxima, a bonus on top, clamped", () => {
    const all = [validated("rendu.tests", 8), validated("rapport.style", 3), validated("rapport.bonus", 2), validated("identity", 0)];
    expect(criteriaScore(snapshot, all)).toEqual({ points: 13, max: 16 });
    const full = [validated("rendu.tests", 10), validated("rapport.style", 4), validated("rapport.bonus", 2), validated("identity", 2)];
    expect(criteriaScore(snapshot, full)).toEqual({ points: 18, max: 16 });
  });

  it("subtracts a penalty, never below 0", () => {
    const penalty = { leaves: [...snapshot.leaves, { id: "late", sectionPath: [], description: "Late", maxPoints: -5 }] };
    const all = [validated("rendu.tests", 2), validated("rapport.style", 0), validated("rapport.bonus", 0), validated("identity", 0), validated("late", -5)];
    expect(criteriaScore(penalty, all)).toEqual({ points: 0, max: 16 });
  });

  it("has no score for a snapshot without a positive maximum", () => {
    const bonusOnly = { leaves: [snapshot.leaves[2]!] };
    expect(criteriaScore(bonusOnly, [validated("rapport.bonus", 1)])).toBeNull();
  });
});
