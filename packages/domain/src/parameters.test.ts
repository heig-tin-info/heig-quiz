import { afterEach, describe, expect, it, vi } from "vitest";

import {
  distinctRendered,
  draw,
  FORMAT_PATTERN,
  formattedValues,
  formatValue,
  instantiate,
  isVariableName,
  ParameterError,
  replay,
  sameNames,
  sameTable,
  drawnApart,
  validateParameters,
  type Parameters,
  type Values,
} from "./parameters.js";
import { at, collect, compile, type Issue } from "./parameters/evaluator.js";
import { roundToFormat } from "./parameters/format.js";

/** The ADR's example: a ball dropped from h on a planet of gravity g. */
const MRUA: Parameters = {
  rows: [
    { name: "h", expr: "randint(1, 100)", format: "int" },
    { name: "g", expr: "choice([3.71, 8.87, 9.81, 24.79])", format: ".2" },
    { name: "t", expr: "sqrt(2*h/g)", format: ".2" },
  ],
};

const one = (expr: string, format = ""): Parameters => ({ rows: [{ name: "x", expr, format }] });

/** One text through `instantiate`, with a table declaring `values`' names and the given formats. */
const interpolate = (text: string, values: Values, formats: Record<string, string> = {}) =>
  instantiate(text, { rows: Object.keys(values).map((name) => ({ name, expr: "0", format: formats[name] ?? "" })) }, values);

