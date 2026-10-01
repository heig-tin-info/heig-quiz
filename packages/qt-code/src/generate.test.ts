import { describe, expect, it } from "vitest";

import type { RunnerHealth, RunnerOutcome, RunnerRequest, RunnerService } from "@quiz/core/server";

import { codeGenerator, mergeCode, mergeReference, settleCode } from "./generate.js";
import { codeimageGenerator, settleCodeImage } from "./image/generate.js";
import { emptyCodeImageConfig } from "./image/schema.js";
import { emptyCodeCase, emptyCodeConfig, type CodeConfig } from "./schema.js";

/** A runner that answers what it is given, and records the requests. */
class ScriptedRunner implements RunnerService {
  readonly requests: RunnerRequest[] = [];
  constructor(private readonly answer: (req: RunnerRequest) => RunnerOutcome) {}
  run(req: RunnerRequest) {
    this.requests.push(req);
    return Promise.resolve(this.answer(req));
  }
  health(): Promise<RunnerHealth> {
    return Promise.resolve({ ok: true, languages: [], queued: 0, avgMs: null });
  }
}

const run = (stdout: string, extra: Partial<RunnerOutcome["cases"][number]> = {}) => ({
  exitCode: 0,
  stdout,
  stderr: "",
  ms: 1,
  timedOut: false,
  oom: false,
  truncated: false,
  ...extra,
});
const compiled = (cases: RunnerOutcome["cases"]): RunnerOutcome => ({
  compile: { ok: true, stdout: "", stderr: "", ms: 1 },
  cases,
});

const draft = (patch: Partial<CodeConfig> = {}): CodeConfig => ({ ...emptyCodeConfig(), prompt: "Sum", ...patch });

describe("mergeReference", () => {
  it("writes the reference only when empty, and only when it fits the template's regions", () => {
    expect(mergeReference(draft(), "int main(){}").referenceSolution).toBe("int main(){}");
    expect(mergeReference(draft({ referenceSolution: "mine" }), "theirs").referenceSolution).toBe("mine");
    // A locked template with ONE editable region: two pieces do not fit.
    const locked = draft({ template: "// @@lock\nint x;\n// @@endlock\nint f(){}\n" });
    expect(mergeReference(locked, "a\n// @@next\nb").referenceSolution).toBe("");
    expect(mergeReference(locked, "int f(){ return 1; }").referenceSolution).toBe("int f(){ return 1; }");
  });
});

describe("mergeCode", () => {
  it("replaces the empty placeholder with the proposed cases, outputs left to the runner", () => {
    const merged = mergeCode(draft(), {
      referenceSolution: "ref",
      cases: [
        { name: "small", stdin: "1 2", args: [], visible: true },
        { name: "negative", stdin: "-1 1", args: ["-v"], visible: false },
        { name: "SMALL", stdin: "dup", args: [], visible: true },
      ],
    });
    expect(merged.referenceSolution).toBe("ref");
    expect(merged.tests.cases).toEqual([
      emptyCodeCase({ name: "small", stdin: "1 2", visible: true }),
      emptyCodeCase({ name: "negative", stdin: "-1 1", args: ["-v"], visible: false }),
    ]);
  });

  it("keeps the teacher's cases and adds none that repeats their names", () => {
    const mine = emptyCodeCase({ name: "mine", stdin: "5", expected: "5\n" });
    const merged = mergeCode(draft({ tests: { ...draft().tests, cases: [mine] } }), {
      referenceSolution: "",
      cases: [{ name: "Mine", stdin: "6", args: [], visible: false }],
    });
    expect(merged.tests.cases).toEqual([mine]);
  });
});

describe("settleCode", () => {
  const withCases = draft({
    referenceSolution: "ref",
    tests: {
      ...draft().tests,
      cases: [
        emptyCodeCase({ name: "known", stdin: "0", expected: "0\n" }),
        emptyCodeCase({ name: "a", stdin: "1 2" }),
        emptyCodeCase({ name: "b", stdin: "x" }),
        emptyCodeCase({ name: "slow", stdin: "9" }),
      ],
    },
  });

  it("runs the reference on the cases without an output, and writes what it printed", async () => {
    const runner = new ScriptedRunner(() =>
      compiled([run("3\n"), run("", { exitCode: 2 }), run("", { timedOut: true })]),
    );
    const { config, incomplete } = await settleCode(withCases, runner);
    // The slow case timed out: its output stays empty, and the result says so.
    expect(incomplete).toBe("partial");
    expect(runner.requests[0]!.cases.map((c) => c.name)).toEqual(["a", "b", "slow"]);
    expect(config.tests.cases.map((c) => [c.name, c.expected, c.expectedExitCode])).toEqual([
      ["known", "0\n", 0],
      ["a", "3\n", 0],
      ["b", "", 2],
      ["slow", "", 0],
    ]);
  });

  it("says when the reference does not compile, and asks nothing without a reference", async () => {
    const failing = new ScriptedRunner(() => ({ compile: { ok: false, stdout: "", stderr: "e", ms: 1 }, cases: [] }));
    expect((await settleCode(withCases, failing)).incomplete).toBe("compile_failed");
    const idle = new ScriptedRunner(() => compiled([]));
    await settleCode(draft(), idle);
    expect(idle.requests).toHaveLength(0);
  });
});

describe("settleCodeImage", () => {
  const image = { ...emptyCodeImageConfig(), prompt: "A square", referenceSolution: "ref", image: { width: 3, height: 3, palette: "bw" as const } };

  it("makes the picture the reference draws the target", async () => {
    const runner = new ScriptedRunner(() => compiled([run("1 1 1\n1 0 1\n1 1 1\n")]));
    const { config } = await settleCodeImage(image, runner);
    expect(config.target).toEqual({ width: 3, height: 3, palette: "bw", pixels: "111101111" });
  });

  it("keeps a target the teacher chose, and makes none of a picture with a missing pixel", async () => {
    const runner = new ScriptedRunner(() => compiled([run("1 1 1")]));
    const missing = await settleCodeImage(image, runner);
    expect(missing.config.target).toBeNull();
    expect(missing.incomplete).toBe("partial");
    const chosen = { ...image, target: { width: 3, height: 3, palette: "bw" as const, pixels: "000000000" } };
    expect((await settleCodeImage(chosen, runner)).config).toBe(chosen);
  });
});

describe("the generators", () => {
  it("read the statement", () => {
    expect(codeGenerator.statement(draft())).toBe("Sum");
    expect(codeimageGenerator.statement({} as never)).toBe("");
  });
});
