import { describe, expect, it } from "vitest";

import { evaluationFigures, type AgreementRow, type ContestationRow } from "./gradingAgreement.js";

const NONE = new Map<string, number>();

/** The figures of one item `a` from its rows. */
const one = (compared: Omit<AgreementRow, "itemId">[], filed: Omit<ContestationRow, "itemId">[] = [], graded = 0) =>
  evaluationFigures(
    ["a"],
    compared.map((row) => ({ ...row, itemId: "a" })),
    filed.map((row) => ({ ...row, itemId: "a" })),
    new Map([["a", graded]]),
  ).byItem.get("a")!;

describe("the AI's agreement", () => {
  it("is null with nothing compared", () => {
    expect(one([]).agreement).toBeNull();
  });

  it("counts a cell unchanged when the grading in force has the proposal's points", () => {
    expect(
      one([
        { proposal: 2, inForce: 2, confidence: "high" },
        { proposal: 1.5, inForce: 1.5, confidence: "high" },
        { proposal: 3, inForce: 1, confidence: "low" },
        { proposal: 0.5, inForce: 1.25, confidence: "medium" },
      ]).agreement,
    ).toEqual({
      compared: 4,
      unchanged: 2,
      changed: 2,
      // (2 + 0.75) / 2
      meanAbsDelta: 1.38,
      byConfidence: {
        high: { compared: 2, unchanged: 2, changed: 0, meanAbsDelta: null },
        medium: { compared: 1, unchanged: 0, changed: 1, meanAbsDelta: 0.75 },
        low: { compared: 1, unchanged: 0, changed: 1, meanAbsDelta: 2 },
      },
    });
  });

  it("compares to the cent: a float's noise is no change", () => {
    const { agreement } = one([{ proposal: 0.1 + 0.2, inForce: 0.3, confidence: "medium" }]);
    expect(agreement).toMatchObject({ unchanged: 1, changed: 0, meanAbsDelta: null });
    expect(agreement!.byConfidence.high).toBeNull();
  });
});

describe("the contestations", () => {
  it("are null when none was filed", () => {
    expect(one([], [], 40).contestations).toBeNull();
  });

  it("count the verdicts, and per source of the contested grading those filed and accepted", () => {
    expect(
      one(
        [],
        [
          { state: "open", source: "llm" },
          { state: "accepted", source: "llm" },
          { state: "refused", source: "manual" },
          { state: "refused", source: "auto" },
          // The grading at filing is gone: in no source.
          { state: "accepted", source: null },
        ],
        40,
      ).contestations,
    ).toEqual({
      filed: 5,
      accepted: 2,
      graded: 40,
      open: 1,
      refused: 2,
      bySource: {
        auto: { filed: 1, accepted: 0 },
        llm: { filed: 2, accepted: 1 },
        manual: { filed: 1, accepted: 0 },
      },
    });
  });
});

describe("evaluationFigures", () => {
  it("reads each question, and the whole evaluation over the questions asked for", () => {
    const { byItem, total } = evaluationFigures(
      ["a", "b"],
      [
        { itemId: "a", proposal: 1, inForce: 1, confidence: "high" },
        { itemId: "b", proposal: 1, inForce: 2, confidence: "low" },
        // An item not asked for is in no figure.
        { itemId: "c", proposal: 1, inForce: 3, confidence: "low" },
      ],
      [{ itemId: "b", state: "open", source: "auto" }],
      new Map([
        ["a", 3],
        ["b", 4],
        ["c", 9],
      ]),
    );
    expect(byItem.get("a")).toEqual({
      agreement: expect.objectContaining({ compared: 1, unchanged: 1 }),
      contestations: null,
    });
    expect(byItem.get("b")!.contestations).toMatchObject({ filed: 1, graded: 4 });
    expect(total.agreement).toMatchObject({ compared: 2, unchanged: 1, changed: 1, meanAbsDelta: 1 });
    expect(total.contestations).toMatchObject({ filed: 1, graded: 7 });
  });

  it("gives an item with no row nothing at all", () => {
    expect(evaluationFigures(["a"], [], [], NONE)).toEqual({
      byItem: new Map([["a", { agreement: null, contestations: null }]]),
      total: { agreement: null, contestations: null },
    });
  });
});
