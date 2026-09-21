import { describe, expect, it } from "vitest";

import { isGraded, isPendingRunner, type GradeContext, type RunnerOutcome } from "@quiz/core/server";
import { regionCount, splitTemplate } from "@quiz/domain";

import {
  buildInteractiveRequest,
  finalizeRunnerCode,
  gradeCode,
  isEmptyAnswer,
  sha256,
  studentDetails,
} from "./grade.js";
import { CODE_LANGUAGES, CodeConfig, type CodeAnswer, type CodeConfig as Config } from "./schema.js";
import { UnavailableRunnerStub } from "./test/runner.js";
import {
  codeConfig,
  configFor,
  FINALIZE_CTX,
  outcome,
  SECRET_HIDDEN_ARG,
  SECRET_HIDDEN_EXPECTED,
  templateFor,
} from "./test/fixtures.js";

const ctx = (): GradeContext => ({ ...FINALIZE_CTX, runner: new UnavailableRunnerStub() });

/** The regions of an answer that fits `config`, filled with `body`. */
function answerFor(config: Config, body: string): CodeAnswer {
  const count = regionCount(config.template, config.language);
  return { regions: Array.from({ length: count }, () => body) };
}

describe("gradeCode", () => {
  it("returns a pending runner result carrying a server-assembled request", () => {
    const config = codeConfig();
    const answer = answerFor(config, "    int total = 1;\n");
    const result = gradeCode(config, answer, ctx());
    if (!isPendingRunner(result)) throw new Error("expected a pending runner result");

    expect(result.via).toBe("runner");
    expect(result.request.language).toBe("c");
    expect(result.request.action).toBe("run");
    expect(result.request.priority).toBe("grading");
    expect(result.request.compileArgs).toBe(config.compileArgs);
    expect(result.request.limits).toMatchObject({ memoryMb: 128, outputKb: 64 });

    // The main file is named by the language, never by the client, and the
    // teacher's extra files are injected here.
    expect(result.request.files.map((f) => f.name)).toEqual(["main.c", "data.csv"]);
    const source = result.request.files[0]!.content;
    expect(source).toContain("int sum(const int *t, int n)"); // a locked line survived
    expect(source).toContain("int total = 1;"); // the student's region is in place
    expect(source).toContain("// @@lock"); // markers are comments and stay

    // Every case is sent, with its stdin, its command line, and no expected
    // output: the runner executes, it never decides.
    expect(result.request.cases).toEqual(
      config.tests.cases.map((c) => ({ name: c.name, args: c.args, stdin: c.stdin })),
    );
    expect(JSON.stringify(result.request)).not.toContain('"expected"');
    expect(JSON.stringify(result.request)).not.toContain("compareStdout");
    expect(JSON.stringify(result.request)).not.toContain("expectedExitCode");
  });

  it("carries each case's command line into the request, verbatim", () => {
    const config = CodeConfig.parse({
      ...codeConfig(),
      tests: {
        mode: "io",
        cases: [
          { name: "plain", expected: "" },
          { name: "argv", args: ["3", "a b", 'q"x', "semi;colon"], expected: "" },
        ],
      },
    });
    const result = gradeCode(config, answerFor(config, "x"), ctx());
    if (!isPendingRunner(result)) throw new Error("expected a pending runner result");
    expect(result.request.cases[0]?.args).toEqual([]);
    expect(result.request.cases[1]?.args).toEqual(["3", "a b", 'q"x', "semi;colon"]);
  });

  it("assembles the source for every language comment style of lockedTemplate", () => {
    for (const language of CODE_LANGUAGES) {
      const config = configFor(language);
      const segments = splitTemplate(config.template, language);
      // Each fixture is locked / editable / locked: one editable region.
      expect(segments.map((s) => s.kind), language).toEqual(["locked", "editable", "locked"]);

      const result = gradeCode(config, { regions: ["MINE\n"] }, ctx());
      if (!isPendingRunner(result)) throw new Error(`expected pending for ${language}`);
      const source = result.request.files[0]!.content;
      expect(source, language).toBe(templateFor(language).replace("BODY\n", "MINE\n"));
      expect(source, language).toContain("HEADER");
      expect(source, language).toContain("FOOTER");
      expect(source, language).not.toContain("BODY");
    }
  });

  it("asks for the largest budget of the cases it sends", () => {
    const config = CodeConfig.parse({
      ...codeConfig(),
      tests: {
        mode: "io",
        cases: [
          { name: "fast", expected: "", timeMs: null },
          { name: "slow", expected: "", timeMs: 9000 },
        ],
      },
    });
    const result = gradeCode(config, answerFor(config, "x"), ctx());
    if (!isPendingRunner(result)) throw new Error("expected a pending runner result");
    expect(result.request.limits.timeMs).toBe(9000);
  });

  it("sends only the visible cases for an interactive run", () => {
    const config = codeConfig();
    const request = buildInteractiveRequest(config, answerFor(config, "x"));
    expect(request.priority).toBe("interactive");
    expect(request.cases.map((c) => c.name)).toEqual(["three items", "empty array"]);
    // The hidden case's command line stays behind with its stdin.
    expect(JSON.stringify(request.cases)).not.toContain(SECRET_HIDDEN_ARG);
  });

  it("grades an unanswered question zero, without touching the runner", () => {
    const config = codeConfig();
    expect(isEmptyAnswer(null)).toBe(true);
    expect(isEmptyAnswer({ regions: ["", "   \n"] })).toBe(true);

    for (const answer of [null, { regions: [] }, { regions: ["  ", "\n"] }]) {
      const result = gradeCode(config, answer, ctx());
      if (!isGraded(result)) throw new Error("expected a graded result");
      expect(result.points).toBe(0);
      expect(result.state).toBe("validated");
      expect(result.details.reason).toBe("empty");
      expect(result.details.sourceSha256).toBeNull();
    }
  });

  it("proposes a manual grade when the answer no longer fits the template", () => {
    const config = codeConfig();
    const result = gradeCode(config, { regions: ["only one region"] }, ctx());
    if (!isGraded(result)) throw new Error("expected a graded result");
    expect(result.points).toBe(0);
    expect(result.state).toBe("proposed");
    expect(result.comment).toBe("template_region_mismatch");
    expect(result.details.runner).toBe("error");
  });
});

