/** `codeServer.aggregate`: the case pass rate of the class debrief (F-RES-03, audit B-15). */
import { describe, expect, it } from "vitest";

import type { CodeCaseDetail, CodeDetails } from "./schema.js";
import { codeServer } from "./server.js";

const verdict = (name: string, ok: boolean): CodeCaseDetail => ({
  name,
  visible: true,
  points: 1,
  ok,
  exitCode: 0,
  ms: 1,
  timedOut: false,
  oom: false,
});

const details = (...cases: CodeCaseDetail[]): CodeDetails => ({
  runner: "ok",
  compile: null,
  cases,
  earned: 0,
  total: 0,
  sourceSha256: null,
});

describe("aggregate", () => {
  it("counts the attempts that passed each named case, skipping a manual override", () => {
    const stats = codeServer.aggregate!({
      answers: [{ regions: ["int main(){}"] }],
      details: [
        details(verdict("sum", true), verdict("edge", false)),
        details(verdict("sum", true), verdict("edge", true)),
        { manual: true },
      ],
    });
    expect(stats).toEqual({
      casePassRate: [
        { name: "sum", label: "sum", passed: 2, total: 2 },
        { name: "edge", label: "edge", passed: 1, total: 2 },
      ],
    });
  });

  it("labels a hidden case as a student reads it, unless the policy opens the names", () => {
    const hidden = { ...verdict("overflow", false), visible: false };
    const labels = (showHiddenCaseNames: boolean) =>
      codeServer.aggregate!({
        answers: [],
        details: [details(verdict("sum", true), hidden)],
        showHiddenCaseNames,
      }).casePassRate!.map((c) => c.label);
    expect(labels(false)).toEqual(["sum", "#2"]);
    expect(labels(true)).toEqual(["sum", "overflow"]);
  });
});
