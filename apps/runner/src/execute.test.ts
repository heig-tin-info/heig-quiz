import type { RunnerRequest } from "@quiz/core/server";
import { describe, expect, it } from "vitest";

import { caseArgv, classify, containerTtlSeconds, executeRequest, prepareFiles } from "./execute.js";
import { createFakeEngine } from "./test/fakeEngine.js";
import { testConfig } from "./test/config.js";

const config = testConfig();

function request(overrides: Partial<RunnerRequest> = {}): RunnerRequest {
  return {
    language: "c",
    files: [{ name: "main.c", content: "int main(void){return 0;}" }],
    compileArgs: "",
    action: "run",
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
    cases: [
      { name: "one", args: [], stdin: "1\n" },
      { name: "two", args: [], stdin: "2\n" },
    ],
    priority: "grading",
    ...overrides,
  };
}

const deps = (engine: ReturnType<typeof createFakeEngine>) => ({
  engine,
  config,
  containerName: () => "quiz-run-test",
});

describe("prepareFiles", () => {
  it("sanitizes and never lets two files collide", () => {
    expect(
      prepareFiles([
        { name: "../main.c", content: "a" },
        { name: "main.c", content: "b" },
      ]),
    ).toEqual([
      { name: "main.c", content: "a" },
      { name: "1_main.c", content: "b" },
    ]);
  });
});

describe("containerTtlSeconds", () => {
  it("covers the build, every case and its grace, and no more", () => {
    const ttl = containerTtlSeconds(request(), config);
    // 20 s build + 2 x (2 s + 2 s grace) + 3 round trips + 5 s slack.
    expect(ttl).toBe(Math.ceil((20_000 + 2 * 4000 + 3 * 2000) / 1000) + 5);
  });

  it("stays under the ceiling of a whole request", () => {
    const many = request({
      cases: Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, args: [], stdin: "" })),
    });
    expect(containerTtlSeconds(many, config)).toBe(
      config.RUNNER_REQUEST_TIMEOUT_MS / 1000 + 5,
    );
  });

  it("ignores the cases of a `check`", () => {
    expect(containerTtlSeconds(request({ action: "check" }), config)).toBeLessThan(
      containerTtlSeconds(request(), config),
    );
  });
});

describe("caseArgv", () => {
  it("puts the case's arguments after the program, as argv entries", () => {
    expect(caseArgv(["./program"], 2, ["3", "4"])).toEqual([
      "timeout", "-s", "KILL", "2", "./program", "3", "4",
    ]);
    expect(caseArgv(["python3", "main.py"], 5, ["3", "4"])).toEqual([
      "timeout", "-s", "KILL", "5", "python3", "main.py", "3", "4",
    ]);
  });

  it("keeps a space, a quote, a `;` or a `$` inside ONE argument", () => {
    // There is no shell anywhere in this path (`languages.ts`), so these are
    // characters of an argument and never fragments of a command line.
    const nasty = ["a b", 'say "hi"', "x;rm -rf /", "$HOME", "*", "", "--flag"];
    const argv = caseArgv(["./program"], 2, nasty);
    expect(argv.slice(5)).toEqual(nasty);
    // One entry per argument: nothing was split and nothing was joined.
    expect(argv).toHaveLength(5 + nasty.length);
  });

  it("adds nothing at all when the case has no command line", () => {
    expect(caseArgv(["./program"], 2, [])).toEqual(["timeout", "-s", "KILL", "2", "./program"]);
  });
});

describe("classify", () => {
  const result = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    ms: 5,
    timedOut: false,
    truncated: false,
    containerGone: false,
  };

  it("reads a plain exit code as it is", () => {
    expect(classify({ ...result, exitCode: 3 }, 2000)).toEqual({
      timedOut: false,
      oom: false,
      exitCode: 3,
    });
  });

  it("calls a SIGKILL at the deadline a timeout, not an OOM", () => {
    expect(classify({ ...result, exitCode: 137, ms: 2010 }, 2000)).toEqual({
      timedOut: true,
      oom: false,
      exitCode: 137,
    });
  });

  it("calls a SIGKILL well before the deadline an OOM", () => {
    expect(classify({ ...result, exitCode: 137, ms: 120 }, 2000)).toEqual({
      timedOut: false,
      oom: true,
      exitCode: 137,
    });
  });

  it("treats a container that vanished as an OOM", () => {
    expect(classify({ ...result, exitCode: 255, containerGone: true, ms: 80 }, 2000)).toEqual({
      timedOut: false,
      oom: true,
      exitCode: 255,
    });
  });

  it("has no exit code to report when the service itself killed the run", () => {
    expect(classify({ ...result, exitCode: null, timedOut: true, ms: 4000 }, 2000)).toEqual({
      timedOut: true,
      oom: false,
      exitCode: null,
    });
  });
});

