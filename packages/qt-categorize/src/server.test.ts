import { describe, expect, it } from "vitest";
import type { GradedResult } from "@quiz/core/server";
import { testGradeContext } from "@quiz/core/testing";
import { categorizeServer } from "./server.js";
import type { CategorizeAnswer, CategorizeConfig, CategorizeDetails, CategorizeReviewDetails } from "./schema.js";
import { C, config, K, RIGHT } from "./test/fixtures.js";

function grade(
  cfg: CategorizeConfig,
  answer: CategorizeAnswer | null,
  points = 1,
  defaults?: Record<string, unknown>,
): GradedResult<CategorizeDetails> {
  const result = categorizeServer.grade(cfg, answer, testGradeContext(points, defaults));
  if (result instanceof Promise || result.kind !== "graded") throw new Error("expected a synchronous grade");
  return result;
}

/**
 * t = 3 (int, float, void *), x = 1 (double in Integer), p = 1 (string in
 * Pointer); size_t and char * stay in the tray, boolean rightly too.
 */
const PARTIAL: CategorizeAnswer = {
  columns: { [C.int]: [K.int, K.double], [C.float]: [K.float], [C.ptr]: [K.voidp, K.string] },
};

describe("grade", () => {
  /*
   * What each policy makes of the counts is `@quiz/domain/categorizeScore`'s
   * and tested there. This package only reduces an answer to those counts,
   * card by card, and puts the fraction on the item's scale.
   */
  it("reduces an answer to one verdict per card and the counts, validated", () => {
    const { points, maxPoints, state, details } = grade(config(), PARTIAL, 2);
    expect({ points, maxPoints, state }).toEqual({ points: 1, maxPoints: 2, state: "validated" });
    expect(details).toMatchObject({ policy: "per_item", T: 6, D: 2, t: 3, x: 1, p: 1 });
    expect(details.cards.find((card) => card.id === K.bool)).toEqual({ id: K.bool, placed: null, expected: null, right: true });
    expect(details.cards.find((card) => card.id === K.double)).toEqual({
      id: K.double,
      placed: C.int,
      rank: 2,
      expected: C.float,
      right: false,
    });
    expect(details.cards.find((card) => card.id === K.size)).toEqual({ id: K.size, placed: null, expected: C.int, right: false });
    expect(grade(config(), RIGHT, 2).points).toBe(2);
  });

  it("inherit: the evaluation decides, per_item without one", () => {
    const inherit = config({ policy: "inherit" });
    expect(grade(inherit, PARTIAL).details.policy).toBe("per_item");
    const strict = grade(inherit, PARTIAL, 1, { categorize: { policy: "all_or_nothing" } });
    expect(strict.details.policy).toBe("all_or_nothing");
    expect(strict.points).toBe(0);
    // A question that names its policy overrides the evaluation's.
    expect(grade(config({ policy: "per_item" }), PARTIAL, 1, { categorize: { policy: "all_or_nothing" } }).points).toBe(0.5);
    // An unreadable entry is no entry.
    expect(grade(inherit, PARTIAL, 1, { categorize: "strict" }).details.policy).toBe("per_item");
  });

  it("negative marking from the evaluation overrides the question's policy", () => {
    const negative = { categorize: { policy: "per_item", negativeMarking: true } };
    const result = grade(config({ policy: "all_or_nothing" }), PARTIAL, 3, negative);
    expect(result.details.negativeMarking).toBe(true);
    // all_or_nothing would have given 0 here.
    expect(result.points).toBeGreaterThan(0);
    // And the points may go below zero.
    const wrong = { columns: { [C.int]: [K.double, K.float], [C.float]: [K.int, K.size] } };
    expect(grade(config(), wrong, 2, negative).points).toBeLessThan(0);
  });

  it("ordered: a target is right only at its rank, and a gap shifts the rest", () => {
    const ordered = config({ ordered: true });
    const swapped = { columns: { [C.int]: [K.size, K.int], [C.float]: [K.double, K.float], [C.ptr]: [K.voidp] } };
    const result = grade(ordered, swapped);
    expect(result.details).toMatchObject({ t: 3, x: 2, p: 0, fraction: 0.625, ordered: true });
    expect(result.details.cards.find((card) => card.id === K.int)).toMatchObject({ rank: 2, expectedRank: 1, right: false });
    // The same placement without the order: only the columns count.
    expect(grade(config(), swapped).details.t).toBe(5);

    const cascade = { columns: { ...RIGHT.columns, [C.int]: [K.string, K.int, K.size] } };
    expect(grade(ordered, cascade).details).toMatchObject({ t: 4, x: 2, p: 1 });
  });

  it("scores an answer that places nothing, or no answer, 0", () => {
    const empty = grade(config(), { columns: {} }, 2);
    expect(empty.points).toBe(0);
    expect(empty.details.fraction).toBe(0);
    // No card is marked right, distractors included: the review shows no green beside a 0.
    expect(empty.details.cards.every((card) => !card.right)).toBe(true);
    expect(grade(config(), null, 2).points).toBe(0);
  });

  it("defends itself: unknown ids ignored, a card's first place wins", () => {
    const crafted = {
      columns: { [C.int]: ["nope", K.int, K.size], [C.float]: [K.int, K.double, K.float], ghost: [K.voidp] },
    };
    const { details } = grade(config({ ordered: true }), crafted);
    expect(details.cards.find((card) => card.id === K.int)).toMatchObject({ placed: C.int, rank: 1, right: true });
    expect(details.cards.find((card) => card.id === K.double)).toMatchObject({ placed: C.float, rank: 1, right: true });
    expect(details.cards.find((card) => card.id === K.voidp)).toMatchObject({ placed: null, right: false });
  });
});

