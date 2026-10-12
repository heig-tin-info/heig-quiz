import { describe, expect, it } from "vitest";

import { criteriaTable, type CriterionGradeLike } from "./criteriaTable.js";

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
      { criterionId: "rendu.tests", section: "rendu", description: "Tests", max: 10, points: 7.5, state: "proposed", source: "auto" },
      { criterionId: "rapport.style", section: "rapport", description: "Style", max: 4, points: 3, state: "validated", source: "llm", rationale: XSS },
      {
        criterionId: "rapport.bonus",
        section: "rapport",
        description: "Bonus",
        max: 0,
        bonus: 2,
        points: 0,
        state: "proposed",
        source: "llm",
        rationale: "provisional",
        reason: "llm_budget",
      },
      { criterionId: "identity", section: "", description: "Who committed", max: 2, points: null, state: "empty" },
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
});
