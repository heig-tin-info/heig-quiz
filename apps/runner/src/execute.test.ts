import type { RunnerRequest } from "@quiz/core/server";
import { describe, expect, it } from "vitest";

import { classify, containerTtlSeconds, executeRequest, prepareFiles } from "./execute.js";
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
      { name: "one", stdin: "1\n" },
      { name: "two", stdin: "2\n" },
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
    const many = request({ cases: Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, stdin: "" })) });
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
