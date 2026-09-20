import { describe, expect, it } from "vitest";

import { fromCanonical, toCanonical } from "./canonical.js";
import { CodeConfig, emptyCodeConfig } from "./schema.js";
import { codeConfig } from "./test/fixtures.js";

describe("the canonical mapping", () => {
  it("round-trips a fully populated config", () => {
    const config = codeConfig();
    expect(fromCanonical(toCanonical(config))).toEqual(config);
  });

  it("round-trips a fresh draft", () => {
    const draft = emptyCodeConfig();
    expect(fromCanonical(toCanonical(draft))).toEqual(draft);
  });

  it("leaves out what the schema rebuilds, so the file stays readable", () => {
    const canonical = toCanonical(emptyCodeConfig());
    expect(canonical).not.toHaveProperty("configVersion");
    expect(canonical).not.toHaveProperty("compileArgs");
    expect(canonical).not.toHaveProperty("limits");
    expect(canonical).not.toHaveProperty("allOrNothing");
    expect(canonical).not.toHaveProperty("files");
    expect(canonical).not.toHaveProperty("referenceSolution");
    expect(canonical.tests).not.toHaveProperty("compare");
  });

  it("writes what a teacher changed", () => {
    const canonical = toCanonical(
      CodeConfig.parse({
        ...codeConfig(),
        allOrNothing: true,
        tests: {
          mode: "io",
          compare: { trimTrailing: false, ignoreCase: true, numeric: null },
          cases: [{ name: "c", expected: "1", timeMs: 500 }],
        },
      }),
    );
    expect(canonical.allOrNothing).toBe(true);
    expect(canonical.compileArgs).toBe("-Wall -Wextra -std=c17 -DSECRET_FLAG");
    expect(canonical.tests).toMatchObject({
      compare: { trimTrailing: false, ignoreCase: true, numeric: null },
      cases: [{ name: "c", expected: "1", timeMs: 500 }],
    });
  });

  it("accepts the YAML of docs/spec/04 §4.7, defaults and all", () => {
    const config = fromCanonical({
      prompt: "Sum the array read on stdin.",
      language: "c",
      template: "int main(void) {}\n",
      compileArgs: "-Wall",
      tests: {
        mode: "io",
        cases: [{ name: "simple case", stdin: "3 4\n", expected: "7\n", visible: true, points: 1 }],
      },
    });
    expect(config.configVersion).toBe(1);
    expect(config.limits.timeMs).toBe(2000);
    expect(config.tests.cases[0]?.timeMs).toBeNull();
  });

  it("refuses a file it cannot validate", () => {
    expect(() => fromCanonical({ prompt: "p" })).toThrow();
    expect(() => fromCanonical(null)).toThrow();
  });
});
