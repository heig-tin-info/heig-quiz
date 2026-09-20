import { describe, expect, it } from "vitest";
import { RunnerLanguage, RunnerOutcome, RunnerRequest } from "./runner.js";

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
