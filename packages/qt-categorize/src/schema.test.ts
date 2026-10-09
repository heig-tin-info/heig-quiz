import { describe, expect, it } from "vitest";
import {
  CATEGORIZE_MAX_COLUMNS,
  CategorizeAnswerSchema,
  CategorizeConfigSchema,
  emptyCategorizeDraft,
  isCategorizeAnswered,
} from "./schema.js";
import { config } from "./test/fixtures.js";

/** The messages of a refused config: the i18n keys the editor maps. */
function issues(raw: unknown): string[] {
  const parsed = CategorizeConfigSchema.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("CategorizeConfigSchema", () => {
  const valid = config();

  it("accepts the fixture and fills the defaults", () => {
    const { ordered: _o, shuffleCards: _s, shuffleColumns: _c, policy: _p, ...bare } = valid;
    expect(CategorizeConfigSchema.parse(bare)).toMatchObject({
      ordered: false,
      shuffleCards: true,
      shuffleColumns: false,
      policy: "inherit",
    });
  });

  it("refuses a duplicate id", () => {
    const first = valid.columns[0]!;
    expect(issues({ ...valid, columns: [...valid.columns, { ...first, cards: [] }] })).toContain("categorize.duplicate_id");
    expect(issues({ ...valid, cards: [...valid.cards, valid.cards[0]] })).toContain("categorize.duplicate_id");
  });

  it("takes only short lowercase alphanumeric ids", () => {
    for (const id of ["abc", "Abcd", "ab-cd", "ab cd", "x".repeat(41)]) {
      const cards = valid.cards.map((c, i) => (i === 0 ? { ...c, id } : c));
      expect(CategorizeConfigSchema.safeParse({ ...valid, cards }).success, id).toBe(false);
    }
  });

  it.each([
    { what: "a key naming a card that does not exist", column: 0, card: () => "ghost", code: "categorize.unknown_card" },
    { what: "a card in two columns", column: 1, card: () => valid.columns[0]!.cards[0]!, code: "categorize.card_twice" },
  ])("refuses $what", ({ column, card, code }) => {
    const columns = valid.columns.map((c, i) => (i === column ? { ...c, cards: [...c.cards, card()] } : c));
    expect(issues({ ...valid, columns })).toContain(code);
  });

  it("refuses a question made of distractors only", () => {
    const columns = valid.columns.map((c) => ({ ...c, cards: [] }));
    expect(issues({ ...valid, columns })).toContain("categorize.no_target");
    // Under the board, where the editor looks for it, not above the whole form.
    const refused = CategorizeConfigSchema.safeParse({ ...valid, columns }).error!.issues;
    expect(refused.find((i) => i.message === "categorize.no_target")?.path).toEqual(["columns"]);
  });

  it("holds between two and six columns", () => {
    expect(issues({ ...valid, columns: valid.columns.slice(0, 1) })).not.toEqual([]);
    const many = Array.from({ length: CATEGORIZE_MAX_COLUMNS + 1 }, (_, i) => ({ id: `c${i}`, label: `C${i}`, cards: [] }));
    expect(issues({ ...valid, columns: many })).not.toEqual([]);
  });

  it("shapes the empty draft with two columns (D16)", () => {
    const draft = emptyCategorizeDraft();
    expect(draft.columns).toHaveLength(2);
  });
});

describe("answers", () => {
  it("say answered as soon as one card is placed", () => {
    expect(isCategorizeAnswered({ columns: {} })).toBe(false);
    expect(isCategorizeAnswered({ columns: { a: [] } })).toBe(false);
    expect(isCategorizeAnswered({ columns: { a: ["x"] } })).toBe(true);
  });

  it("hold six columns at most", () => {
    const columns = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`c${i}`, []]));
    expect(CategorizeAnswerSchema.safeParse({ columns }).success).toBe(false);
  });
});
