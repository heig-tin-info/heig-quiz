import { describe, expect, it } from "vitest";

import { MAX_VARIABLES, Parameters, ParametersDraft } from "./parameters.js";
import { DraftPut, QuestionPatch } from "./pool.js";

const table = (rows: { name: string; expr: string; format?: string }[], condition?: string) => ({
  rows,
  ...(condition === undefined ? {} : { condition }),
});

describe("Parameters — the variables table of ADR-056", () => {
  it("accepts the ADR's table, the format defaulting to none", () => {
    const parsed = Parameters.parse(
      table(
        [
          { name: "h", expr: "randint(1, 100)", format: "int" },
          { name: "g", expr: "choice([3.71, 9.81])", format: ".2" },
          { name: "t", expr: "sqrt(2*h/g)" },
        ],
        "t > 1",
      ),
    );
    expect(parsed.rows[2]!.format).toBe("");
    expect(parsed.condition).toBe("t > 1");
  });

  it("refuses a name that shadows, a duplicate, an unknown format and an overlong expression, by path", () => {
    const result = Parameters.safeParse(
      table([
        { name: "sqrt", expr: "1" },
        { name: "a", expr: "1", format: "%" },
        { name: "a", expr: "x".repeat(301) },
      ], "y".repeat(301)),
    );
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["rows.0.name", "parameters.bad_name"],
      ["rows.1.format", "parameters.bad_format"],
      ["rows.2.name", "parameters.bad_name"],
      ["rows.2.expr", "parameters.too_long"],
      ["condition", "parameters.too_long"],
    ]);
  });

  it("caps the rows, in the draft too", () => {
    const rows = Array.from({ length: MAX_VARIABLES + 1 }, (_, i) => ({ name: `v${i}`, expr: "1" }));
    expect(ParametersDraft.safeParse(table(rows)).success).toBe(false);
    expect(ParametersDraft.safeParse(table(rows.slice(1))).success).toBe(true);
  });

  it("lets a draft store a half-typed row (D16), which the strict schema refuses", () => {
    const halfTyped = table([{ name: "1x", expr: "randint(", format: "?" }]);
    expect(ParametersDraft.safeParse(halfTyped).success).toBe(true);
    expect(Parameters.safeParse(halfTyped).success).toBe(false);
  });

  it("travels on the draft's autosave, absent or null, and is no longer a patchable flag", () => {
    expect(DraftPut.parse({ config: {} }).variables).toBeUndefined();
    expect(DraftPut.parse({ config: {}, variables: null }).variables).toBeNull();
    expect(DraftPut.parse({ config: {}, variables: table([{ name: "x", expr: "1" }]) }).variables?.rows).toHaveLength(1);
    // `randomizable` is derived at publication (ADR-056 §1): an unknown key is dropped.
    expect(QuestionPatch.parse({ randomizable: true, difficulty: 2 })).toEqual({ difficulty: 2 });
  });
});
