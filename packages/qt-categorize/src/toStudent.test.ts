/**
 * The mandatory leak test (PLAN-MVP §2.5, docs/05 §5.7, N-SEC-04).
 *
 * The key of a `categorize` question is not a value hidden in a field: it is
 * WHICH card each column lists, and in what order. So beyond the forbidden
 * keys, the test checks that no column of the output carries a `cards` list,
 * that no key array appears in the serialised output, and that the card
 * order is the teacher's (no shuffle) or a permutation (shuffle) — never the
 * key's.
 */
import { describe, expect, it } from "vitest";
import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";
import { categorizeServer } from "./server.js";
import { config } from "./test/fixtures.js";

const FORBIDDEN_KEYS = [...COMMON_FORBIDDEN_STUDENT_KEYS, "compare", "policy", "expected", "expectedRank"];

/**
 * A config whose key is recognisable: the cards are written in an order
 * that is NOT the key's, so a leak of the key order is not mistaken for the
 * teacher's order, and the policy is a value of its own.
 */
const SECRET = config({
  cards: [
    { id: "sec8", text: "eight" },
    { id: "sec1", text: "one" },
    { id: "sec5", text: "five" },
    { id: "sec2", text: "two" },
    { id: "sec9", text: "nine (distractor)" },
    { id: "sec4", text: "four" },
  ],
  columns: [
    { id: "cola", label: "Small", cards: ["sec1", "sec2"] },
    { id: "colb", label: "Middle", cards: ["sec4", "sec5"] },
    { id: "colc", label: "Large", cards: ["sec8"] },
  ],
  ordered: true,
  policy: "all_or_nothing",
  shuffleCards: false,
});

const views = [
  { seed: 7, itemId: "i", shuffle: true },
  { seed: 0, itemId: "i", shuffle: false },
  { seed: 7, itemId: "i", shuffle: true, defaults: { categorize: { policy: "per_item", negativeMarking: true } } },
];

describe("toStudent", () => {
  for (const shuffleCards of [false, true]) {
    for (const view of views) {
      const cfg = { ...SECRET, shuffleCards, shuffleColumns: shuffleCards };
      const student = categorizeServer.toStudent(cfg, view);
      const out = JSON.stringify(student);
      const tag = `(shuffle ${String(shuffleCards)}/${String(view.shuffle)}, defaults ${String("defaults" in view)})`;

      it(`leaks no key ${tag}`, () => {
        for (const key of FORBIDDEN_KEYS) expect(out).not.toContain(`"${key}"`);
        for (const column of student.columns) expect(Object.keys(column).sort()).toEqual(["id", "label"]);
        expect(categorizeServer.studentSchema.safeParse(student).success).toBe(true);
      });

      it(`leaks no key value ${tag}`, () => {
        for (const column of cfg.columns) expect(out).not.toContain(JSON.stringify(column.cards));
        expect(out).not.toContain("all_or_nothing");
        expect(out).not.toContain("per_item");
        expect(out).not.toContain("inherit");
      });
    }
  }

  it("keeps the teacher's card order without the shuffle, a permutation with it", () => {
    const teacher = SECRET.cards.map((c) => c.id);
    expect(categorizeServer.toStudent(SECRET, views[0]!).cards.map((c) => c.id)).toEqual(teacher);
    const shuffled = categorizeServer.toStudent({ ...SECRET, shuffleCards: true }, { seed: 3, itemId: "x", shuffle: true });
    expect([...shuffled.cards.map((c) => c.id)].sort()).toEqual([...teacher].sort());
  });

  it("keeps exactly what the player needs, and says only the negative marking", () => {
    const plain = categorizeServer.toStudent(SECRET, views[0]!);
    expect(Object.keys(plain).sort()).toEqual(["cards", "columns", "ordered", "prompt"]);
    const negative = categorizeServer.toStudent(SECRET, views[2]!);
    expect(negative.negativeMarking).toBe(true);
    for (const defaults of [{ categorize: { policy: "per_item" } }, { categorize: "negative" }, { mcq: { policy: "symmetric", negativeMarking: true } }]) {
      expect(categorizeServer.toStudent(SECRET, { seed: 1, itemId: "i", shuffle: false, defaults }).negativeMarking).toBeUndefined();
    }
  });
});
