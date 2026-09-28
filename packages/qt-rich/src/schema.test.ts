import { describe, expect, it } from "vitest";
import {
  a4Pages,
  countChars,
  emptyRichDraft,
  pagesText,
  RICH_MAX_CHARS,
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

  it("refuses an empty statement, which the empty draft has (D16)", () => {
    expect(RichConfigSchema.safeParse(emptyRichDraft()).success).toBe(false);
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
