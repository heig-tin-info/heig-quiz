import { describe, expect, it } from "vitest";

import {
  compareMath,
  curveOf,
  MATH_FUNCTIONS,
  MATH_MAX_LATEX,
  MATH_RESERVED_SYMBOLS,
  MATH_SYMBOL_PATTERN,
  readMath,
  samplePoints,
  type MathReading,
  type MathSymbol,
  type ReadOptions,
} from "./math.js";

const read = (latex: string, symbols: string[] = ["x"]): MathReading => {
  const result = readMath(latex, { symbols });
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.problem)}`);
  return result.reading;
};
const problem = (latex: string, options: ReadOptions = { symbols: ["x"] }) => {
  const result = readMath(latex, options);
  return result.ok ? null : result.problem;
};
const at = (latex: string, x: number) => read(latex).evaluate({ x });

const X: MathSymbol[] = [{ name: "x", min: 0.5, max: 2 }];
const R: MathSymbol[] = [
  { name: "R_1", min: 1, max: 100 },
  { name: "R_2", min: 1, max: 100 },
];

describe("readMath", () => {
  it("reads an expression over the declared symbols and evaluates it", () => {
    const r = read("2x^2-\\frac{3}{x+1}");
    expect(r.evaluate({ x: 1.5 })).toBeCloseTo(3.3, 12);
    expect(r.latex).toBe("2x^2-\\frac{3}{x+1}");
    expect(r.functions).toEqual(["power"]);
  });

  it("refuses what is empty, too long or malformed, in that order", () => {
    expect(problem("  ")).toEqual({ code: "empty" });
    expect(problem("x+".repeat(200))).toEqual({ code: "too_long", max: MATH_MAX_LATEX });
    expect(problem("x+".repeat(30), { symbols: ["x"], maxLength: 40 })).toEqual({ code: "too_long", max: 40 });
    expect(problem("x^{2")).toEqual({ code: "syntax" });
    expect(problem("\\foo(x)")).toEqual({ code: "syntax" });
    expect(problem("x^2 +")).toEqual({ code: "syntax" });
  });

  it("caps the length at the engine's own cap whatever the question asks", () => {
    expect(problem("x".repeat(400), { symbols: ["x"], maxLength: 10_000 })).toEqual({ code: "too_long", max: MATH_MAX_LATEX });
  });

  it("names the symbols the question does not declare", () => {
    expect(problem("x+y")).toEqual({ code: "unknown_symbol", names: ["y"] });
    expect(problem("R_1+R_2", { symbols: ["R_1"] })).toEqual({ code: "unknown_symbol", names: ["R_2"] });
    // `\omega` is the symbol `omega`; the constants are not symbols.
    expect(problem("\\omega t+\\pi e", { symbols: ["omega", "t"] })).toBeNull();
    expect(read("\\pi e", []).evaluate({})).toBeCloseTo(Math.PI * Math.E, 12);
  });

  it("refuses the constructs the interpreter has no value for, by name", () => {
    expect(problem("\\sum_{n=0}^{9}x")).toEqual({ code: "unsupported", names: ["Sum", "Limits", "n"] });
    expect(problem("\\frac{d}{dx}x^2")?.code).toBe("unsupported");
    expect(problem("x!")).toEqual({ code: "unsupported", names: ["Factorial"] });
    expect(problem("ix")).toEqual({ code: "unsupported", names: ["Complex"] });
    expect(problem("\\min(x,1)")).toEqual({ code: "unsupported", names: ["Min"] });
    expect(problem("x=1")).toEqual({ code: "unsupported", names: ["Equal"] });
    expect(problem("\\frac{1}{0}")).toEqual({ code: "unsupported", names: ["ComplexInfinity"] });
    expect(problem("\\infty")).toEqual({ code: "unsupported", names: ["PositiveInfinity"] });
  });

  it("reads the functions used, e^x and exp(x) alike, and applies the teacher's rule", () => {
    expect(read("\\sin(x)^2+e^{x}+\\sqrt{x}+\\ln x+|x|").functions.sort()).toEqual(["abs", "exp", "ln", "power", "sin", "sqrt"]);
    expect(read("\\exp(x)").functions).toEqual(["exp"]);
    expect(read("x^{0.5}").functions).toEqual(["sqrt"]);
    expect(read("\\sqrt[3]{x}").functions).toEqual(["sqrt"]);
    expect(read("\\log x+\\log_2 x").functions).toEqual(["log"]);
    expect(read("\\cos x+\\tan x+\\arcsin x+\\arccos x+\\arctan x+\\sinh x+\\cosh x+\\tanh x").functions.sort()).toEqual(
      ["acos", "asin", "atan", "cos", "cosh", "sinh", "tan", "tanh"],
    );
    expect(problem("\\sin(x)", { symbols: ["x"], forbidden: ["sin", "cos"] })).toEqual({ code: "forbidden_function", names: ["sin"] });
    expect(problem("\\sqrt{x}", { symbols: ["x"], forbidden: ["sin"] })).toBeNull();
  });

  it("echoes e, not the engine's macro, and the reading of an ambiguous slash", () => {
    expect(read("\\exp(x)").latex).toBe("e^{x}");
    expect(read("2/3x").latex).toBe("\\frac{2}{3x}");
  });

  it("evaluates every operator of the table", () => {
    expect(at("\\frac12x", 3)).toBe(1.5);
    expect(at("\\sqrt[3]{x}", 8)).toBeCloseTo(2, 12);
    expect(at("\\log_2 x", 8)).toBeCloseTo(3, 12);
    expect(at("\\log x", 1000)).toBeCloseTo(3, 12);
    expect(at("\\ln x", Math.E)).toBeCloseTo(1, 12);
    expect(at("-x+|x|", -2)).toBe(4);
    expect(at("x-1", 3)).toBe(2);
    expect(at("x\\times10^{-3}", 5)).toBeCloseTo(0.005, 15);
    expect(at("\\arcsin x+\\arccos x+\\arctan x", 0.5)).toBeCloseTo(Math.asin(0.5) + Math.acos(0.5) + Math.atan(0.5), 12);
    expect(at("\\sinh x+\\cosh x+\\tanh x+\\cos x+\\tan x", 0.3)).toBeCloseTo(
      Math.sinh(0.3) + Math.cosh(0.3) + Math.tanh(0.3) + Math.cos(0.3) + Math.tan(0.3),
      12,
    );
    expect(at("e^{x}", 1)).toBeCloseTo(Math.E, 12);
    expect(at("2^x", 10)).toBe(1024);
  });

  it("has no value where the result is complex, infinite or out of range", () => {
    expect(at("\\sqrt{x}", -4)).toBeNull();
    expect(at("\\frac{1}{x}", 0)).toBeNull();
    expect(at("\\ln x", -1)).toBeNull();
    expect(at("\\arcsin x", 2)).toBeNull();
    expect(at("x^{0.5}", -1)).toBeNull();
    expect(read("10^{400}", []).evaluate({})).toBeNull();
  });

  it("costs the size of the tree, never the size of the numbers (a 13-character denial of service)", () => {
    const start = performance.now();
    const r = read("x+10^{10^{6}}");
    expect(r.evaluate({ x: 1 })).toBeNull();
    expect(read("x^{x^{x^{x}}}").evaluate({ x: 50 })).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("refuses, before parsing, the shapes the parser takes exponential time on", () => {
    const start = performance.now();
    expect(problem("-".repeat(290) + "x")).toEqual({ code: "syntax" });
    expect(problem("+".repeat(290) + "x")).toEqual({ code: "syntax" });
    expect(problem("x*" + "-".repeat(40) + "x")).toEqual({ code: "syntax" });
    expect(problem("- - - - - - - - - - - - - - - - - - - - x")).toEqual({ code: "syntax" });
    expect(problem("|".repeat(100) + "x" + "|".repeat(100))).toEqual({ code: "syntax" });
    expect(problem("\\vert ".repeat(20) + "x" + "\\vert ".repeat(20))).toEqual({ code: "syntax" });
    expect(problem("\\lvert ".repeat(20) + "x" + "\\rvert ".repeat(20))).toEqual({ code: "syntax" });
    expect(performance.now() - start).toBeLessThan(100);
    // What a person writes is untouched: two signs, a few absolute values.
    expect(at("x-(-1)", 3)).toBe(4);
    expect(at("-(-x)", 3)).toBe(3);
    expect(at("|x|+|x-1|+|x-2|+|x-3|", 0)).toBe(6);
  });

  it("turns a numeral the engine cannot hold into a syntax problem, never a throw", () => {
    expect(problem("1e" + "9".repeat(280))).toEqual({ code: "syntax" });
  });

  it("outlives its engine: reads keep working past the recycling point, fresh names or not", () => {
    for (let i = 0; i < 1200; i++) expect(readMath(`q_{${i}}+1`, { symbols: [`q_${i}`] }).ok).toBe(true);
    expect(at("x+1", 1)).toBe(2);
  });

  it("exposes the function list and the symbol rule the schema uses", () => {
    expect(MATH_FUNCTIONS).toContain("sqrt");
    for (const name of ["x", "R1", "R_1", "omega", "x_a", "R_10"]) expect(MATH_SYMBOL_PATTERN.test(name), name).toBe(true);
    for (const name of ["1x", "x y", "x_", "_x", "x-1", ""]) expect(MATH_SYMBOL_PATTERN.test(name), name).toBe(false);
    expect(MATH_RESERVED_SYMBOLS).toEqual(["e", "i", "pi"]);
  });
});

describe("samplePoints", () => {
  it("draws every symbol in its interval, the same points for the same question", () => {
    const a = samplePoints(R, 10, ["key", "R_1,R_2"]);
    const b = samplePoints(R, 10, ["key", "R_1,R_2"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
    for (const point of a) {
      expect(point["R_1"]).toBeGreaterThanOrEqual(1);
      expect(point["R_1"]).toBeLessThanOrEqual(100);
      expect(point["R_2"]).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(a.map((p) => p["R_1"])).size).toBe(10);
  });

  it("changes with the question", () => {
    expect(samplePoints(X, 3, ["a"])).not.toEqual(samplePoints(X, 3, ["b"]));
  });
});

describe("compareMath", () => {
  const points = samplePoints(R, 10, ["parallel"]);

  it("accepts an equivalent form and refuses a different one", () => {
    const key = read("\\frac{R_1 R_2}{R_1+R_2}", ["R_1", "R_2"]);
    const same = read("\\frac{1}{\\frac{1}{R_1}+\\frac{1}{R_2}}", ["R_1", "R_2"]);
    const series = read("R_1+R_2", ["R_1", "R_2"]);
    expect(compareMath(key, same, points, 1e-6)).toEqual({ equivalent: true, compared: 10 });
    expect(compareMath(key, series, points, 1e-6)).toEqual({ equivalent: false, compared: 10 });
  });

  it("loosens with the tolerance: a rounded constant passes at 1 %", () => {
    const xs = samplePoints(X, 10, ["g"]);
    const key = read("\\frac{1}{2}\\cdot 9.81 x^2");
    const rounded = read("4.9x^2");
    expect(compareMath(key, rounded, xs, 1e-6).equivalent).toBe(false);
    expect(compareMath(key, rounded, xs, 0.01).equivalent).toBe(true);
  });

  it("skips the points where the key has no value, and fails a candidate that has none where the key does", () => {
    const wide = samplePoints([{ name: "x", min: -2, max: 2 }], 20, ["sqrt"]);
    const key = read("\\sqrt{x}");
    const compared = compareMath(key, read("x^{0.5}"), wide, 1e-6);
    expect(compared.equivalent).toBe(true);
    expect(compared.compared).toBeLessThan(20);
    expect(compared.compared).toBeGreaterThan(0);
    // A reading with no value on the negative half, where the key has one.
    const half: MathReading = { latex: "", functions: [], evaluate: (env) => (env["x"]! < 0 ? null : env["x"]! ** 2) };
    expect(compareMath(read("x^2"), half, wide, 1e-6)).toEqual({ equivalent: false, compared: 20 });
  });

  it("reports a key undefined on the whole domain", () => {
    expect(compareMath(read("\\sqrt{x}"), read("x"), samplePoints([{ name: "x", min: -5, max: -1 }], 5, ["neg"]), 1e-6)).toEqual({
      equivalent: false,
      compared: 0,
    });
  });

  it("compares relative to the key's magnitude: float noise near a zero of a large function passes", () => {
    const xs = samplePoints([{ name: "x", min: 0, max: 7 }], 10, ["sin"]);
    expect(compareMath(read("1000\\sin(x)"), read("1000\\sin(x)+10^{-9}"), xs, 1e-6).equivalent).toBe(true);
    expect(compareMath(read("1000\\sin(x)"), read("1000\\sin(x)+0.01"), xs, 1e-6).equivalent).toBe(false);
  });

  it("treats two zero functions as the same", () => {
    expect(compareMath(read("x-x"), read("0"), samplePoints(X, 5, ["zero"]), 1e-6)).toEqual({ equivalent: true, compared: 5 });
  });
});

describe("curveOf", () => {
  it("samples an even grid, null where there is no value", () => {
    expect(curveOf(read("\\frac{2}{x}"), "x", -1, 1, 5)).toEqual([-2, -4, null, 4, 2]);
  });

  it("gives two points for a degenerate grid", () => {
    expect(curveOf(read("x"), "x", 3, 3, 1)).toEqual([3, 3]);
  });
});