describe("finalizeRunnerCode", () => {
  const config = codeConfig();
  const answer = answerFor(config, "x");
  const pass = { stdout: "6\n" };

  it("scores zero and keeps the compiler output when the build fails", () => {
    const result = finalizeRunnerCode(
      config,
      answer,
      FINALIZE_CTX,
      outcome([], { ok: false, stderr: "main.c:7: error: expected ';'" }),
    );
    expect(result.points).toBe(0);
    expect(result.state).toBe("validated");
    expect(result.details.compile?.ok).toBe(false);
    expect(result.details.compile?.stderr).toContain("expected ';'");
    expect(result.details.cases).toEqual([]);
    // The source is still hashed: the grading panel shows what was compiled.
    expect(result.details.sourceSha256).toHaveLength(64);
  });

  it("gives the whole item when every case passes", () => {
    const result = finalizeRunnerCode(
      config,
      answer,
      FINALIZE_CTX,
      outcome([pass, { stdout: "0\n" }, { stdout: SECRET_HIDDEN_EXPECTED }]),
    );
    expect(result.points).toBe(10);
    expect(result.maxPoints).toBe(10);
    expect(result.details.earned).toBe(4);
    expect(result.details.total).toBe(4);
    expect(result.details.cases.every((c) => c.ok)).toBe(true);
    expect(result.details.sourceSha256).toHaveLength(64);
  });

  it("prorates a partial pass on the item scale", () => {
    // 1 of 4 case points: 2.5 of 10.
    const result = finalizeRunnerCode(
      config,
      answer,
      FINALIZE_CTX,
      outcome([pass, { stdout: "wrong" }, { stdout: "wrong" }]),
    );
    expect(result.details.earned).toBe(1);
    expect(result.points).toBe(2.5);
    expect(result.details.cases.map((c) => c.ok)).toEqual([true, false, false]);
  });

  it("fails a case that timed out, that ran out of memory or that exited non-zero", () => {
    const result = finalizeRunnerCode(
      config,
      answer,
      FINALIZE_CTX,
      outcome([
        { stdout: "6\n", timedOut: true },
        { stdout: "0\n", oom: true },
        { stdout: "5\n", exitCode: 139 },
      ]),
    );
    expect(result.points).toBe(0);
    expect(result.details.cases.map((c) => c.ok)).toEqual([false, false, false]);
    expect(result.details.cases[0]?.timedOut).toBe(true);
    expect(result.details.cases[1]?.oom).toBe(true);
    expect(result.details.cases[2]?.exitCode).toBe(139);
  });

  it("times a case out on its own budget, which the request could not carry", () => {
    const tight = CodeConfig.parse({
      ...config,
      tests: {
        mode: "io",
        cases: [
          { name: "tight", expected: "6", visible: true, points: 1, timeMs: 200 },
          { name: "loose", expected: "6", visible: true, points: 1, timeMs: 5000 },
        ],
      },
    });
    const result = finalizeRunnerCode(
      tight,
      answerFor(tight, "x"),
      FINALIZE_CTX,
      outcome([
        { stdout: "6", ms: 900 },
        { stdout: "6", ms: 900 },
      ]),
    );
    expect(result.details.cases.map((c) => c.timedOut)).toEqual([true, false]);
    expect(result.details.cases.map((c) => c.ok)).toEqual([false, true]);
  });

  it("fails a case the runner did not report at all", () => {
    const result = finalizeRunnerCode(config, answer, FINALIZE_CTX, outcome([pass]));
    expect(result.details.cases).toHaveLength(3);
    expect(result.details.cases[1]).toMatchObject({ ok: false, exitCode: null, ms: 0 });
  });

  it("applies the comparison options of the config", () => {
    const loose = CodeConfig.parse({
      ...config,
      tests: {
        mode: "io",
        compare: { trimTrailing: true, ignoreCase: true, numeric: { epsilon: 0.01, mode: "abs" } },
        cases: [{ name: "pi", expected: "3.14", visible: true, points: 1 }],
      },
    });
    const result = finalizeRunnerCode(
      loose,
      answerFor(loose, "x"),
      FINALIZE_CTX,
      outcome([{ stdout: "3.141  \n" }]),
    );
    expect(result.details.cases[0]?.ok).toBe(true);
  });

  it("gives all or nothing when the teacher asked for it", () => {
    const strict = CodeConfig.parse({ ...config, allOrNothing: true });
    const partial = finalizeRunnerCode(
      strict,
      answer,
      FINALIZE_CTX,
      outcome([{ stdout: "6\n" }, { stdout: "0\n" }, { stdout: "nope" }]),
    );
    expect(partial.details.earned).toBe(2);
    expect(partial.points).toBe(0);

    const complete = finalizeRunnerCode(
      strict,
      answer,
      FINALIZE_CTX,
      outcome([{ stdout: "6\n" }, { stdout: "0\n" }, { stdout: SECRET_HIDDEN_EXPECTED }]),
    );
    expect(complete.points).toBe(10);
  });
});

