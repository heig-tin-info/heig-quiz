import { describe, expect, it } from "vitest";
import {
  CATEGORIZE_MAX_COLUMNS,
  CategorizeAnswerSchema,
  CategorizeConfigSchema,
  emptyCategorizeDraft,
  isCategorizeAnswered,
  newId,
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

  it("refuses a key naming a card that does not exist", () => {
    const columns = valid.columns.map((c, i) => (i === 0 ? { ...c, cards: [...c.cards, "ghost"] } : c));
    expect(issues({ ...valid, columns })).toContain("categorize.unknown_card");
  });

  it("refuses a card in two columns", () => {
    const shared = valid.columns[0]!.cards[0]!;
    const columns = valid.columns.map((c, i) => (i === 1 ? { ...c, cards: [...c.cards, shared] } : c));
    expect(issues({ ...valid, columns })).toContain("categorize.card_twice");
  });

  it("refuses a question made of distractors only", () => {
    const columns = valid.columns.map((c) => ({ ...c, cards: [] }));
    expect(issues({ ...valid, columns })).toContain("categorize.no_target");
  });

  it("holds between two and six columns", () => {
    expect(issues({ ...valid, columns: valid.columns.slice(0, 1) })).not.toEqual([]);
    const many = Array.from({ length: CATEGORIZE_MAX_COLUMNS + 1 }, (_, i) => ({ id: `c${i}`, label: `C${i}`, cards: [] }));
    expect(issues({ ...valid, columns: many })).not.toEqual([]);
  });

  it("leaves the empty draft invalid but shaped (D16)", () => {
    const draft = emptyCategorizeDraft();
    expect(draft.columns).toHaveLength(2);
    expect(CategorizeConfigSchema.safeParse(draft).success).toBe(false);
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

describe("newId", () => {
  it("mints short opaque ids", () => {
    const ids = new Set(Array.from({ length: 50 }, newId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{8}$/);
  });
});
