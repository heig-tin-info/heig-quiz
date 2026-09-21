import { describe, expect, it } from "vitest";

import { ConfigMigrationError } from "@quiz/core/server";

import {
  CodeAnswer,
  CodeConfig,
  CODE_CONFIG_VERSION,
  RUNNO_LANGUAGES,
  caseTimeMs,
  emptyCodeCase,
  emptyCodeConfig,
  totalCasePoints,
} from "./schema.js";
import { codeServer } from "./server.js";
import { codeConfig } from "./test/fixtures.js";

describe("CodeConfig", () => {
  it("accepts the reference configuration of the plan", () => {
    const config = codeConfig();
    expect(config.language).toBe("c");
    expect(config.tests.cases).toHaveLength(3);
    expect(totalCasePoints(config)).toBe(4);
  });

  it("fills every default, so a minimal config is complete", () => {
    const config = CodeConfig.parse({
      configVersion: 1,
      prompt: "p",
      language: "python",
      tests: { mode: "io", cases: [{ name: "c", expected: "1" }] },
    });
    expect(config.template).toBe("");
    expect(config.files).toEqual([]);
    expect(config.action).toBe("run");
    expect(config.limits).toEqual({ timeMs: 2000, memoryMb: 128, outputKb: 64 });
    expect(config.runsPerMinute).toBe(10);
    expect(config.allOrNothing).toBe(false);
    expect(config.referenceSolution).toBe("");
    expect(config.tests.compare).toEqual({ trimTrailing: true, ignoreCase: false, numeric: null });
    expect(config.tests.cases[0]).toMatchObject({ stdin: "", visible: false, points: 1, timeMs: null });
    // The fields added with ADR-015, every one of them with a default — which
    // is why `CODE_CONFIG_VERSION` did not move.
    expect(config.runtime).toBe("backend");
    expect(config.tests.cases[0]).toMatchObject({
      args: [],
      compareStdout: true,
      expectedExitCode: 0,
    });
    expect(CODE_CONFIG_VERSION).toBe(1);
  });

  it("takes a command line, one argv entry per element", () => {
    const config = CodeConfig.parse({
      configVersion: 1,
      prompt: "p",
      language: "python",
      tests: { mode: "io", cases: [{ name: "c", args: ["3", "a b", "x;y"], expected: "" }] },
    });
    // A space or a `;` is a character of the argument: nothing splits it.
    expect(config.tests.cases[0]?.args).toEqual(["3", "a b", "x;y"]);
  });

  it("takes the two checks independently, and refuses a case that checks nothing", () => {
    const of = (testCase: Record<string, unknown>): unknown => ({
      configVersion: 1,
      prompt: "p",
      language: "c",
      tests: { mode: "io", cases: [{ name: "c", expected: "", ...testCase }] },
    });
    // Exit code only.
    expect(CodeConfig.safeParse(of({ compareStdout: false, expectedExitCode: 3 })).success).toBe(
      true,
    );
    // Stdout only: any exit code is accepted.
    expect(CodeConfig.safeParse(of({ expectedExitCode: null })).success).toBe(true);
    // Neither: the case would pass whatever the program printed and returned.
    const nothing = CodeConfig.safeParse(of({ compareStdout: false, expectedExitCode: null }));
    expect(nothing.success).toBe(false);
    expect(JSON.stringify(nothing.error?.issues)).toContain("code.case_checks_nothing");
    // Out of the range of a process exit status.
    expect(CodeConfig.safeParse(of({ expectedExitCode: 256 })).success).toBe(false);
    expect(CodeConfig.safeParse(of({ expectedExitCode: -1 })).success).toBe(false);
  });

  it("names the languages the browser runtime can serve", () => {
    expect([...RUNNO_LANGUAGES]).toEqual(["c", "python"]);
    expect(CodeConfig.safeParse({ ...codeConfig(), runtime: "runno" }).success).toBe(true);
    expect(CodeConfig.safeParse({ ...codeConfig(), runtime: "browser" }).success).toBe(false);
  });

  it("spells out every default of a fresh case", () => {
    expect(emptyCodeCase()).toEqual({
      name: "",
      args: [],
      stdin: "",
      expected: "",
      compareStdout: true,
      expectedExitCode: 0,
      visible: false,
      points: 1,
      timeMs: null,
    });
    expect(emptyCodeCase({ visible: true }).visible).toBe(true);
  });

  it("rejects what a runner could not honour", () => {
    const base = codeConfig();
    const cases: Array<[string, unknown]> = [
      ["no version", { ...base, configVersion: 2 }],
      ["empty prompt", { ...base, prompt: "" }],
      ["unknown language", { ...base, language: "cobol" }],
      ["no case at all", { ...base, tests: { ...base.tests, cases: [] } }],
      ["tap mode (phase 3)", { ...base, tests: { ...base.tests, mode: "tap" } }],
      ["negative points", { ...base, tests: { ...base.tests, cases: [{ name: "x", expected: "", points: -1 }] } }],
      ["a time limit below the floor", { ...base, limits: { ...base.limits, timeMs: 10 } }],
      ["a memory limit above the ceiling", { ...base, limits: { ...base.limits, memoryMb: 4096 } }],
      ["a file name with a slash", { ...base, files: [{ name: "../etc/passwd", content: "" }] }],
      ["an unnamed case", { ...base, tests: { ...base.tests, cases: [{ name: "", expected: "" }] } }],
      ["31 cases", { ...base, tests: { ...base.tests, cases: Array.from({ length: 31 }, (_, i) => ({ name: `c${i}`, expected: "" })) } }],
    ];
    for (const [why, value] of cases) {
      expect(CodeConfig.safeParse(value).success, why).toBe(false);
    }
  });

  it("takes a per-case time budget, and falls back to the question's", () => {
    const config = CodeConfig.parse({
      ...codeConfig(),
      tests: {
        mode: "io",
        cases: [
          { name: "slow", expected: "", timeMs: 8000 },
          { name: "normal", expected: "" },
        ],
      },
    });
    expect(caseTimeMs(config, config.tests.cases[0]!)).toBe(8000);
    expect(caseTimeMs(config, config.tests.cases[1]!)).toBe(config.limits.timeMs);
  });
});

