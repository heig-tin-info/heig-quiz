import { describe, expect, it } from "vitest";

import { fromCanonical, toCanonical } from "./canonical.js";
import { CodeConfig, emptyCodeConfig } from "./schema.js";
import { codeConfig } from "./test/fixtures.js";

describe("the canonical mapping", () => {
  it("round-trips a fully populated config", () => {
    const config = codeConfig();
    expect(fromCanonical(toCanonical(config))).toEqual(config);
  });

  it("round-trips a draft once it holds enough to be valid", () => {
    // A FRESH draft is empty and does not parse (D16); the canonical form is
    // a file format, and reading one back goes through the schema.
    const draft = { ...emptyCodeConfig(), prompt: "Do it", template: "int main(){}" };
    draft.tests = { ...draft.tests, cases: [{ ...draft.tests.cases[0]!, name: "case 1" }] };
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

  it("leaves out the defaults of a case, so the spec's three-field case reads back", () => {
    const canonical = toCanonical(codeConfig()) as {
      tests: { cases: Record<string, unknown>[] };
    };
    const plain = canonical.tests.cases[0]!;
    expect(plain).not.toHaveProperty("args");
    expect(plain).not.toHaveProperty("compareStdout");
    expect(plain).not.toHaveProperty("expectedExitCode");
    expect(canonical).not.toHaveProperty("runtime");
  });

  it("writes the cooldown only when it is not the default", () => {
    expect(toCanonical(codeConfig())).toMatchObject({ cooldown: "progressive" });
    const fixed = CodeConfig.parse({ ...codeConfig(), cooldown: "fixed" });
    expect(toCanonical(fixed)).not.toHaveProperty("cooldown");
    expect(fromCanonical(toCanonical(codeConfig()))).toEqual(codeConfig());
  });

  it("round-trips a command line, the two checks and the browser runtime", () => {
    const config = CodeConfig.parse({
      ...codeConfig(),
      runtime: "runno",
      tests: {
        mode: "io",
        cases: [
          { name: "argv", args: ["3", "a b", "x;y"], expected: "7\n", visible: true, points: 1 },
          {
            name: "exit only",
            expected: "",
            compareStdout: false,
            expectedExitCode: 2,
            points: 1,
          },
          { name: "any code", expected: "ok\n", expectedExitCode: null, points: 1 },
        ],
      },
    });
    const canonical = toCanonical(config) as {
      runtime: unknown;
      tests: { cases: Record<string, unknown>[] };
    };
    expect(canonical.runtime).toBe("runno");
    expect(canonical.tests.cases[0]).toMatchObject({ args: ["3", "a b", "x;y"] });
    expect(canonical.tests.cases[1]).toMatchObject({ compareStdout: false, expectedExitCode: 2 });
    expect(canonical.tests.cases[2]).toMatchObject({ expectedExitCode: null });
    expect(canonical.tests.cases[2]).not.toHaveProperty("compareStdout");
    expect(fromCanonical(canonical)).toEqual(config);
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
    // A file written before ADR-015 means exactly what it meant: no command
    // line, compare stdout, require exit 0, run on the backend.
    expect(config.runtime).toBe("backend");
    expect(config.cooldown).toBe("fixed");
    expect(config.tests.cases[0]).toMatchObject({
      args: [],
      compareStdout: true,
      expectedExitCode: 0,
    });
  });

  it("refuses a file it cannot validate", () => {
    expect(() => fromCanonical({ prompt: "p" })).toThrow();
    expect(() => fromCanonical(null)).toThrow();
  });
});