describe("answerMisfit", () => {
  const cfg = config();
  it("accepts a fitting answer, the empty one included", () => {
    expect(categorizeServer.answerMisfit!(cfg, PARTIAL)).toBeNull();
    expect(categorizeServer.answerMisfit!(cfg, { columns: {} })).toBeNull();
  });

  it("refuses an unknown column, an unknown card, a card listed twice", () => {
    for (const columns of [
      { ghost: [K.int] },
      { [C.int]: ["nope"] },
      { [C.int]: [K.int, K.int] },
      { [C.int]: [K.int], [C.float]: [K.int] },
    ]) {
      expect(categorizeServer.answerMisfit!(cfg, { columns })).toBe("categorize.answer_misfit");
    }
  });
});

describe("summarizeAnswer", () => {
  it("counts the cards placed, figures only", () => {
    expect(categorizeServer.summarizeAnswer!(config(), PARTIAL)).toBe("5/8");
    expect(categorizeServer.summarizeAnswer!(config(), { columns: {} })).toBe("0/8");
  });
});

describe("studentDetails", () => {
  const { details } = grade(config({ ordered: true }), PARTIAL);

  it("keeps everything when the key is published", () => {
    expect(categorizeServer.studentDetails!(details, { showKey: true, showHiddenCaseNames: false })).toBe(details);
  });

  it("otherwise keeps only what the student's own placements say", () => {
    const out = categorizeServer.studentDetails!(details, {
      showKey: false,
      showHiddenCaseNames: false,
    }) as CategorizeReviewDetails;
    const json = JSON.stringify(out);
    expect(json).not.toContain('"expected"');
    expect(json).not.toContain('"expectedRank"');
    // T and D together count the distractors.
    expect(out.T).toBeUndefined();
    expect(out.D).toBeUndefined();
    expect({ t: out.t, x: out.x, p: out.p, fraction: out.fraction }).toEqual({
      t: details.t,
      x: details.x,
      p: details.p,
      fraction: details.fraction,
    });
    for (const card of out.cards) {
      const teacher = details.cards.find((c) => c.id === card.id)!;
      // A verdict on a card left in the tray would say whether it was a distractor.
      if (card.placed === null) expect(card).toEqual({ id: card.id, placed: null });
      else expect(card.right).toBe(teacher.right);
    }
  });
});

describe("shuffle", () => {
  const cfg = config({ shuffleCards: true });

  it("is deterministic per (seed, item), and per purpose", () => {
    const view = { seed: 42, itemId: "item-9", shuffle: true };
    expect(categorizeServer.toStudent(cfg, view)).toEqual(categorizeServer.toStudent(cfg, view));
    const orders = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        categorizeServer.toStudent(cfg, { seed, itemId: "item-9", shuffle: true }).cards.map((c) => c.id).join(),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
    // The columns keep their order: shuffleColumns is off.
    expect(categorizeServer.toStudent(cfg, view).columns.map((c) => c.id)).toEqual([C.int, C.float, C.ptr]);
  });

  it("shuffles nothing when the evaluation does not", () => {
    const student = categorizeServer.toStudent(config({ shuffleCards: true, shuffleColumns: true }), {
      seed: 42,
      itemId: "item-9",
      shuffle: false,
    });
    expect(student.cards.map((c) => c.id)).toEqual(Object.values(K));
    expect(student.columns.map((c) => c.id)).toEqual([C.int, C.float, C.ptr]);
  });

  it("says whether there is anything to shuffle", () => {
    expect(categorizeServer.shuffleable(config({ shuffleCards: true }))).toBe(true);
    expect(categorizeServer.shuffleable(config({ shuffleCards: false, shuffleColumns: false }))).toBe(false);
    expect(categorizeServer.shuffleable(config({ shuffleCards: false, shuffleColumns: true }))).toBe(true);
  });
});

describe("the rest of the contract", () => {
  it("refuses a version it never emitted", () => {
    expect(() => categorizeServer.migrate(config(), 0)).toThrow();
  });

  it("searches the prompt, the column names and the cards", () => {
    const text = categorizeServer.searchText(config());
    for (const word of ["Sort each C type", "Floating point", "`size_t`"]) expect(text).toContain(word);
  });

  it("serves the key as the solution", () => {
    expect(categorizeServer.toSolution(config(), { seed: 0, itemId: "i", shuffle: false })).toEqual({
      columns: [
        { id: C.int, cards: [K.int, K.size] },
        { id: C.float, cards: [K.double, K.float] },
        { id: C.ptr, cards: [K.voidp, K.charp] },
      ],
    });
  });
});