describe("CodeAnswer", () => {
  it("accepts regions alone and a run summary", () => {
    expect(CodeAnswer.parse({ regions: ["a", "b"] }).regions).toEqual(["a", "b"]);
    const withRun = CodeAnswer.parse({
      regions: [],
      lastRun: {
        at: "2026-09-20T10:00:00.000Z",
        requestId: "6f1d0b8a-6b8a-4a6a-9f2a-2b5f0b7b9a11",
        compileOk: true,
        passed: 1,
        total: 2,
      },
    });
    expect(withRun.lastRun?.passed).toBe(1);
  });

  it("rejects a malformed run summary and an oversized region set", () => {
    expect(CodeAnswer.safeParse({ regions: ["a"], lastRun: { at: "yesterday" } }).success).toBe(false);
    expect(CodeAnswer.safeParse({ regions: Array.from({ length: 21 }, () => "") }).success).toBe(false);
  });
});

describe("the draft and the migration", () => {
  it("emits an EMPTY draft, stored as it stands (D16)", () => {
    const draft = emptyCodeConfig();
    expect(draft.prompt).toBe("");
    expect(draft.template).toBe("");
    expect(draft.language).toBe("c");
    expect(draft.runtime).toBe("backend");
    expect(CodeConfig.safeParse(draft).success).toBe(false);
    expect(codeServer.emptyDraft()).toEqual(draft);
  });

  it("stamps an older config with the current version", () => {
    const { configVersion: _dropped, ...v0 } = codeConfig();
    expect(codeServer.migrate(v0, 0).configVersion).toBe(codeServer.configVersion);
  });

  it("refuses a config from the future and an unrepairable one", () => {
    expect(() => codeServer.migrate(codeConfig(), 99)).toThrow(ConfigMigrationError);
    expect(() => codeServer.migrate({ prompt: "" }, 0)).toThrow(ConfigMigrationError);
  });

  it("returns a config at the current version untouched, even an empty draft", () => {
    const draft = codeServer.emptyDraft();
    expect(codeServer.migrate(draft, codeServer.configVersion)).toBe(draft);
  });

  it("defaults the item points to the weight of the cases", () => {
    expect(codeServer.defaultPoints(codeConfig())).toBe(4);
    expect(codeServer.shuffleable(codeConfig())).toBe(false);
  });

  it("indexes the prompt, the language and the case names", () => {
    const text = codeServer.searchText(codeConfig());
    expect(text).toContain("Sum the integers");
    expect(text).toContain("three items");
  });
});
