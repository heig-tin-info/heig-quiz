/**
 * The grading truth table, through `clozeServer.grade()`: the eight rows of the
 * docs/04 §4.6 syntax table, the weights, and the answer encoding of a
 * dropdown (PLAN-MVP §8 WP2). The grammar itself is proven in `@quiz/domain`.
 */
import { isGraded } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { config, gradeContext } from "./test/fixtures.js";
import type { ClozeConfig } from "./schema.js";
import { clozeServer } from "./server.js";

function gradedNow(cfg: ClozeConfig, blanks: (string | null)[] | null, points = 10) {
  const result = clozeServer.grade(cfg, blanks === null ? null : { blanks }, gradeContext(points));
  if (result instanceof Promise) throw new Error("the cloze grader must be synchronous");
  if (!isGraded(result)) throw new Error("the cloze grader must never return a pending result");
  return result;
}

/** [row of the spec table, text, accepted answer, refused answer] */
const SYNTAX: [string, string, string, string][] = [
  ["{{Newton}} — normalised equality", "La loi de {{Newton}}.", "newton", "Galilée"],
  ["{{a|b}} — alternatives", "{{Newton|Isaac Newton}}", "Isaac Newton", "Newtonn"],
  ["{{=a|b|c}} — dropdown, by canonical index", "{{=Newton|Maxwell|Faraday}}", "0", "2"],
  ["{{#v:t}} — absolute tolerance", "{{#3.14:0.01}}", "3,15", "3.2"],
  ["{{#v:t%}} — relative tolerance", "{{#3.14:1%}}", "3.16", "3.5"],
  ["{{/re/flags}} — full match", "{{/^[0-9a-f]+$/i}}", "DEADBEEF", "ghij"],
  ["{{2*a}} — weighted blank", "{{2*Newton}}", "Newton", "Maxwell"],
  ["\\{{ — literal braces, not a blank", "\\{{ {{Newton}}", "Newton", "{{"],
];

describe("the eight rows of the syntax table", () => {
  for (const [name, text, hit, miss] of SYNTAX) {
    const cfg = config(text);
    it(`${name}: accepts`, () => {
      expect(gradedNow(cfg, [hit], 4).points).toBe(4);
    });
    it(`${name}: refuses`, () => {
      expect(gradedNow(cfg, [miss], 4).points).toBe(0);
    });
  }
});

describe("the weights", () => {
  const cfg = config("{{2*Newton}} et {{Maxwell}} et {{0.5*Faraday}}");

  it("sum to the total, and the earned share decides the points", () => {
    const result = gradedNow(cfg, ["Newton", null, null], 7);
    expect(result.details.total).toBe(3.5);
    expect(result.details.earned).toBe(2);
    expect(result.details.fraction).toBeCloseTo(2 / 3.5, 10);
    expect(result.points).toBe(4);
  });

  it("give every blank when everything is right", () => {
    expect(gradedNow(cfg, ["Newton", "Maxwell", "Faraday"], 7).points).toBe(7);
  });

  it("give nothing when the answer is missing altogether", () => {
    const result = gradedNow(cfg, null, 7);
    expect(result.points).toBe(0);
    expect(result.details.perBlank.every((blank) => !blank.ok)).toBe(true);
  });

  it("treat a blank left untouched as wrong, not as absent", () => {
    const result = gradedNow(cfg, [null, "Maxwell", null], 7);
    expect(result.details.perBlank[0]?.given).toBeNull();
    expect(result.details.perBlank[0]?.ok).toBe(false);
  });
});

describe("case sensitivity", () => {
  it("folds by default (decision D9 keeps the accents significant)", () => {
    expect(gradedNow(config("{{Galilée}}"), ["galilée"], 1).points).toBe(1);
    expect(gradedNow(config("{{Galilée}}"), ["galilee"], 1).points).toBe(0);
  });

  it("is exact when the teacher asks for it", () => {
    const cfg = config("{{Newton}}", { caseSensitive: true });
    expect(gradedNow(cfg, ["Newton"], 1).points).toBe(1);
    expect(gradedNow(cfg, ["newton"], 1).points).toBe(0);
  });
});

describe("a dropdown answer", () => {
  const cfg = config("{{=Newton|Maxwell|Faraday}}");

  it("is the canonical index, whatever the shuffled order was (decision D4)", () => {
    expect(gradedNow(cfg, ["0"], 1).points).toBe(1);
    expect(gradedNow(cfg, ["1"], 1).points).toBe(0);
  });

  it("is refused when it is not an index at all", () => {
    expect(gradedNow(cfg, ["Newton"], 1).points).toBe(0);
    expect(gradedNow(cfg, [""], 1).points).toBe(0);
  });

  it("accepts either key when the teacher marked two", () => {
    const two = config("{{=Newton|=newton|Maxwell}}");
    expect(gradedNow(two, ["0"], 1).points).toBe(1);
    expect(gradedNow(two, ["1"], 1).points).toBe(1);
    expect(gradedNow(two, ["2"], 1).points).toBe(0);
  });
});

describe("the result", () => {
  it("is born validated and validates against detailsSchema", () => {
    const result = gradedNow(config("{{Newton}}"), ["Newton"], 3);
    expect(result.state).toBe("validated");
    expect(clozeServer.detailsSchema.safeParse(result.details).success).toBe(true);
  });

  it("rounds to two decimals", () => {
    const result = gradedNow(config("{{a}} {{b}} {{c}}"), ["a", null, null], 1);
    expect(result.points).toBe(0.33);
  });

  it("carries the key blank by blank, for the teacher panel", () => {
    const result = gradedNow(config("{{Newton|newton}}"), ["x"], 1);
    expect(result.details.perBlank[0]?.expected).toBe("Newton | newton");
  });
});
