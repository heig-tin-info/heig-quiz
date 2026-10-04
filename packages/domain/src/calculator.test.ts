import { describe, expect, it } from "vitest";

import {
  display,
  expression,
  initialCalculator,
  press,
  type CalculatorKey,
  type CalculatorState,
} from "./calculator.js";

/**
 * Types a line of keys, one token per key, as a student would press them:
 * digits and `.`, `+ - * / ^ mod root logBase`, `( )`, `=`, `%`, `C`, `CE`,
 * `<` (backspace), `exp`, `pi`, `e`, `DEG`, `2nd`, `hyp`, a function name, or
 * a trigonometric key.
 */
function keys(line: string, from: CalculatorState = initialCalculator): CalculatorState {
  return line
    .split(" ")
    .filter((k) => k !== "")
    .reduce<CalculatorState>((s, k) => press(s, key(k)), from);
}

const OPS = new Set(["+", "-", "*", "/", "^", "mod", "root", "logBase"]);
const FNS = new Set(["neg", "sqr", "cube", "sqrt", "cbrt", "inv", "abs", "fact", "pow10", "pow2", "powE", "log", "ln"]);
const TRIG = new Set(["sin", "cos", "tan", "sec", "csc", "cot"]);

function key(k: string): CalculatorKey {
  if (/^\d+$/.test(k)) return { kind: "digit", digit: Number(k) };
  if (OPS.has(k)) return { kind: "op", op: k as never };
  if (FNS.has(k)) return { kind: "fn", fn: k as never };
  if (TRIG.has(k)) return { kind: "trig", fn: k as never };
  const named: Record<string, CalculatorKey> = {
    ".": { kind: "dot" },
    "(": { kind: "open" },
    ")": { kind: "close" },
    "=": { kind: "equals" },
    "%": { kind: "percent" },
    C: { kind: "clear" },
    CE: { kind: "clearEntry" },
    "<": { kind: "back" },
    exp: { kind: "exp" },
    pi: { kind: "const", name: "pi" },
    e: { kind: "const", name: "e" },
    DEG: { kind: "unit" },
    "2nd": { kind: "second" },
    hyp: { kind: "hyp" },
  };
  const found = named[k];
  if (!found) throw new Error(`unknown key ${k}`);
  return found;
}

/** Types digits key by key: "123" is three presses. */
const digits = (n: string) => n.split("").join(" ");

const result = (line: string) => display(keys(line));

describe("entry", () => {
  it("starts at 0 and replaces a leading zero", () => {
    expect(display(initialCalculator)).toBe("0");
    expect(result("0 0 7")).toBe("7");
  });

  it("takes one decimal point", () => {
    expect(result(". 5 . 2")).toBe("0.52");
  });

  it("caps an operand at 16 digits", () => {
    expect(result(digits("12345678901234567890"))).toBe("1234567890123456");
  });

  it("erases a digit, and the whole exponent marker at once", () => {
    expect(result("1 2 3 <")).toBe("12");
    expect(result("5 <")).toBe("0");
    expect(result("2 exp <")).toBe("2");
  });

  it("enters a power of ten with exp, ± flipping the exponent", () => {
    expect(result("1 . 5 exp 3")).toBe("1.5e+3");
    expect(result("1 . 5 exp 3 =")).toBe("1500");
    expect(result("2 exp 3 neg =")).toBe("0.002");
  });

  it("flips the sign of digits being typed", () => {
    expect(result("5 neg")).toBe("-5");
    expect(result("5 neg neg")).toBe("5");
    expect(result("0 neg")).toBe("0");
    expect(result("pi neg")).toBe("-3.14159265358979");
    expect(expression(keys("pi neg"))).toBe("−(π)");
  });

  it("clears the entry with CE and everything with C", () => {
    const s = keys("2 + 3 CE 4 =");
    expect(display(s)).toBe("6");
    expect(display(keys("2 + 3 C"))).toBe("0");
    expect(expression(keys("2 + 3 C"))).toBe("");
  });
});