/** The issue a call throws, or a failure. */
function issueOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ParameterError);
    return (e as ParameterError).issue;
  }
  throw new Error("expected a ParameterError");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("draw", () => {
  it("is deterministic for a seed and varies across seeds", () => {
    const a = draw(MRUA, 42);
    expect(draw(MRUA, 42)).toEqual(a);
    expect(a.exhausted).toBe(false);
    expect(a.runs).toBe(1);
    const { h, g, t } = a.values as { h: number; g: number; t: number };
    expect(Number.isInteger(h) && h >= 1 && h <= 100).toBe(true);
    expect([3.71, 8.87, 9.81, 24.79]).toContain(g);
    expect(t).toBe(roundToFormat(Math.sqrt((2 * h) / g), ".2"));
    const distinct = new Set(Array.from({ length: 20 }, (_, s) => JSON.stringify(draw(MRUA, s).values)));
    expect(distinct.size).toBeGreaterThan(15);
  });

  it("rounds each value by its format before a later row reads it", () => {
    const params: Parameters = {
      rows: [
        { name: "a", expr: "1.005", format: ".2" },
        { name: "b", expr: "a * 100", format: "" },
        { name: "c", expr: "2/3", format: "" },
      ],
    };
    expect(draw(params, 1).values).toEqual({ a: 1.01, b: 101, c: 2 / 3 });
  });

  it("lets a row read only the rows above it", () => {
    const params: Parameters = {
      rows: [
        { name: "a", expr: "b + 1", format: "" },
        { name: "b", expr: "1", format: "" },
      ],
    };
    expect(issueOf(() => draw(params, 1))).toMatchObject({ code: "unknown_name", row: "a" });
  });

  it("draws again when the condition fails, and reports how many runs it took", () => {
    const params: Parameters = { rows: [{ name: "n", expr: "randint(1, 10)", format: "int" }], condition: "n == 7" };
    for (let seed = 0; seed < 10; seed++) {
      const d = draw(params, seed);
      expect(d.values.n).toBe(7);
      expect(d.exhausted).toBe(false);
    }
    expect(Math.max(...Array.from({ length: 10 }, (_, s) => draw(params, s).runs))).toBeGreaterThan(1);
  });

  it("returns the last draw, flagged, when the condition is never met", () => {
    const params: Parameters = { rows: [{ name: "n", expr: "randint(1, 10)", format: "int" }], condition: "n > 10" };
    const d = draw(params, 3);
    expect(d).toMatchObject({ runs: 100, exhausted: true });
    expect(d.values.n).toBeLessThanOrEqual(10);
  });

  it("applies `accept` like the condition", () => {
    const params: Parameters = { rows: [{ name: "n", expr: "randint(1, 3)", format: "int" }] };
    const d = draw(params, 5, { accept: (v) => v.n === 2 });
    expect(d.values.n).toBe(2);
    expect(draw(params, 5, { accept: () => false })).toMatchObject({ runs: 100, exhausted: true });
  });

  it("ignores a blank condition", () => {
    expect(draw({ ...one("1"), condition: "  " }, 1).values).toEqual({ x: 1 });
  });

  it("refuses a condition that is not true or false, and one that fails", () => {
    expect(issueOf(() => draw({ ...one("1"), condition: "x + 1" }, 1))).toMatchObject({
      code: "not_a_boolean",
      row: "condition",
    });
    expect(issueOf(() => draw({ ...one("1"), condition: "\"a\" + 1 > 0" }, 1))).toMatchObject({
      code: "eval_error",
      row: "condition",
    });
    expect(issueOf(() => draw({ ...one("1"), condition: "randint(0, 1) == 1" }, 1))).toMatchObject({
      code: "unknown_function",
      row: "condition",
    });
  });

  it("holds strings, but refuses a format on one", () => {
    expect(draw(one('choice(["N", "kN"])'), 1).values.x).toMatch(/^k?N$/);
    expect(issueOf(() => draw(one('"N"', ".2"), 1))).toMatchObject({ code: "bad_format", row: "x" });
  });

  it("refuses a value that is not a finite number or a string", () => {
    for (const expr of ["1/0", "sqrt(-1)", "log(-1)", "[1, 2]", "1 > 0"]) {
      expect(issueOf(() => draw(one(expr), 1)), expr).toMatchObject({ code: "not_a_number", row: "x" });
    }
    expect(issueOf(() => draw(one('"a" * 2'), 1))).toMatchObject({ code: "eval_error", row: "x" });
  });

  it("checks the arguments of the random functions", () => {
    expect(issueOf(() => draw(one("randint(5, 1)"), 1)).code).toBe("eval_error");
    expect(issueOf(() => draw(one("randint(1)"), 1)).code).toBe("eval_error");
    expect(issueOf(() => draw(one('uniform("a", 2)'), 1)).code).toBe("eval_error");
    expect(issueOf(() => draw(one("choice(3)"), 1)).code).toBe("eval_error");
    expect(issueOf(() => draw(one("choice([])"), 1)).code).toBe("eval_error");
  });

  it("draws randint inclusively and uniform within its bounds", () => {
    const ints = new Set(Array.from({ length: 200 }, (_, s) => draw(one("randint(1.5, 4)"), s).values.x));
    expect([...ints].sort()).toEqual([2, 3, 4]);
    for (let s = 0; s < 50; s++) {
      const u = draw(one("uniform(2, 3)"), s).values.x as number;
      expect(u >= 2 && u < 3).toBe(true);
    }
  });

  it("draws from the platform's generator, never Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    draw({ ...MRUA, rows: [...MRUA.rows, { name: "u", expr: "uniform(0, 1)", format: "" }] }, 9);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws the first static issue of the table", () => {
    expect(issueOf(() => draw(one("1 +"), 1))).toMatchObject({ code: "parse_error", row: "x", offset: 3 });
  });
});

