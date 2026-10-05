import { describe, expect, it } from "vitest";

import type { CalculatorKey } from "./calculator.js";
import { displayRpn, initialRpn, levelsRpn, pressRpn, type RpnState } from "./rpn.js";

const num = (text: string): CalculatorKey[] =>
  [...text].map((c) => (c === "." ? { kind: "dot" } : { kind: "digit", digit: Number(c) }));
const enter: CalculatorKey = { kind: "enter" };
const op = (o: "+" | "-" | "*" | "/" | "^"): CalculatorKey => ({ kind: "op", op: o });
const run = (...keys: (CalculatorKey | CalculatorKey[])[]): RpnState => keys.flat().reduce(pressRpn, initialRpn);

describe("RPN calculator", () => {
  it("adds with enter: 3 enter 4 +", () => {
    const s = run(num("3"), enter, num("4"), op("+"));
    expect(displayRpn(s)).toBe("7");
    expect(s.stack).toEqual([7]);
  });

  it("takes the operands in order: 10 enter 4 −, 8 enter 2 ÷", () => {
    expect(displayRpn(run(num("10"), enter, num("4"), op("-")))).toBe("6");
    expect(displayRpn(run(num("8"), enter, num("2"), op("/")))).toBe("4");
  });

  it("needs no parenthesis: (2 + 3) × 4", () => {
    expect(displayRpn(run(num("2"), enter, num("3"), op("+"), num("4"), op("*")))).toBe("20");
  });

  it("chains with the result still on the stack, and commits a typed number on an operator", () => {
    // 5 enter 6 + 7 × → (5 + 6) × 7
    expect(displayRpn(run(num("5"), enter, num("6"), op("+"), num("7"), op("*")))).toBe("77");
  });

  it("duplicates the top on enter with nothing typed", () => {
    expect(displayRpn(run(num("5"), enter, enter, op("*")))).toBe("25");
  });

  it("applies a function to the top, and to the number being typed", () => {
    expect(displayRpn(run(num("9"), { kind: "fn", fn: "sqrt" }))).toBe("3");
    const s = run(num("2"), enter, num("9"), { kind: "fn", fn: "sqrt" });
    expect(s.stack).toEqual([2, 3]);
  });

  it("types a negative number, and negates a result", () => {
    expect(run(num("5"), { kind: "fn", fn: "neg" }).entry).toBe("-5");
    expect(displayRpn(run(num("5"), enter, { kind: "fn", fn: "neg" }))).toBe("-5");
  });

  it("swaps, and clears x", () => {
    const s = run(num("1"), enter, num("2"), { kind: "swap" });
    expect(s.stack).toEqual([2, 1]);
    expect(run(num("1"), enter, num("2"), enter, { kind: "clearEntry" }).stack).toEqual([1]);
  });

  it("toggles the angle unit, 2nd and hyp, and applies them to the next function", () => {
    expect(run({ kind: "unit" }).unit).toBe("rad");
    expect(run({ kind: "second" }).second).toBe(true);
    expect(run({ kind: "hyp" }).hyp).toBe(true);
    // 2nd sin of 0.5 is 30 degrees.
    expect(displayRpn(run(num("0.5"), { kind: "second" }, { kind: "trig", fn: "sin" }))).toBe("30");
  });

  it("rolls the stack down", () => {
    expect(run(num("1"), enter, num("2"), enter, num("3"), { kind: "roll" }).stack).toEqual([3, 1, 2]);
  });

  it("pushes a constant and applies trigonometry in degrees", () => {
    expect(displayRpn(run({ kind: "const", name: "pi" }))).toBe("3.14159265358979");
    expect(displayRpn(run(num("30"), { kind: "trig", fn: "sin" }))).toBe("0.5");
  });

  it("lists the levels above the displayed one", () => {
    expect(levelsRpn(run(num("1"), enter, num("2"), enter, num("3"), enter, num("4")))).toEqual(["1", "2", "3"]);
    expect(levelsRpn(run(num("1"), enter, num("2"), enter))).toEqual(["1"]);
    expect(levelsRpn(run(num("1"), enter, num("2")))).toEqual(["1"]);
  });

  it("errors without two operands, and on a division by zero", () => {
    expect(run(num("5"), op("+")).error).toBe("operands");
    expect(run(num("5"), enter, num("0"), op("/")).error).toBe("divideByZero");
  });

  it("recovers from an error on the next digit, and keeps the angle unit on clear", () => {
    const s = run(num("5"), op("+"), num("7"));
    expect(s.error).toBeNull();
    expect(s.entry).toBe("7");
    expect(run({ kind: "unit" }, num("5"), { kind: "clear" }).unit).toBe("rad");
  });

  it("edits the number being typed: backspace, clear entry, exponent", () => {
    expect(run(num("12"), { kind: "back" }).entry).toBe("1");
    expect(run(num("1"), { kind: "back" }).entry).toBeNull();
    expect(displayRpn(run(num("5"), enter, num("9"), { kind: "clearEntry" }))).toBe("5");
    expect(displayRpn(run(num("2"), { kind: "exp" }, num("3"), enter, num("0"), op("+")))).toBe("2000");
  });

  it("ignores the infix-only keys", () => {
    expect(run(num("5"), { kind: "equals" }, { kind: "open" }, { kind: "percent" }).entry).toBe("5");
  });
});