describe("order of operations", () => {
  it("respects precedence in both modes (product owner, 2026-10-04)", () => {
    expect(result("2 + 3 * 4 =")).toBe("14");
    expect(result("2 * 3 + 4 =")).toBe("10");
    expect(result("1 0 - 4 - 3 =")).toBe("3");
    expect(result("8 / 4 / 2 =")).toBe("1");
  });

  it("raises right to left", () => {
    expect(result("2 ^ 3 ^ 2 =")).toBe("512");
  });

  it("groups with parentheses, a number before ( multiplying it", () => {
    expect(result("( 2 + 3 ) * 4 =")).toBe("20");
    expect(result("2 ( 3 + 4 ) =")).toBe("14");
    expect(result("( ( 1 + 2 ) * ( 3 + 4 ) ) =")).toBe("21");
  });

  it("closes the parentheses left open at =", () => {
    const s = keys("2 * ( 3 + 4 =");
    expect(display(s)).toBe("14");
    expect(expression(s)).toBe("2 × ( 3 + 4) =");
  });

  it("replaces an operator pressed twice", () => {
    expect(result("6 + * 2 =")).toBe("12");
  });

  it("repeats the operand before a trailing operator", () => {
    expect(result("3 + =")).toBe("6");
  });
});

describe("expression line", () => {
  it("shows the expression being built, then the one evaluated", () => {
    expect(expression(keys("2 + 3 *"))).toBe("2 + 3 ×");
    expect(display(keys("2 + 3 *"))).toBe("3");
    expect(expression(keys("2 + 3 * 4 ="))).toBe("2 + 3 × 4 =");
  });

  it("shows a function applied to the operand", () => {
    const s = keys("2 + 9 sqrt");
    expect(expression(s)).toBe("2 + √(9)");
    expect(display(s)).toBe("3");
  });

  it("writes functions in symbols, never in words", () => {
    expect(expression(keys("5 fact"))).toBe("5!");
    expect(expression(keys("5 neg cube"))).toBe("(-5)³");
    expect(expression(keys("( 2 + 3 ) sqr"))).toBe("(2 + 3)²");
    expect(expression(keys("3 0 sin sqr"))).toBe("sin(30°)²");
    expect(expression(keys("5 neg abs"))).toBe("|-5|");
    expect(expression(keys("2 7 root"))).toBe("27 ʸ√");
    expect(expression(keys("8 logBase"))).toBe("8 logᵧ");
  });

  it("writes the degree sign on the angle of a circular function", () => {
    expect(expression(keys("3 0 sin"))).toBe("sin(30°)");
    expect(expression(keys("DEG 1 sin"))).toBe("sin(1)");
    expect(expression(keys("2nd . 5 sin"))).toBe("sin⁻¹(0.5)");
  });
});

describe("after =", () => {
  it("starts over on a digit", () => {
    const s = keys("2 + 3 = 7");
    expect(display(s)).toBe("7");
    expect(expression(s)).toBe("");
  });

  it("continues from the result on an operator or a function", () => {
    expect(result("2 + 3 = * 2 =")).toBe("10");
    expect(result("2 + 3 = sqr")).toBe("25");
    expect(expression(keys("2 + 3 = sqr"))).toBe("5²");
  });

  it("does nothing on a second =", () => {
    expect(result("2 + 3 = =")).toBe("5");
  });
});

describe("precision", () => {
  it("rounds float noise away", () => {
    expect(result(". 1 + . 2 =")).toBe("0.3");
    expect(result("1 / 3 * 3 =")).toBe("1");
    expect(result(". 1 + . 2 - . 3 =")).toBe("0");
    expect(result("3 0 sin * 2 =")).toBe("1");
    expect(result("3 0 sin")).toBe("0.5");
    expect(result("1 8 0 sin")).toBe("0");
    expect(result("4 5 tan")).toBe("1");
    expect(result("DEG pi sin")).toBe("0");
  });

  it("writes very large and very small numbers with an exponent", () => {
    expect(result("1 0 ^ 2 5 =")).toBe("1e+25");
    expect(result("1 0 ^ 2 5 neg =")).toBe("1e-25");
  });
});

