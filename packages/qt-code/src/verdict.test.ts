/**
 * `caseVerdict`, the one "did this case pass?" rule (audit R-06): every
 * failure, in the order a person debugs in, and the defaults an older payload
 * relies on.
 */
import { describe, expect, it } from "vitest";

import { caseVerdict, type CaseRun } from "./verdict.js";

const run = (over: Partial<CaseRun> = {}): CaseRun => ({
  exitCode: 0,
  stdout: "6\n",
  timedOut: false,
  oom: false,
  ms: 5,
  ...over,
});
const spec = { expected: "6\n", compareStdout: true, expectedExitCode: 0 };

describe("caseVerdict", () => {
  it("passes a run that meets both checks", () => {
    expect(caseVerdict(spec, run(), undefined)).toEqual({ ok: true, failure: null });
  });

  it("names each failure, accidents first", () => {
    expect(caseVerdict(spec, undefined, undefined).failure).toBe("not_run");
    // A timeout wins over everything the run printed or returned.
    expect(caseVerdict(spec, run({ timedOut: true, oom: true, exitCode: null }), undefined).failure).toBe(
      "timed_out",
    );
    expect(caseVerdict(spec, run({ oom: true, exitCode: null }), undefined).failure).toBe("oom");
    expect(caseVerdict(spec, run({ exitCode: null }), undefined).failure).toBe("crashed");
    expect(caseVerdict(spec, run({ exitCode: 1 }), undefined).failure).toBe("exit");
    expect(caseVerdict(spec, run({ stdout: "7\n" }), undefined).failure).toBe("output");
  });

  it("times a case out on its own budget when the caller knows it", () => {
    expect(caseVerdict(spec, run({ ms: 300 }), undefined, 200).failure).toBe("timed_out");
    expect(caseVerdict(spec, run({ ms: 300 }), undefined).ok).toBe(true);
  });

  it("keeps the two checks independent and optional", () => {
    const exitOnly = { expected: "ignored", compareStdout: false, expectedExitCode: 2 };
    expect(caseVerdict(exitOnly, run({ exitCode: 2, stdout: "anything" }), undefined).ok).toBe(true);
    const anyExit = { expected: "6\n", compareStdout: true, expectedExitCode: null };
    expect(caseVerdict(anyExit, run({ exitCode: 3 }), undefined).ok).toBe(true);
    // Any exit code — but a killed process has none, and that is a crash.
    expect(caseVerdict(anyExit, run({ exitCode: null }), undefined).failure).toBe("crashed");
  });

  it("reads an older payload as 'exit 0 and the output matches'", () => {
    expect(caseVerdict({ expected: "6\n" }, run({ exitCode: 1 }), undefined).failure).toBe("exit");
    expect(caseVerdict({ expected: "6\n" }, run({ stdout: "x" }), undefined).failure).toBe("output");
  });

  it("applies the teacher's comparison options", () => {
    const upper = { ...spec, expected: "HELLO\n" };
    expect(caseVerdict(upper, run({ stdout: "hello\n" }), undefined).failure).toBe("output");
    expect(caseVerdict(upper, run({ stdout: "hello\n" }), { ignoreCase: true }).ok).toBe(true);
    const pi = { ...spec, expected: "3.14159\n" };
    expect(caseVerdict(pi, run({ stdout: "3.1416\n" }), undefined).failure).toBe("output");
    expect(caseVerdict(pi, run({ stdout: "3.1416\n" }), { numeric: { epsilon: 0.001, mode: "abs" } }).ok).toBe(
      true,
    );
  });
});
