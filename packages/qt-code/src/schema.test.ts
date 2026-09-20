import { describe, expect, it } from "vitest";

import { ConfigMigrationError } from "@quiz/core/server";

import { CodeAnswer, CodeConfig, caseTimeMs, emptyCodeConfig, totalCasePoints } from "./schema.js";
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
  it("emits a draft that its own schema accepts", () => {
    expect(CodeConfig.safeParse(emptyCodeConfig()).success).toBe(true);
    expect(CodeConfig.safeParse(codeServer.emptyDraft()).success).toBe(true);
  });

  it("stamps an older config with the current version", () => {
    const { configVersion: _dropped, ...v0 } = codeConfig();
    expect(codeServer.migrate(v0, 0).configVersion).toBe(codeServer.configVersion);
  });

  it("refuses a config from the future and an unrepairable one", () => {
    expect(() => codeServer.migrate(codeConfig(), 99)).toThrow(ConfigMigrationError);
    expect(() => codeServer.migrate({ prompt: "" }, 1)).toThrow(ConfigMigrationError);
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
