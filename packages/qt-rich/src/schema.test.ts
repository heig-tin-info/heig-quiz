import { describe, expect, it } from "vitest";
import {
  a4Pages,
  countChars,
  essayPoints,
  pagesText,
  RICH_MAX_CHARS,
  RICH_MAX_CRITERIA,
  RichAnswerSchema,
  RichConfigSchema,
} from "./schema.js";
import { config } from "./test/fixtures.js";

describe("the rich config", () => {
  it("fills the defaults: formatted field, empty rubric, no limit", () => {
    const parsed = config();
    expect(parsed.format).toBe("markdown");
    expect(parsed.rubric).toBe("");
    expect(parsed.maxChars).toBeUndefined();
    expect(parsed.reference).toBeUndefined();
  });

  it("holds a limit between 1 and the hard cap", () => {
    const at = (maxChars: number) =>
      RichConfigSchema.safeParse({ ...config(), maxChars }).success;
    expect(at(1)).toBe(true);
    expect(at(RICH_MAX_CHARS)).toBe(true);
    expect(at(0)).toBe(false);
    expect(at(RICH_MAX_CHARS + 1)).toBe(false);
    expect(at(2.5)).toBe(false);
  });

  it("has no criteria by default, and holds a few with unique ids", () => {
    expect(config().criteria).toEqual([]);
    const one = (id: string) => ({ id, title: "Names the guard page", weight: 2 });
    const parsed = config({ criteria: [one("a")] } as never);
    expect(parsed.criteria).toEqual([{ id: "a", title: "Names the guard page", weight: 2, prompt: "" }]);
    const at = (criteria: unknown) => RichConfigSchema.safeParse({ ...config(), criteria }).success;
    expect(at([one("a"), one("a")])).toBe(false);
    expect(at([{ ...one("a"), weight: 0 }])).toBe(false);
    expect(at([{ ...one("a"), weight: 1.5 }])).toBe(false);
    expect(at([{ ...one("a"), title: "  " }])).toBe(false);
    expect(at([one("a b")])).toBe(false);
    expect(at([one("a.b")])).toBe(false);
    expect(at([one("Ab_9-z")])).toBe(true);
    expect(at(Array.from({ length: RICH_MAX_CRITERIA + 1 }, (_, i) => one(`c${i}`)))).toBe(false);
  });

  it("is worth the sum of its weights, else 1, or its total when normalized", () => {
    const two = [
      { id: "a", title: "A", weight: 2, prompt: "" },
      { id: "b", title: "B", weight: 3, prompt: "" },
    ];
    expect(essayPoints(config())).toBe(1);
    expect(essayPoints(config({ criteria: two }))).toBe(5);
    expect(essayPoints(config({ criteria: two, normalize: true, totalPoints: 7.5 }))).toBe(7.5);
    // Without criteria the switch is hidden, and the default stays 1.
    expect(essayPoints({ criteria: [], normalize: true, totalPoints: 7.5 })).toBe(1);
  });

  it("reads a config from before the switch as points, and holds a total only when normalized", () => {
    const old = config({ criteria: [{ id: "a", title: "A", weight: 2, prompt: "" }] });
    expect(old.normalize).toBe(false);
    expect(old.totalPoints).toBeUndefined();
    const at = (over: Record<string, unknown>) => RichConfigSchema.safeParse({ ...old, ...over }).success;
    expect(at({ normalize: true, totalPoints: 10 })).toBe(true);
    expect(at({ normalize: true, totalPoints: 0.5 })).toBe(true);
    expect(at({ normalize: true, totalPoints: 1000 })).toBe(true);
    expect(at({ normalize: true })).toBe(false);
    expect(at({ normalize: false, totalPoints: 10 })).toBe(false);
    expect(at({ totalPoints: 10 })).toBe(false);
    expect(at({ normalize: true, totalPoints: 0.25 })).toBe(false);
    expect(at({ normalize: true, totalPoints: 1000.5 })).toBe(false);
  });

  it("takes a plain field", () => {
    expect(config({ format: "plain" }).format).toBe("plain");
    expect(RichConfigSchema.safeParse({ ...config(), format: "html" }).success).toBe(false);
  });
});

describe("the rich answer", () => {
  it("is capped at the hard limit whatever the question says", () => {
    expect(RichAnswerSchema.safeParse({ text: "a".repeat(RICH_MAX_CHARS) }).success).toBe(true);
    expect(RichAnswerSchema.safeParse({ text: "a".repeat(RICH_MAX_CHARS + 1) }).success).toBe(false);
  });

  it("is an object with a text, never a bare string", () => {
    expect(RichAnswerSchema.safeParse("an essay").success).toBe(false);
  });

  it("counts what the textarea counts, markdown marks included", () => {
    expect(countChars("**bold**")).toBe(8);
  });
});

describe("the A4 hint", () => {
  it("rounds to a tenth of a page, in the reader's separator", () => {
    expect(a4Pages(3000)).toBe(1);
    expect(a4Pages(1500)).toBe(0.5);
    expect(pagesText(4500, ",")).toBe("1,5");
    expect(pagesText(0, ",")).toBe("0");
  });
});