/**
 * The rule of ONE case, branch by branch (ADR-015). Two independent checks,
 * each one optional, on top of the accidents that fail a case whatever it
 * checks.
 */
describe("the verdict of a case", () => {
  /** A one-case config, with the case's checks spelled out. */
  const only = (testCase: Record<string, unknown>): Config =>
    CodeConfig.parse({
      ...codeConfig(),
      files: [],
      tests: {
        mode: "io",
        compare: { trimTrailing: true, ignoreCase: false, numeric: null },
        cases: [{ name: "c", expected: "42\n", visible: true, points: 1, ...testCase }],
      },
    });

  const verdict = (config: Config, run: Partial<RunnerOutcome["cases"][number]>): boolean =>
    finalizeRunnerCode(config, answerFor(config, "x"), FINALIZE_CTX, outcome([run]))
      .details.cases[0]!.ok;

  it("compares stdout and requires exit 0, by default", () => {
    const config = only({});
    expect(verdict(config, { stdout: "42\n", exitCode: 0 })).toBe(true);
    expect(verdict(config, { stdout: "41\n", exitCode: 0 })).toBe(false);
    expect(verdict(config, { stdout: "42\n", exitCode: 1 })).toBe(false);
  });

  it("checks the exit code alone when stdout is not compared", () => {
    const config = only({ compareStdout: false, expectedExitCode: 2 });
    expect(verdict(config, { stdout: "anything at all", exitCode: 2 })).toBe(true);
    expect(verdict(config, { stdout: "42\n", exitCode: 0 })).toBe(false);
    // Nothing is compared, so nothing is stored to compare against either.
    const details = finalizeRunnerCode(
      config,
      answerFor(config, "x"),
      FINALIZE_CTX,
      outcome([{ stdout: "x", exitCode: 2 }]),
    ).details;
    expect(details.cases[0]?.expected).toBeUndefined();
  });

  it("accepts any exit code when the teacher asked for none", () => {
    const config = only({ expectedExitCode: null });
    expect(verdict(config, { stdout: "42\n", exitCode: 0 })).toBe(true);
    expect(verdict(config, { stdout: "42\n", exitCode: 3 })).toBe(true);
    expect(verdict(config, { stdout: "42\n", exitCode: 255 })).toBe(true);
    // The output still has to match: the other check is still enabled.
    expect(verdict(config, { stdout: "nope", exitCode: 0 })).toBe(false);
  });

  it("fails on an accident whatever the case checks", () => {
    for (const config of [only({}), only({ compareStdout: false, expectedExitCode: 0 })]) {
      expect(verdict(config, { stdout: "42\n", exitCode: 0, timedOut: true })).toBe(false);
      expect(verdict(config, { stdout: "42\n", exitCode: 0, oom: true })).toBe(false);
      // No exit code of its own: the service killed it, or it never ran.
      expect(verdict(config, { stdout: "42\n", exitCode: null })).toBe(false);
    }
  });

  it("fails a crash even when the case accepts any exit code", () => {
    const config = only({ expectedExitCode: null });
    expect(verdict(config, { stdout: "42\n", exitCode: null, timedOut: true })).toBe(false);
    expect(verdict(config, { stdout: "42\n", exitCode: null })).toBe(false);
  });

  it("scores an exit-code-only case on the item scale like any other", () => {
    const config = CodeConfig.parse({
      ...codeConfig(),
      files: [],
      tests: {
        mode: "io",
        cases: [
          { name: "prints", expected: "ok\n", visible: true, points: 1 },
          {
            name: "refuses",
            args: ["--bad"],
            expected: "",
            compareStdout: false,
            expectedExitCode: 1,
            visible: false,
            points: 3,
          },
        ],
      },
    });
    const result = finalizeRunnerCode(
      config,
      answerFor(config, "x"),
      FINALIZE_CTX,
      outcome([{ stdout: "ok\n" }, { stdout: "usage: …", exitCode: 1 }]),
    );
    expect(result.details.cases.map((c) => c.ok)).toEqual([true, true]);
    expect(result.details.earned).toBe(4);
    expect(result.points).toBe(10);
  });
});

describe("studentDetails", () => {
  const config = codeConfig();
  const details = finalizeRunnerCode(
    config,
    answerFor(config, "x"),
    FINALIZE_CTX,
    outcome([{ stdout: "6\n" }, { stdout: "0\n" }, { stdout: SECRET_HIDDEN_EXPECTED }]),
  ).details;

  it("keeps the verdict of a hidden case but closes everything else", () => {
    const shown = studentDetails(details);
    const hidden = shown.cases[2]!;
    expect(hidden.ok).toBe(true);
    expect(hidden.points).toBe(2);
    expect(hidden.name).toBe("#3");
    expect(hidden.expected).toBeUndefined();
    expect(hidden.actual).toBeUndefined();
    expect(JSON.stringify(shown)).not.toContain("negative-values");
  });

  it("names the hidden cases when the feedback policy allows it", () => {
    const shown = studentDetails(details, { showHiddenCaseNames: true });
    expect(shown.cases[2]?.name).toBe("negative-values");
    expect(shown.cases[2]?.expected).toBeUndefined();
  });

  it("leaves the visible cases untouched", () => {
    expect(studentDetails(details).cases[0]).toEqual(details.cases[0]);
  });
});
