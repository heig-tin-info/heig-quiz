import { describe, expect, it } from "vitest";

import { evaluate, LogicError, parseExpression, toLatex, type Expr } from "../logic.js";

const v = (name: string): Expr => ({ kind: "var", name });
/** The code and position of the error `source` raises. */
const fault = (source: string, declared?: string[]): { code: string; position: number | null } => {
  try {
    parseExpression(source, declared);
  } catch (e) {
    const { code, position } = e as LogicError;
    return { code, position };
  }
  throw new Error("parsed");
};
const invalid = (position: number) => ({ code: "logic.expression_invalid", position });

describe("parseExpression", () => {
  it("binds NOT > AND > XOR > OR, binary operators to the left", () => {
    expect(parseExpression("A + B * C ^ D")).toEqual({
      kind: "or",
      left: v("A"),
      right: { kind: "xor", left: { kind: "and", left: v("B"), right: v("C") }, right: v("D") },
    });
    expect(parseExpression("A * B * C")).toEqual({
      kind: "and",
      left: { kind: "and", left: v("A"), right: v("B") },
      right: v("C"),
    });
    expect(parseExpression("!A * B")).toEqual({ kind: "and", left: { kind: "not", arg: v("A") }, right: v("B") });
  });

  it("reads every spelling of every operator", () => {
    expect(parseExpression("A·B & C ∧ D")).toEqual(parseExpression("A*B*C*D"));
    expect(parseExpression("A|B ∨ C")).toEqual(parseExpression("A+B+C"));
    expect(parseExpression("A⊕B")).toEqual(parseExpression("A^B"));
    expect(parseExpression("~A")).toEqual(parseExpression("¬A"));
    expect(parseExpression("(1 + 0)")).toEqual({ kind: "or", left: { kind: "const", value: 1 }, right: { kind: "const", value: 0 } });
  });

  it("takes the postfix NOT before the prefix one", () => {
    expect(parseExpression("A'")).toEqual({ kind: "not", arg: v("A") });
    expect(parseExpression("(A+B)'")).toEqual({ kind: "not", arg: parseExpression("A+B") });
    expect(parseExpression("!A''")).toEqual({ kind: "not", arg: { kind: "not", arg: { kind: "not", arg: v("A") } } });
    expect(parseExpression("A * B'")).toEqual({ kind: "and", left: v("A"), right: { kind: "not", arg: v("B") } });
  });

  it("reads multi-letter, case-sensitive names and never juxtaposes", () => {
    expect(parseExpression("AB")).toEqual(v("AB"));
    expect(parseExpression("a + A")).toEqual({ kind: "or", left: v("a"), right: v("A") });
    expect(fault("A B")).toEqual(invalid(2));
    expect(fault("A(B)")).toEqual(invalid(1));
  });

  it("reports the position of a syntax fault", () => {
    expect(fault("A + #")).toEqual(invalid(4));
    expect(fault("2")).toEqual(invalid(0));
    expect(fault("A +")).toEqual(invalid(3));
    expect(fault("")).toEqual(invalid(0));
    expect(fault("(A + B")).toEqual(invalid(6));
    expect(fault("(A B)")).toEqual(invalid(3));
    expect(fault(")")).toEqual(invalid(0));
    expect(fault("A )")).toEqual(invalid(2));
  });

  it("refuses a name outside the declared inputs, prototype names included", () => {
    expect(parseExpression("A * B", ["A", "B", "C"])).toEqual(parseExpression("A * B"));
    expect(fault("A * Bx", ["A", "B"])).toEqual({ code: "logic.unknown_identifier", position: 4 });
    expect(fault("constructor", ["A"])).toEqual({ code: "logic.unknown_identifier", position: 0 });
    expect(parseExpression("toString + constructor", ["toString", "constructor"])).toEqual({
      kind: "or",
      left: v("toString"),
      right: v("constructor"),
    });
  });

  it("refuses an expression over the length or the depth, where the limit is crossed", () => {
    const long = Array.from({ length: 125 }, () => "A").join(" + ");
    expect(long.length).toBeLessThanOrEqual(500);
    expect(() => parseExpression(long)).not.toThrow();
    expect(fault(`${long} + B`)).toEqual(invalid(500));
    expect(() => parseExpression(`${"(".repeat(32)}A${")".repeat(32)}`)).not.toThrow();
    expect(fault(`${"(".repeat(33)}A${")".repeat(33)}`)).toEqual(invalid(32));
    expect(fault(`${"!(".repeat(16)}!A${")".repeat(16)}`)).toEqual(invalid(32));
  });
});

describe("evaluate and toLatex", () => {
  it("evaluates every operator, and refuses a name that is not an own key", () => {
    const e = parseExpression("A * B + C ^ !D");
    expect(evaluate(e, { A: 1, B: 1, C: 0, D: 0 })).toBe(1);
    expect(evaluate(e, { A: 0, B: 1, C: 1, D: 0 })).toBe(0);
    expect(evaluate(parseExpression("0 + 1'"), {})).toBe(0);
    expect(() => evaluate(e, { A: 1 })).toThrow(/logic.unknown_identifier/);
    expect(() => evaluate(parseExpression("constructor"), {})).toThrow(/logic.unknown_identifier/);
    expect(evaluate(parseExpression("constructor"), JSON.parse('{"constructor": 1}'))).toBe(1);
  });

  it("writes LaTeX with overlines and only the parentheses precedence needs", () => {
    expect(toLatex(parseExpression("!(A+B) * C ^ Cin_1"))).toBe("\\overline{A + B} \\cdot C \\oplus \\mathrm{Cin\\_1}");
    expect(toLatex(parseExpression("(A+B)*(C^1) + 0"))).toBe("(A + B) \\cdot (C \\oplus 1) + 0");
    expect(toLatex(parseExpression("A+(B+C)"))).toBe("A + B + C");
    expect(toLatex(parseExpression("(A+B)^C"))).toBe("(A + B) \\oplus C");
  });
});