describe("executeRequest", () => {
  it("uploads, builds, runs each case in order and destroys the container", async () => {
    const engine = createFakeEngine((call) => {
      if (call.argv[0] === "cp") return { exitCode: 0 };
      if (call.argv[0] === "gcc") return { exitCode: 0, stderr: "warning: unused\n", ms: 120 };
      return { exitCode: 0, stdout: `got ${call.stdin.trim()}\n`, ms: 12 };
    });

    const outcome = await executeRequest(request(), deps(engine));

    expect(engine.created).toHaveLength(1);
    expect(engine.created[0]).toMatchObject({
      image: "quiz-runner-c:latest",
      memoryMb: 128,
      pidsLimit: 64,
      cpus: 1,
    });
    expect(outcome.compile).toEqual({ ok: true, stdout: "", stderr: "warning: unused\n", ms: 120 });
    expect(outcome.cases.map((c) => c.stdout)).toEqual(["got 1\n", "got 2\n"]);
    expect(outcome.cases.every((c) => !c.timedOut && !c.oom && c.exitCode === 0)).toBe(true);
    expect(engine.removed).toContain("quiz-run-test");

    // Every case is wrapped in the in-container reaper, at the request's budget.
    const runs = engine.calls.filter((call) => call.argv[0] === "timeout");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.argv).toEqual(["timeout", "-s", "KILL", "2", "./program"]);
    // ... and the service's own deadline is the budget plus the grace.
    expect(runs[0]!.timeoutMs).toBe(2000 + config.RUNNER_CASE_GRACE_MS);
  });

  it("hands each case its own command line, verbatim, one argv entry per argument", async () => {
    const engine = createFakeEngine((call) =>
      call.argv[0] === "timeout" ? { exitCode: 0, stdout: `${call.argv.length}\n` } : {},
    );
    await executeRequest(
      request({
        cases: [
          { name: "plain", args: [], stdin: "" },
          { name: "argv", args: ["3", "a b", 'q"x', "semi;colon"], stdin: "" },
        ],
      }),
      deps(engine),
    );
    const runs = engine.calls.filter((call) => call.argv[0] === "timeout");
    expect(runs[0]!.argv).toEqual(["timeout", "-s", "KILL", "2", "./program"]);
    expect(runs[1]!.argv).toEqual([
      "timeout", "-s", "KILL", "2", "./program", "3", "a b", 'q"x', "semi;colon",
    ]);
  });

  it("stops at a build failure and runs no case", async () => {
    const engine = createFakeEngine((call) =>
      call.argv[0] === "gcc" ? { exitCode: 1, stderr: "main.c:1: error: expected ';'\n" } : {},
    );

    const outcome = await executeRequest(request(), deps(engine));

    expect(outcome.compile.ok).toBe(false);
    expect(outcome.compile.stderr).toContain("error: expected ';'");
    expect(outcome.cases).toEqual([]);
    expect(engine.calls.some((call) => call.argv[0] === "timeout")).toBe(false);
    expect(engine.removed).toContain("quiz-run-test");
  });

  /**
   * A `spice` request: one schematic, one file per stimulus, one case per
   * stimulus naming its own netlist (ADR-019). Nothing is built, so no
   * compile exec is issued at all and `compile.ok` is true by definition.
   */
  it("runs one ngspice per stimulus, with the netlist in the case's argv", async () => {
    const engine = createFakeEngine((call) =>
      call.argv[0] === "timeout" ? { exitCode: 0, stdout: " time v(out)\n0 0\n", ms: 40 } : {},
    );
    const outcome = await executeRequest(
      request({
        language: "spice",
        files: [
          { name: "s0.cir", content: "* s0\n.end\n" },
          { name: "s1.cir", content: "* s1\n.end\n" },
        ],
        cases: [
          { name: "s0", args: ["s0.cir"], stdin: "" },
          { name: "s1", args: ["s1.cir"], stdin: "" },
        ],
      }),
      deps(engine),
    );

    expect(engine.created[0]).toMatchObject({ image: "quiz-runner-spice:latest" });
    // Nothing between the uploads and the first case: a netlist has no build.
    expect(engine.calls.map((call) => call.argv[0])).toEqual(["cp", "cp", "timeout", "timeout"]);
    expect(outcome.compile).toEqual({ ok: true, stdout: "", stderr: "", ms: 0 });
    const runs = engine.calls.filter((call) => call.argv[0] === "timeout");
    expect(runs[0]!.argv).toEqual(["timeout", "-s", "KILL", "2", "ngspice", "-b", "s0.cir"]);
    expect(runs[1]!.argv).toEqual(["timeout", "-s", "KILL", "2", "ngspice", "-b", "s1.cir"]);
    expect(outcome.cases.map((c) => c.exitCode)).toEqual([0, 0]);
  });

  it("runs no case for an `action: check`", async () => {
    const engine = createFakeEngine();
    const outcome = await executeRequest(request({ action: "check" }), deps(engine));
    expect(outcome.compile.ok).toBe(true);
    expect(outcome.cases).toEqual([]);
  });

  it("carries the truncation flag of the engine into the outcome", async () => {
    const engine = createFakeEngine((call) =>
      call.argv[0] === "timeout"
        ? { exitCode: 0, stdout: "x".repeat(10), truncated: true }
        : {},
    );
    const outcome = await executeRequest(request(), deps(engine));
    expect(outcome.cases.map((c) => c.truncated)).toEqual([true, true]);
  });

  it("caps the output budget at the service's ceiling", async () => {
    const engine = createFakeEngine();
    await executeRequest(
      request({ limits: { timeMs: 1000, memoryMb: 64, outputKb: 256 } }),
      { engine, config: testConfig({ RUNNER_MAX_OUTPUT_KB: 16 }), containerName: () => "c" },
    );
    const run = engine.calls.find((call) => call.argv[0] === "timeout");
    expect(run?.maxBytes).toBe(16 * 1024);
  });

  it("caps the memory and the wall clock at the service's ceilings too", async () => {
    // A request may ask for what the wire schema allows; this machine decides
    // what it gets. The clamp reaches the container's `--memory`, the
    // in-container reaper, the service's own deadline and the container's ttl.
    const engine = createFakeEngine();
    const tight = testConfig({ RUNNER_MAX_MEMORY_MB: 64, RUNNER_MAX_TIME_MS: 1500 });
    await executeRequest(
      request({ limits: { timeMs: 20_000, memoryMb: 512, outputKb: 64 } }),
      { engine, config: tight, containerName: () => "c" },
    );
    expect(engine.created[0]?.memoryMb).toBe(64);
    const run = engine.calls.find((call) => call.argv[0] === "timeout");
    // `timeout -s KILL 2 …`: 1500 ms rounded up to the second.
    expect(run?.argv.slice(0, 4)).toEqual(["timeout", "-s", "KILL", "2"]);
    expect(run?.timeoutMs).toBe(1500 + tight.RUNNER_CASE_GRACE_MS);
    expect(engine.created[0]?.ttlSeconds).toBe(
      containerTtlSeconds(request({ limits: { timeMs: 1500, memoryMb: 64, outputKb: 64 } }), tight),
    );
  });

  it("rebuilds the container after a case that had to be killed", async () => {
    let caseNumber = 0;
    const engine = createFakeEngine((call) => {
      if (call.argv[0] !== "timeout") return {};
      caseNumber += 1;
      return caseNumber === 1
        ? { exitCode: null, timedOut: true, ms: 4000 }
        : { exitCode: 0, stdout: "fine\n" };
    });

    const outcome = await executeRequest(request(), deps(engine));

    expect(outcome.cases[0]).toMatchObject({ timedOut: true, oom: false, exitCode: null });
    expect(outcome.cases[1]).toMatchObject({ timedOut: false, stdout: "fine\n" });
    // One container to start with, one more after the kill.
    expect(engine.created).toHaveLength(2);
  });

  it("fails the remaining cases when the container cannot be brought back", async () => {
    let created = 0;
    const engine = createFakeEngine((call) =>
      call.argv[0] === "timeout" ? { exitCode: 137, ms: 40, containerGone: true } : {},
    );
    const failing = {
      ...engine,
      create: async (options: Parameters<typeof engine.create>[0]) => {
        created += 1;
        if (created > 1) throw new Error("engine is down");
        await engine.create(options);
      },
    };

    const outcome = await executeRequest(request(), deps(failing as typeof engine));

    expect(outcome.cases).toHaveLength(2);
    expect(outcome.cases[0]).toMatchObject({ oom: true });
    expect(outcome.cases[1]).toMatchObject({ timedOut: true, exitCode: null });
  });

  it("refuses a request whose files hold no source of the language", async () => {
    const engine = createFakeEngine();
    await expect(
      executeRequest(request({ files: [{ name: "notes.txt", content: "" }] }), deps(engine)),
    ).rejects.toMatchObject({ reason: "no_source_file" });
    expect(engine.created).toHaveLength(0);
  });
});