describe("percent", () => {
  it("is a share of what precedes after + or −", () => {
    expect(result("2 0 0 + 1 0 % =")).toBe("220");
    expect(result("2 0 0 - 1 0 % =")).toBe("180");
  });

  it("is hundredths otherwise", () => {
    expect(result("5 0 * 1 0 % =")).toBe("5");
    expect(result("7 %")).toBe("0.07");
  });
});

describe("functions", () => {
  it.each([
    ["9 sqrt", "3"],
    ["8 neg cbrt", "-2"],
    ["4 inv", "0.25"],
    ["3 sqr", "9"],
    ["3 cube", "27"],
    ["5 neg abs", "5"],
    ["5 fact", "120"],
    ["0 fact", "1"],
    ["3 pow10", "1000"],
    ["1 0 pow2", "1024"],
    ["1 powE", "2.71828182845905"],
    ["1 0 0 0 log", "3"],
    ["e ln", "1"],
    ["pi", "3.14159265358979"],
    ["7 mod 3 =", "1"],
    ["2 7 root 3 =", "3"],
    ["8 neg root 3 =", "-2"],
    ["8 logBase 2 =", "3"],
  ])("%s → %s", (line, expected) => {
    expect(result(line)).toBe(expected);
  });
});

describe("trigonometry", () => {
  it("reads degrees by default and radians after the toggle", () => {
    expect(result("9 0 sin")).toBe("1");
    expect(result("6 0 cos")).toBe("0.5");
    expect(result("DEG pi cos")).toBe("-1");
  });

  it("takes the reciprocal functions", () => {
    expect(result("6 0 sec")).toBe("2");
    expect(result("3 0 csc")).toBe("2");
    expect(result("4 5 cot")).toBe("1");
  });

  it("inverts with 2nd, in the current unit", () => {
    expect(result("2nd . 5 sin")).toBe("30");
    expect(result("2nd 1 tan")).toBe("45");
    expect(result("2nd 2 sec")).toBe("60");
    expect(result("2nd 0 cot")).toBe("90");
    expect(result("DEG 2nd 1 neg cos")).toBe("3.14159265358979");
  });

  it("keeps a tiny angle's sine, and zeroes only the noise of π", () => {
    expect(result("DEG 1 exp 1 6 neg sin")).toBe("1e-16");
    expect(result("DEG pi / 2 = cos")).toBe("0");
  });

  it("goes hyperbolic with hyp, unit-free", () => {
    expect(result("hyp 8 0 0 tan")).toBe("1");
    expect(result("hyp 8 0 0 cot")).toBe("1");
    expect(result("hyp 0 sec")).toBe("1");
    expect(result("hyp 1 csc")).toBe("0.850918128239322");
    expect(result("hyp 0 cos")).toBe("1");
    expect(result("hyp 1 sin")).toBe("1.1752011936438");
    expect(result("hyp 2nd 1 cos")).toBe("0");
  });
});

describe("errors", () => {
  it.each([
    ["5 / 0 =", "divideByZero"],
    ["0 inv", "divideByZero"],
    ["1 neg sqrt", "invalid"],
    ["0 log", "invalid"],
    ["3 . 5 fact", "invalid"],
    ["9 0 tan", "invalid"],
    ["2nd 2 sin", "invalid"],
    ["2nd 0 sec", "invalid"],
    ["hyp 2nd 0 cot", "invalid"],
    ["hyp 0 cot", "invalid"],
    ["1 7 1 fact", "overflow"],
    ["1 0 ^ 4 0 0 =", "overflow"],
  ])("%s → %s", (line, error) => {
    expect(keys(line).error).toBe(error);
  });

  it("starts over on a digit, and ignores an operator", () => {
    expect(result("5 / 0 = 7")).toBe("7");
    expect(keys("5 / 0 = +").error).toBe("divideByZero");
    expect(keys("5 / 0 = C").error).toBeNull();
  });

  it("keeps the angle unit and the toggles through an error", () => {
    const s = keys("DEG 2nd 5 / 0 =");
    expect(s.unit).toBe("rad");
    expect(s.second).toBe(true);
  });
});
