import { describe, expect, it } from "vitest";

import { emptyMathDraft, fieldRules, MathConfigSchema } from "./schema.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";

const issues = (over: object) => {
  const result = MathConfigSchema.safeParse({ ...config(), ...over });
  return result.success ? [] : result.error.issues.map((i) => ({ path: i.path, message: i.message }));
};

describe("MathConfigSchema", () => {
  it("fills the defaults", () => {
    expect(config()).toMatchObject({ tolerance: 1e-6, samples: 10, forbidden: [], maxLength: 200, plot: "none" });
    expect(config().answers[0]).toEqual({ value: "2x^2-3", points: 1 });
    expect(MathConfigSchema.safeParse(SECRET_CONFIG).success).toBe(true);
  });

  it("refuses the empty draft (D16), which still carries its version", () => {
    expect(MathConfigSchema.safeParse(emptyMathDraft()).success).toBe(false);
    expect(emptyMathDraft().configVersion).toBe(1);
  });

  it("checks the symbols: a name, distinct, not a constant, an interval", () => {
    expect(issues({ symbols: [{ name: "1x", min: 0, max: 1 }] })[0]?.path).toEqual(["symbols", 0, "name"]);
    expect(issues({ symbols: [{ name: "x", min: 0, max: 1 }, { name: "x", min: 0, max: 1 }] })).toEqual([
      { path: ["symbols", 1, "name"], message: "math.duplicate_symbol" },
    ]);
    expect(issues({ symbols: [{ name: "e", min: 0, max: 1 }] })).toEqual([{ path: ["symbols", 0, "name"], message: "math.reserved_symbol" }]);
    expect(issues({ symbols: [{ name: "x", min: 2, max: 1 }] })).toEqual([{ path: ["symbols", 0, "max"], message: "math.symbol_range" }]);
    expect(issues({ symbols: [] })).toHaveLength(1);
  });

  it("refuses a plot with two symbols", () => {
    expect(issues({ plot: "target", symbols: [{ name: "x", min: 0, max: 1 }, { name: "y", min: 0, max: 1 }] })).toEqual([
      { path: ["plot"], message: "math.plot_one_symbol" },
    ]);
    expect(issues({ plot: "target" })).toEqual([]);
  });

  it("bounds the knobs", () => {
    expect(issues({ tolerance: 0 })).toHaveLength(1);
    expect(issues({ samples: 2 })).toHaveLength(1);
    expect(issues({ maxLength: 5 })).toHaveLength(1);
    expect(issues({ answers: [] })).toHaveLength(1);
    expect(issues({ answers: [{ value: "x", points: 2 }] })).toHaveLength(1);
  });

  it("names the field's rules once, for the student and the grader alike", () => {
    expect(fieldRules(SECRET_CONFIG)).toEqual({ symbols: ["R_1", "R_2"], forbidden: ["sin"], maxLength: 120 });
  });
});
