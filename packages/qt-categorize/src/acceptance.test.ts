/**
 * Accepting a categorize answer at grading time (ADR-128): a card, accepted
 * where the student put it, counts as right inside the type's own scoring.
 */
import { describe, expect, it } from "vitest";
import type { AcceptedAnswer, GradedResult } from "@quiz/core/server";
import { testGradeContext } from "@quiz/core/testing";
import { identityPlace, placeIdentity } from "./placement.js";
import { categorizeServer } from "./server.js";
import type { CategorizeAnswer, CategorizeConfig, CategorizeDetails } from "./schema.js";
import { C, config, K } from "./test/fixtures.js";

const acceptance = categorizeServer.acceptance!;

function grade(
  cfg: CategorizeConfig,
  answer: CategorizeAnswer,
  accepted: AcceptedAnswer[],
  defaults?: Record<string, unknown>,
): GradedResult<CategorizeDetails> {
  const result = categorizeServer.grade(cfg, answer, { ...testGradeContext(1, defaults), accepted });
  if (result instanceof Promise || result.kind !== "graded") throw new Error("expected a synchronous grade");
  return result;
}

/** Every target right but `double`, put in Integer; `string` (a distractor) put in Pointer. */
const ANSWER: CategorizeAnswer = {
  columns: { [C.int]: [K.int, K.size, K.double], [C.float]: [K.float], [C.ptr]: [K.voidp, K.charp, K.string] },
};

describe("acceptance.given", () => {
  it("names every placed card by where it was put, never one left in the tray", () => {
    const given = acceptance.given(config(), ANSWER);
    expect(given.map((g) => g.part).sort()).toEqual([K.int, K.size, K.double, K.float, K.voidp, K.charp, K.string].sort());
    expect(given.find((g) => g.part === K.double)).toEqual({ part: K.double, answer: C.int, right: false });
    expect(given.find((g) => g.part === K.int)).toMatchObject({ right: true });
    expect(given.some((g) => g.part === K.bool)).toBe(false);
  });

  it("adds the rank when the order counts, which only one answer can be accepted at", () => {
    const ordered = config({ ordered: true });
    expect(acceptance.given(ordered, ANSWER).find((g) => g.part === K.double)?.answer).toBe(`${C.int}#3`);
    expect(acceptance.singleAnswer?.(ordered)).toBe(true);
    expect(acceptance.singleAnswer?.(config())).toBe(false);
  });
});

describe("the identity of a place", () => {
  it("is the column, or the column and the rank when the order counts", () => {
    expect(placeIdentity({ column: "c1", rank: 2 }, false)).toBe("c1");
    expect(placeIdentity({ column: "c1", rank: 2 }, true)).toBe("c1#2");
  });

  it("reads back, refusing a shape of the other mode", () => {
    expect(identityPlace("c1", false)).toEqual({ column: "c1", rank: null });
    expect(identityPlace("c1#2", true)).toEqual({ column: "c1", rank: 2 });
    expect(identityPlace("c1#2", false)).toBeNull();
    expect(identityPlace("c1", true)).toBeNull();
    expect(identityPlace("c1#0", true)).toBeNull();
  });
});

describe("acceptance.label", () => {
  it("names the card and the column, and refuses a card or a column that is not there", () => {
    expect(acceptance.label(config(), K.double, C.int)).toBe("double → Integer");
    expect(acceptance.label(config({ ordered: true }), K.double, `${C.int}#3`)).toBe("double → Integer · 3");
    expect(acceptance.label(config(), "zzzz", C.int)).toBeNull();
    expect(acceptance.label(config(), K.double, "zzzz")).toBeNull();
    expect(acceptance.label(config(), K.double, `${C.int}#3`)).toBeNull();
  });
});

describe("grade with accepted answers", () => {
  it("counts an accepted target as right, an accepted distractor as no longer placed", () => {
    const plain = grade(config(), ANSWER, []);
    expect(plain.details).toMatchObject({ T: 6, D: 2, t: 5, x: 1, p: 1 });
    const { details } = grade(config(), ANSWER, [
      { part: K.double, answer: C.int },
      { part: K.string, answer: C.ptr },
    ]);
    expect(details).toMatchObject({ T: 6, D: 2, t: 6, x: 0, p: 0 });
    expect(details.cards.find((c) => c.id === K.double)).toMatchObject({ right: true, accepted: true });
    expect(details.cards.find((c) => c.id === K.string)).toMatchObject({ right: true, accepted: true });
  });

  it("ignores an acceptance of another place, and never accepts a card in the tray", () => {
    expect(grade(config(), ANSWER, [{ part: K.double, answer: C.ptr }]).details.t).toBe(5);
    expect(grade(config(), ANSWER, [{ part: K.bool, answer: C.int }]).details.cards.find((c) => c.id === K.bool)).not.toHaveProperty(
      "accepted",
    );
  });
});

describe("studentDetails", () => {
  it("keeps an accepted card's mark beside its verdict, and nothing of the key", () => {
    const { details } = grade(config(), ANSWER, [{ part: K.double, answer: C.int }]);
    const out = categorizeServer.studentDetails!(details, { showKey: false, showHiddenCaseNames: false }) as {
      cards: Record<string, unknown>[];
    };
    expect(out.cards.find((c) => c["id"] === K.double)).toEqual({ id: K.double, placed: C.int, rank: 3, right: true, accepted: true });
    for (const card of out.cards) {
      expect(card).not.toHaveProperty("expected");
      expect(card).not.toHaveProperty("expectedRank");
    }
    // The key's column of `double` is Floating point: its verdict must not name it.
    expect(JSON.stringify(out.cards.find((c) => c["id"] === K.double))).not.toContain(C.float);
  });
});
