import { describe, expect, it } from "vitest";
import { RUNNER_BUDGET_DEFAULTS, RunnerLanguage, RunnerOutcome, RunnerRequest, requestBudgetMs } from "./runner.js";

const minimal = {
  language: "c",
  files: [{ name: "main.c", content: "int main(void){return 0;}" }],
  action: "run",
  limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
  cases: [],
};

describe("RunnerRequest", () => {
  it("applies the documented defaults", () => {
    const parsed = RunnerRequest.parse(minimal);
    expect(parsed.compileArgs).toBe("");
    expect(parsed.priority).toBe("grading");
  });

  it("refuses an unknown language and an empty file list", () => {
    expect(RunnerLanguage.safeParse("cobol").success).toBe(false);
    expect(RunnerRequest.safeParse({ ...minimal, files: [] }).success).toBe(false);
  });

  it("enforces the limit bounds", () => {
    expect(RunnerRequest.safeParse({ ...minimal, limits: { timeMs: 50, memoryMb: 128, outputKb: 64 } }).success).toBe(false);
    expect(RunnerRequest.safeParse({ ...minimal, limits: { timeMs: 2000, memoryMb: 1024, outputKb: 64 } }).success).toBe(false);
  });

  it("caps the number of cases at 50", () => {
    const cases = Array.from({ length: 51 }, (_, i) => ({ name: `c${i}`, stdin: "" }));
    expect(RunnerRequest.safeParse({ ...minimal, cases }).success).toBe(false);
  });
});

describe("requestBudgetMs (ADR-101)", () => {
  const cases = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, args: [], stdin: "" }));
  const request = (n: number, extra: Partial<RunnerRequest> = {}) =>
    RunnerRequest.parse({ ...minimal, cases: cases(n), ...extra });

  it("is the build, each case at its budget plus the grace, and the uploads", () => {
    // 20 s of build, 15 × (2 s + 2 s), (1 file + 2) × 2 s.
    expect(requestBudgetMs(request(15))).toBe(20_000 + 15 * 4_000 + 3 * 2_000);
  });

  it("counts no case for a check, and clamps a case to the ceiling", () => {
    expect(requestBudgetMs(request(15, { action: "check" }))).toBe(20_000 + 3 * 2_000);
    const lowered = { ...RUNNER_BUDGET_DEFAULTS, maxTimeMs: 500 };
    expect(requestBudgetMs(request(2), lowered)).toBe(20_000 + 2 * 2_500 + 3 * 2_000);
  });

  it("is capped by the request ceiling, then by the request's own budget", () => {
    expect(requestBudgetMs(request(50))).toBe(RUNNER_BUDGET_DEFAULTS.requestTimeoutMs);
    expect(requestBudgetMs(request(15, { budgetMs: 30_000 }))).toBe(30_000);
    // A budget above the formula changes nothing.
    expect(requestBudgetMs(request(1, { budgetMs: 600_000 }))).toBe(20_000 + 4_000 + 6_000);
  });

  it("is optional on the wire, for a runner and an API deployed apart", () => {
    expect(RunnerRequest.parse(minimal).budgetMs).toBeUndefined();
    expect(RunnerRequest.safeParse({ ...minimal, budgetMs: 10 }).success).toBe(false);
  });
});

describe("RunnerOutcome", () => {
  it("accepts a well-formed outcome with a null exit code", () => {
    const parsed = RunnerOutcome.parse({
      compile: { ok: true, stdout: "", stderr: "", ms: 12 },
      cases: [
        { exitCode: null, stdout: "", stderr: "", ms: 2000, timedOut: true, oom: false, truncated: false },
      ],
    });
    expect(parsed.cases[0]?.timedOut).toBe(true);
  });

  it("refuses a missing compile block", () => {
    expect(RunnerOutcome.safeParse({ cases: [] }).success).toBe(false);
  });
});