describe("the restricted evaluator refuses, statically", () => {
  const refused: [string, string][] = [
    ['import({}, {override: true})', "unknown_function"],
    ['import("fs")', "unknown_function"],
    ['evaluate("1")', "unknown_function"],
    ['parse("1")', "unknown_function"],
    ['compile("1")', "unknown_function"],
    ['createUnit("x")', "unknown_function"],
    ['simplify("x")', "unknown_function"],
    ["random()", "unknown_function"],
    ["factorial(3)", "unknown_function"],
    ["foo(1)", "unknown_function"],
    ["f(x) = x", "forbidden_node"],
    ["a = 1", "forbidden_node"],
    ["x.constructor", "forbidden_node"],
    ['x["constructor"]', "forbidden_node"],
    ["[1,2][1]", "forbidden_node"],
    ["{a: 1}", "forbidden_node"],
    ["1:1e9", "forbidden_node"],
    ["cos.constructor", "forbidden_node"],
    ['cos.constructor("return process")', "forbidden_node"],
    ["x.f(1)", "forbidden_node"],
    ["(sqrt)(2)", "forbidden_node"],
    ["sqrt", "forbidden_node"],
    ["2pi", "forbidden_node"],
    ["5 cm", "forbidden_node"],
    ["1; 2", "forbidden_node"],
    ["3!", "forbidden_node"],
    ["1 & 2", "forbidden_node"],
    ["[[1, 2], [3, 4]]", "forbidden_node"],
    ["true", "forbidden_node"],
    ["null", "forbidden_node"],
    ["1e400", "not_a_number"],
    ["", "parse_error"],
    ["1 +", "parse_error"],
    ["1" + "+1".repeat(200), "too_long"],
    ["1" + "+1".repeat(60), "too_complex"],
    ["max(" + "1,".repeat(100) + "1)", "too_complex"],
  ];
  it.each(refused)("%s", (expr, code) => {
    expect(issueOf(() => compile(expr)).code).toBe(code);
    expect(validateParameters(one(expr), [])[0]?.code).toBe(code);
  });

  it("accepts the whole allowlist", () => {
    const expr =
      "sqrt(4) + cbrt(8) + abs(-1) + exp(0) + log(e) + log10(10) + log2(2) + sin(0) + cos(0) + tan(0)" +
      " + asin(0) + acos(1) + atan(0) + atan2(0, 1) + sinh(0) + cosh(0) + tanh(0) + round(1.4)";
    const expr2 = "floor(1.5) + ceil(0.5) + fix(-1.5) + sign(-2) + min([1, 2]) + max(1, 2) + hypot(3, 4) + mod(7, 3)";
    const expr3 = "(2 ^ 3 - 1) * 2 / 2 % 4 + -1 + +1 + (1 == 1 and 1 != 2 or not (1 < 2) xor 1 <= 2 and 2 >= 1 ? 1 : 0)";
    expect(draw(one(expr), 1).values.x).toBeCloseTo(12, 9);
    expect(draw(one(expr2), 1).values.x).toBe(1 + 1 - 1 - 1 + 1 + 2 + 5 + 1);
    expect(draw(one(expr3), 1).values.x).toBe(4);
    expect(draw(one("2 * pi"), 1).values.x).toBe(2 * Math.PI);
  });
});

describe("variable names and formats", () => {
  it("accepts identifiers that shadow nothing", () => {
    for (const ok of ["h", "v_0", "_x", "R2"]) expect(isVariableName(ok), ok).toBe(true);
    for (const bad of ["2a", "a-b", "", "pi", "e", "sqrt", "randint", "and", "mod", "Infinity", "a.b", "__proto__"]) {
      expect(isVariableName(bad), bad).toBe(false);
    }
  });

  it("knows the formats", () => {
    for (const ok of ["", "int", ".1", ".6", "1s", "6s"]) expect(FORMAT_PATTERN.test(ok), ok).toBe(true);
    for (const bad of [".0", ".7", "7s", "0s", "INT", "%.2f"]) expect(FORMAT_PATTERN.test(bad), bad).toBe(false);
  });

  it("refuses __proto__ as a name, so no value can vanish into a prototype", () => {
    expect(validateParameters({ rows: [{ name: "__proto__", expr: "1", format: "" }] }, [])[0]?.code).toBe("bad_name");
    const d = draw({ rows: [{ name: "constructor", expr: "2", format: "" }] }, 1);
    expect(Object.getOwnPropertyDescriptor(d.values, "constructor")?.value).toBe(2);
  });
});

