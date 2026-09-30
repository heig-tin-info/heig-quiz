/**
 * The type-specific half of the leak test (PLAN-MVP §2.5, docs/05 §5.7,
 * N-SEC-04).
 *
 * The key of a `categorize` question is not a value hidden in a field: it is
 * WHICH card each column lists, and in what order. The registry's contract
 * test runs the full fixture of `./testing.ts` (the teacher's order, no
 * evaluation defaults) and searches it for the key arrays and the policy;
 * this file adds the shuffled boards and the evaluation's negative marking,
 * checks that no column carries a `cards` list, and that the card order is
 * the teacher's (no shuffle) or a permutation (shuffle) — never the key's.
 */
import { describe, expect, it } from "vitest";
import { findStudentLeaks } from "@quiz/core/testing";
import { categorizeServer } from "./server.js";
import { categorizeLeakFixture, SECRET_CONFIG as SECRET } from "./test/fixtures.js";

const views = [
  { seed: 7, itemId: "i", shuffle: true },
  { seed: 0, itemId: "i", shuffle: false },
  { seed: 7, itemId: "i", shuffle: true, defaults: { categorize: { policy: "per_item", negativeMarking: true } } },
];

/** What the contract test does not already run: the shuffled boards, and the negative marking. */
const variants = [
  ...views.map((view) => ({ shuffleCards: true, view })),
  { shuffleCards: false, view: views[2]! },
];

describe("toStudent", () => {
  it.each(variants)(
    "leaks neither key nor key value (shuffle $shuffleCards/$view.shuffle, seed $view.seed)",
    ({ shuffleCards, view }) => {
      const cfg = { ...SECRET, shuffleCards, shuffleColumns: shuffleCards };
      const student = categorizeServer.toStudent(cfg, view);
      expect(findStudentLeaks(student, categorizeLeakFixture)).toEqual([]);
      for (const column of student.columns) expect(Object.keys(column).sort()).toEqual(["id", "label"]);
      expect(categorizeServer.studentSchema.safeParse(student).success).toBe(true);
    },
  );

  it("keeps the teacher's card order without the shuffle, a permutation with it", () => {
    const teacher = SECRET.cards.map((c) => c.id);
    expect(categorizeServer.toStudent(SECRET, views[0]!).cards.map((c) => c.id)).toEqual(teacher);
    const shuffled = categorizeServer.toStudent({ ...SECRET, shuffleCards: true }, { seed: 3, itemId: "x", shuffle: true });
    expect([...shuffled.cards.map((c) => c.id)].sort()).toEqual([...teacher].sort());
  });

  it("keeps exactly what the player needs, and says only the negative marking", () => {
    const plain = categorizeServer.toStudent(SECRET, views[0]!);
    expect(Object.keys(plain).sort()).toEqual(["cards", "columns", "ordered", "prompt"]);
    for (const column of plain.columns) expect(Object.keys(column).sort()).toEqual(["id", "label"]);
    const negative = categorizeServer.toStudent(SECRET, views[2]!);
    expect(negative.negativeMarking).toBe(true);
    for (const defaults of [{ categorize: { policy: "per_item" } }, { categorize: "negative" }, { mcq: { policy: "symmetric", negativeMarking: true } }]) {
      expect(categorizeServer.toStudent(SECRET, { seed: 1, itemId: "i", shuffle: false, defaults }).negativeMarking).toBeUndefined();
    }
  });
});
