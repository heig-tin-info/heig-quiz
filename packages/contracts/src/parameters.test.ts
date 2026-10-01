import { describe, expect, it } from "vitest";

import { MAX_VARIABLES, ParametersDraft } from "./parameters.js";
import { DraftPut, QuestionPatch } from "./pool.js";

const table = (rows: { name: string; expr: string; format?: string }[], condition?: string) => ({
  rows,
  ...(condition === undefined ? {} : { condition }),
});

describe("ParametersDraft — the variables table of ADR-056", () => {
  it("accepts the ADR's table, the format defaulting to none", () => {
    const parsed = ParametersDraft.parse(
      table(
        [
          { name: "h", expr: "randint(1, 100)", format: "int" },
          { name: "t", expr: "sqrt(2*h/9.81)" },
        ],
        "t > 1",
      ),
    );
    expect(parsed.rows[1]!.format).toBe("");
    expect(parsed.condition).toBe("t > 1");
  });

  it("stores a half-typed row (D16): its rules are the domain's, at publication", () => {
    expect(ParametersDraft.safeParse(table([{ name: "1x", expr: "randint(", format: "?" }])).success).toBe(true);
  });

  it("caps the rows and the texts", () => {
    const rows = Array.from({ length: MAX_VARIABLES + 1 }, (_, i) => ({ name: `v${i}`, expr: "1" }));
    expect(ParametersDraft.safeParse(table(rows)).success).toBe(false);
    expect(ParametersDraft.safeParse(table(rows.slice(1))).success).toBe(true);
    expect(ParametersDraft.safeParse(table([{ name: "x", expr: "1".repeat(1001) }])).success).toBe(false);
  });

  it("travels on the draft's autosave, absent or null, and is no longer a patchable flag", () => {
    expect(DraftPut.parse({ config: {} }).variables).toBeUndefined();
    expect(DraftPut.parse({ config: {}, variables: null }).variables).toBeNull();
    expect(DraftPut.parse({ config: {}, variables: table([{ name: "x", expr: "1" }]) }).variables?.rows).toHaveLength(1);
    // `randomizable` is derived at publication (ADR-056 §1): an unknown key is dropped.
    expect(QuestionPatch.parse({ randomizable: true, difficulty: 2 })).toEqual({ difficulty: 2 });
  });
});