describe("formatValue / roundToFormat", () => {
  const table: [number, string, string][] = [
    [1.005, ".2", "1.01"],
    [2.5, "int", "3"],
    [-2.5, "int", "-3"],
    [0.5, "int", "1"],
    [0.4, "int", "0"],
    [999.6, "int", "1000"],
    [9.8, ".2", "9.80"],
    [0.06, ".1", "0.1"],
    [0.004, ".1", "0.0"],
    [-0.001, ".2", "0.00"],
    [1.23456789, ".6", "1.234568"],
    [1234.5, "3s", "1230"],
    [0.0012345, "3s", "0.00123"],
    [1.5, "3s", "1.50"],
    [9.996, "3s", "10.0"],
    [-0.000456, "2s", "-0.00046"],
    [0, "3s", "0"],
    [0, ".2", "0.00"],
    [1.42784312, "", "1.42784"],
    [1234567.89, "", "1234568"],
    [123456789, "", "123456789"],
    [0.1 + 0.2, "", "0.3"],
    [10, "", "10"],
    [1e25, "int", "10000000000000000000000000"],
    [1e-9, "", "1e-9"],
    [1.234e-7, "2s", "1.2e-7"],
    [4.5e21, "3s", "4.50e+21"],
    [5e21, "", "5e+21"],
    [1e-6, "", "0.000001"],
  ];
  it.each(table)("%s as %j is %j", (x, format, shown) => {
    expect(formatValue(x, format)).toBe(shown);
  });

  it("rounds the value the way it is shown, and keeps it whole without a format", () => {
    expect(roundToFormat(1.005, ".2")).toBe(1.01);
    expect(roundToFormat(-2.5, "int")).toBe(-3);
    expect(roundToFormat(1234.5, "2s")).toBe(1200);
    expect(roundToFormat(-0.001, ".2")).toBe(0);
    expect(roundToFormat(2 / 3, "")).toBe(2 / 3);
  });

  it("shows a string as it is", () => {
    expect(formatValue("kN", ".2")).toBe("kN");
  });
});

describe("interpolate", () => {
  const values = { h: 12, g: 9.8, t: 1.56, unit: "m" };
  const formats = { h: "int", g: ".2", t: ".2" };

  it("replaces variables with their format, and expressions with the empty format", () => {
    expect(interpolate("h = [[h]] [[unit]], g = [[ g ]], 2t = [[2*t]], h/7 = [[h/7]]", values, formats)).toBe(
      "h = 12 m, g = 9.80, 2t = 3.12, h/7 = 1.71429",
    );
    expect(interpolate("[[g]]", values)).toBe("9.8");
    expect(interpolate("[[g + 0]]", values, formats)).toBe("9.8");
  });

  it("works inside LaTeX, a cloze blank and C code", () => {
    expect(interpolate("$[[g]]\\,m/s^2$", values, formats)).toBe("$9.80\\,m/s^2$");
    expect(interpolate("{{#[[t]]:1%}}", values, formats)).toBe("{{#1.56:1%}}");
    expect(interpolate("int m[2][2] = {{1,2},{3,4}}; // h=[[h]]", values)).toBe("int m[2][2] = {{1,2},{3,4}}; // h=12");
  });

  it("writes a literal [[ for \\[[", () => {
    expect(interpolate("\\[[h]] is [[h]]", values)).toBe("[[h]] is 12");
  });

  it("closes after nested brackets and quoted strings", () => {
    expect(interpolate("[[max([h, 3])]]!", values)).toBe("12!");
    expect(interpolate('[[h > 1 ? "]]" : "\\"no"]]', values)).toBe("]]");
    expect(interpolate("[[h > 1 ? '[[' : 'x']]", values)).toBe("[[");
  });

  it("refuses an unknown name, at the offset of its [[", () => {
    expect(issueOf(() => interpolate("abc [[zz]]", values))).toMatchObject({ code: "unknown_name", offset: 4 });
  });

  it("refuses an unclosed [[, a random function and a failing expression", () => {
    expect(issueOf(() => interpolate("x [[h", values))).toMatchObject({ code: "unterminated", offset: 2 });
    expect(issueOf(() => interpolate("[[randint(1, 2)]]", values)).code).toBe("unknown_function");
    expect(issueOf(() => interpolate("..[[h/0]]", values))).toMatchObject({ code: "not_a_number", offset: 2 });
    expect(issueOf(() => interpolate("[[ -f x ]]", values)).offset).toBe(0);
  });

});

describe("instantiate", () => {
  it("interpolates every string of a JSON value, leaves the rest, mutates nothing", () => {
    const config = {
      prompt: "Drop from [[h]] m",
      choices: [
        { text: "[[t]] s", correct: true, weight: 1 },
        { text: "[[2*t]] s", correct: false, weight: null },
      ],
      matcher: { kind: "number", value: "[[t]]", tolerance: 0.01 },
    };
    const frozen = structuredClone(config);
    const params: Parameters = {
      rows: [
        { name: "h", expr: "10", format: "int" },
        { name: "t", expr: "1.43", format: ".2" },
      ],
    };
    const out = instantiate(config, params, { h: 10, t: 1.43 });
    expect(out).toEqual({
      prompt: "Drop from 10 m",
      choices: [
        { text: "1.43 s", correct: true, weight: 1 },
        { text: "2.86 s", correct: false, weight: null },
      ],
      matcher: { kind: "number", value: "1.43", tolerance: 0.01 },
    });
    expect(config).toEqual(frozen);
    expect(out).not.toBe(config);
    expect(instantiate(7, params, {})).toBe(7);
  });

  it("keeps a __proto__ key a key", () => {
    const json = JSON.parse('{"__proto__": "[[x]]"}') as Record<string, unknown>;
    const out = instantiate(json, one("1"), { x: 1 });
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toBe("1");
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("says where a failure lies", () => {
    expect(issueOf(() => instantiate({ a: ["ok", "x [[y]]"] }, one("1"), { x: 1 }))).toMatchObject({
      code: "unknown_name",
      path: "/a/1",
      offset: 2,
    });
  });
});

describe("validateParameters", () => {
  const texts = { prompt: "From [[h]] m with $g = [[g]]$", answer: "[[t]]" };

  it("accepts the ADR's example", () => {
    expect(validateParameters({ ...MRUA, condition: "t > 1" }, texts)).toEqual([]);
  });

  it("returns every static issue at once, positioned", () => {
    const params: Parameters = {
      rows: [
        { name: "pi", expr: "1", format: "" },
        { name: "a", expr: "1", format: "%d" },
        { name: "a", expr: "2pi", format: "" },
        { name: "b", expr: "c", format: "" },
      ],
      condition: "a >",
    };
    const issues = validateParameters(params, ["ok [[a]]", "[[zz]] and [[b", "\\[[fine]]"]);
    expect(issues.map((i) => [i.code, i.row ?? i.path])).toEqual([
      ["bad_name", "pi"],
      ["bad_format", "a"],
      ["duplicate_name", "a"],
      ["forbidden_node", "a"],
      ["unknown_name", "b"],
      ["parse_error", "condition"],
      ["unknown_name", "/1"],
      ["unterminated", "/1"],
    ]);
    expect(issues[6]?.offset).toBe(0);
    expect(issues[7]?.offset).toBe(11);
    for (const i of issues) expect(typeof i.message).toBe("string");
  });

  it("reports an exhausted condition", () => {
    const issues = validateParameters({ ...one("randint(1, 6)", "int"), condition: "x > 6" }, []);
    expect(issues).toEqual([expect.objectContaining({ code: "condition_exhausted", row: "condition" })]);
  });

  it("stops at the first draw that fails, naming the seed", () => {
    const params: Parameters = {
      rows: [
        { name: "n", expr: "randint(0, 3)", format: "int" },
        { name: "y", expr: "1 / n", format: ".2" },
      ],
    };
    const issues = validateParameters(params, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "not_a_number", row: "y" });
    expect(issues[0]?.message).toMatch(/^seed \d+: /);
  });

  it("evaluates the texts with each draw", () => {
    const issues = validateParameters(one("randint(0, 3)", "int"), { a: "[[1/x]]" });
    expect(issues).toEqual([expect.objectContaining({ code: "not_a_number", path: "/a" })]);
  });

  it("names an exhaustion caused by `accept` apart from the condition's", () => {
    expect(validateParameters(one("randint(1, 2)", "int"), [], { accept: () => false })).toEqual([
      expect.objectContaining({ code: "choices_not_distinct" }),
    ]);
    const never: Parameters = { ...one("randint(1, 2)", "int"), condition: "x > 2" };
    expect(validateParameters(never, [], { accept: () => false })[0]?.code).toBe("condition_exhausted");
  });

  it("draws 200 seeds, within a 2 s budget", () => {
    const spy = vi.fn(() => true);
    expect(validateParameters(MRUA, [], { accept: spy })).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(200);
    let now = 0;
    const clock = () => (now += 100);
    expect(validateParameters(MRUA, texts, { clock })).toEqual([
      expect.objectContaining({ code: "too_slow", message: "21 draws took more than 2000 ms" }),
    ]);
  });

  it("lets a bug that is not a ParameterError go up", () => {
    expect(() =>
      validateParameters(MRUA, [], {
        accept: () => {
          throw new TypeError("bug");
        },
      }),
    ).toThrow(TypeError);
  });

  it("draws nothing for a table without rows, and finds no reference in a static text", () => {
    expect(validateParameters({ rows: [] }, ["plain text"])).toEqual([]);
  });
});

describe("distinctRendered", () => {
  it("refuses equal texts and numbers within the gap", () => {
    expect(distinctRendered(["1.43 s", "2.86 s", "0.71 s"])).toBe(true);
    expect(distinctRendered(["a", " a "])).toBe(false);
    expect(distinctRendered(["100", "100.5"])).toBe(false);
    expect(distinctRendered(["100", "102"])).toBe(true);
    expect(distinctRendered(["0", "-0"])).toBe(false);
    expect(distinctRendered(["1e3", "1000"])).toBe(false);
    expect(distinctRendered(["1 m", "1.001 m"])).toBe(true);
    expect(distinctRendered([])).toBe(true);
  });

  it("compares a long digit run as text, never through the number pattern", () => {
    const run = "9".repeat(120_000);
    expect(distinctRendered([`${run}x`, `${run}y`, `1${run}`, `${run}.5`])).toBe(true);
    expect(distinctRendered([`${"9".repeat(39)}x`, "9".repeat(39)])).toBe(true);
    expect(distinctRendered([`1${"0".repeat(30)}`, `1${"0".repeat(29)}1`])).toBe(false);
  });
});

describe("sameNames / replay (ADR-056 §5)", () => {
  it("tells whether stored values hold exactly a table's names", () => {
    const { values } = draw(MRUA, 3);
    expect(sameNames(MRUA, values)).toBe(true);
    expect(sameNames(MRUA, { h: 1, g: 2 })).toBe(false);
    expect(sameNames(MRUA, { ...values, extra: 1 })).toBe(false);
    expect(sameNames({ rows: [] }, {})).toBe(true);
  });

  it("tells whether two tables declare the same names, in any order", () => {
    const reordered: Parameters = { rows: [...MRUA.rows].reverse().map((r) => ({ ...r, expr: "1" })) };
    expect(sameTable(MRUA, reordered)).toBe(true);
    expect(sameTable(MRUA, { rows: MRUA.rows.slice(1) })).toBe(false);
    expect(sameTable(MRUA, { rows: [...MRUA.rows.slice(1), { name: "k", expr: "1", format: "" }] })).toBe(false);
    expect(sameTable(null, null)).toBe(true);
    expect(sameTable(null, MRUA)).toBe(false);
  });

  it("keeps the drawn rows and evaluates the others again, in order and rounded", () => {
    const { values } = draw(MRUA, 7);
    // Version N: the same names, a corrected formula for t, a new rounding.
    const next: Parameters = {
      rows: [
        { name: "h", expr: "randint(1, 1000)", format: "int" },
        { name: "g", expr: "choice([1, 2])", format: ".2" },
        { name: "t", expr: "sqrt(h/g)", format: ".1" },
      ],
    };
    const replayed = replay(next, values);
    expect(replayed.h).toBe(values.h);
    expect(replayed.g).toBe(values.g);
    expect(replayed.t).toBe(roundToFormat(Math.sqrt((values.h as number) / (values.g as number)), ".1"));
    // The same table replays to the very same values.
    expect(replay(MRUA, values)).toEqual(values);
  });

  it("refuses a drawn row without a stored value, a static issue and a failed evaluation", () => {
    expect(issueOf(() => replay(MRUA, { g: 9.81, t: 1 }))).toMatchObject({ code: "unknown_name", row: "h" });
    expect(issueOf(() => replay(one("2pi"), { x: 1 })).code).toBe("forbidden_node");
    expect(issueOf(() => replay(one("sqrt(-1)"), { x: 1 }))).toMatchObject({ row: "x" });
  });
});

describe("at / collect", () => {
  it("enrich a ParameterError and let anything else go up unchanged", () => {
    const bug = new TypeError("bug");
    const boom = () => {
      throw bug;
    };
    expect(() => at({ row: "x" }, boom)).toThrow(bug);
    expect(() => collect([], { row: "x" }, boom)).toThrow(bug);
    const issues: Issue[] = [];
    expect(collect(issues, { row: "x" }, () => compile("2pi"))).toBeUndefined();
    expect(issues).toEqual([expect.objectContaining({ code: "forbidden_node", row: "x" })]);
  });
});

describe("drawnApart", () => {
  const NOISE: Parameters = {
    rows: [...MRUA.rows, { name: "d", expr: "uniform(1, 5)", format: ".1" }, { name: "k", expr: "2*d", format: "" }],
  };
  const SHARED = ["Dropped from [[h]] m, g = [[g]].", "[[t]] s"];

  it("is true when an option depends on a draw nothing shared depends on", () => {
    expect(drawnApart("[[d]] s", SHARED, NOISE)).toBe(true);
    expect(drawnApart("about [[t + d]] s", SHARED, NOISE)).toBe(true);
    // Through a derived row.
    expect(drawnApart("[[k]] s", SHARED, NOISE)).toBe(true);
  });

  it("is false for a formula of the shared values, a literal and a static table", () => {
    expect(drawnApart("[[sqrt(h/g)]] s", SHARED, NOISE)).toBe(false);
    expect(drawnApart("[[h]] s", SHARED, NOISE)).toBe(false);
    expect(drawnApart("none of these", SHARED, NOISE)).toBe(false);
    expect(drawnApart("\\[[d]] escaped", SHARED, NOISE)).toBe(false);
    expect(drawnApart("[[x]]", [], { rows: [{ name: "x", expr: "2 + 3", format: "" }] })).toBe(false);
    // Shared through the statement, the draw is the question's own.
    expect(drawnApart("[[d]] s", [...SHARED, "with [[d]]"], NOISE)).toBe(false);
  });

  it("reads nothing from a reference or a row that does not parse", () => {
    expect(drawnApart("[[d +]] s", SHARED, NOISE)).toBe(false);
    expect(drawnApart("[[d]]", [], { rows: [{ name: "d", expr: "uniform(", format: "" }] })).toBe(false);
  });
});

describe("formattedValues", () => {
  it("writes each value with its row's format, in the table's order, leaving out a row without one", () => {
    expect(formattedValues(MRUA, { t: 2.6, h: 40, g: 9.81 })).toEqual([
      { name: "h", value: "40" },
      { name: "g", value: "9.81" },
      { name: "t", value: "2.60" },
    ]);
    expect(formattedValues(MRUA, { h: 40 })).toEqual([{ name: "h", value: "40" }]);
  });
});
