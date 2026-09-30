/**
 * The main-thread half of the browser runner (ADR-015), with its two
 * boundaries replaced: `fetch` + `WebAssembly.compileStreaming` (the runtime
 * download) and `Worker` (the thread the program runs on). What is pinned is
 * what this half owns:
 *
 *  - a runtime that did not load is `BrowserRunnerUnavailable` — the signal
 *    to fall back to the backend — including the SPA's `index.html` served
 *    with a 200 in place of a missing `.wasm`;
 *  - the wall clock: a case that outlives `limits.timeMs` is killed with its
 *    worker, and the remaining cases go to a fresh worker WITH the linked
 *    program, so clang is not paid twice;
 *  - the mapping of what the worker reported onto a `RunnerOutcome`.
 *
 * Each test imports a fresh copy of the module: the runtime cache is
 * module-level state.
 */
import type { RunnerRequest } from "@quiz/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserRunnerUnavailable } from "../types";
import type { RunnoJob, WorkerMessage } from "./protocol";

// --- The worker double -------------------------------------------------------

/** What a scripted worker does with the job it receives. */
type Script = (job: RunnoJob, worker: FakeWorker) => void;

class FakeWorker {
  static script: Script = () => {};
  static created: FakeWorker[] = [];
  static failToConstruct = false;

  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  job: RunnoJob | null = null;
  terminated = false;

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    if (FakeWorker.failToConstruct) throw new Error("workers are disabled");
    FakeWorker.created.push(this);
  }

  postMessage(job: RunnoJob) {
    this.job = job;
    FakeWorker.script(job, this);
  }

  /** Reports a message, as the real worker would, unless it was killed. */
  send(message: WorkerMessage) {
    if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent<WorkerMessage>);
  }

  crash(message: string) {
    if (!this.terminated) this.onerror?.({ message } as ErrorEvent);
  }

  terminate() {
    this.terminated = true;
  }
}

const PROGRAM = new ArrayBuffer(8);

const compiled = (over: Partial<Extract<WorkerMessage, { type: "compile" }>> = {}): WorkerMessage => ({
  type: "compile",
  ok: true,
  stdout: "",
  stderr: "",
  ms: 120,
  program: PROGRAM,
  memoryCapped: {},
  ...over,
});

const caseDone = (index: number, stdout = `out ${index}`): WorkerMessage => ({
  type: "case",
  index,
  exitCode: 0,
  stdout,
  stderr: "",
  ms: 5,
  oom: false,
  truncated: false,
});

/** Compiles, then runs every case at once and says done. */
const allGood: Script = (job, worker) => {
  queueMicrotask(() => {
    worker.send(compiled({ program: job.program === null ? PROGRAM : null }));
    for (const c of job.cases) {
      worker.send({ type: "case.start", index: c.index });
      worker.send(caseDone(c.index));
    }
    worker.send({ type: "done" });
  });
};

// --- The download double -----------------------------------------------------

const fetchMock = vi.fn<(url: string) => Promise<Response>>();
const fakeModule = {} as WebAssembly.Module;

function wasmResponse(): Response {
  return new Response(new Uint8Array([0, 97, 115, 109]), { headers: { "content-type": "application/wasm" } });
}

beforeEach(() => {
  FakeWorker.script = allGood;
  FakeWorker.created = [];
  FakeWorker.failToConstruct = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => wasmResponse());
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(WebAssembly, "compileStreaming").mockImplementation(async () => fakeModule);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fresh() {
  return import("./runner");
}

/**
 * By name: each test imports a fresh module graph, so the class the runner
 * throws is not the one a static import here would see.
 */
function expectUnavailable(error: unknown): asserts error is BrowserRunnerUnavailable {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("BrowserRunnerUnavailable");
}

function request(over: Partial<RunnerRequest> = {}): RunnerRequest {
  return {
    language: "c",
    files: [
      { name: "student.c", content: "int main(void) { return 0; }" },
      { name: "helper.h", content: "#define X 1" },
    ],
    compileArgs: "",
    action: "run",
    limits: { timeMs: 500, memoryMb: 64, outputKb: 16 },
    cases: [
      { name: "a", args: ["1"], stdin: "x" },
      { name: "b", args: [], stdin: "" },
      { name: "c", args: ["3", "4"], stdin: "z" },
    ],
    priority: "interactive",
    ...over,
  };
}

describe("what the runner claims", () => {
  it("supports C and Python only", async () => {
    const { runnoRunner, isRunnoLanguage } = await fresh();
    expect(runnoRunner.id).toBe("runno");
    expect(runnoRunner.supports("c")).toBe(true);
    expect(runnoRunner.supports("python")).toBe(true);
    for (const other of ["cpp", "js", "rust", "spice", ""]) {
      expect(runnoRunner.supports(other)).toBe(false);
      expect(isRunnoLanguage(other)).toBe(false);
    }
  });

  it("refuses another language as unavailable, before downloading anything", async () => {
    const { runnoRunner } = await fresh();
    expectUnavailable(await runnoRunner.run(request({ language: "rust" })).catch((e: unknown) => e));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("loading the runtime", () => {
  it("downloads each file once, from our own origin, and is warm afterwards", async () => {
    const { runnoRunner, isRuntimeWarm } = await fresh();
    expect(isRuntimeWarm("c")).toBe(false);
    expect(isRuntimeWarm("cobol")).toBe(false);

    const stages: string[] = [];
    await runnoRunner.run(request(), { onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["loading", "compiling", "running"]);
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
      "/runtimes/clang-fs.tar.gz",
      "/runtimes/clang.wasm",
      "/runtimes/wasm-ld.wasm",
    ]);
    expect(isRuntimeWarm("c")).toBe(true);
    expect(isRuntimeWarm("python")).toBe(false);

    // Warm: no `loading` stage, no second download.
    stages.length = 0;
    await runnoRunner.run(request(), { onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["compiling", "running"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("calls a network failure unavailable, and tries again on the next run", async () => {
    const { runnoRunner } = await fresh();
    fetchMock.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    const error = await runnoRunner.run(request()).catch((e: unknown) => e);
    expectUnavailable(error);
    expect(error.reason).toMatch(/network down/);
    expect(FakeWorker.created).toHaveLength(0);

    // The failure is not cached: the network came back.
    fetchMock.mockImplementation(async () => wasmResponse());
    const outcome = await runnoRunner.run(request());
    expect(outcome.compile.ok).toBe(true);
  });

  it("calls an HTTP error unavailable", async () => {
    const { runnoRunner } = await fresh();
    fetchMock.mockImplementation(async () => new Response("", { status: 404 }));
    await expect(runnoRunner.run(request())).rejects.toThrow(/HTTP 404/);
  });

  it("calls the SPA's index.html, served with a 200 in place of a runtime, unavailable", async () => {
    const { runnoRunner } = await fresh();
    fetchMock.mockImplementation(
      async () => new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    const error = await runnoRunner.run(request()).catch((e: unknown) => e);
    expectUnavailable(error);
    expect((error as Error).message).toMatch(/served the application/);
  });

  it("calls a module that does not compile unavailable, not a crash of the page", async () => {
    const { runnoRunner } = await fresh();
    vi.mocked(WebAssembly.compileStreaming).mockRejectedValue(new TypeError("bad magic"));
    const error = await runnoRunner.run(request()).catch((e: unknown) => e);
    expectUnavailable(error);
    expect((error as Error).message).toMatch(/bad magic/);
  });

  it("calls a browser without workers unavailable", async () => {
    const { runnoRunner } = await fresh();
    FakeWorker.failToConstruct = true;
    await expect(runnoRunner.run(request())).rejects.toThrow(/workers are disabled/);
  });
});

describe("the job sent to the worker", () => {
  it("renames the entry file, keeps the others, and numbers the cases", async () => {
    const { runnoRunner } = await fresh();
    await runnoRunner.run(request());
    const job = FakeWorker.created[0]!.job!;
    expect(job.language).toBe("c");
    expect(job.files.map((f) => f.name)).toEqual(["main.c", "helper.h"]);
    expect(job.files[0]!.content).toBe("int main(void) { return 0; }");
    expect(job.cases).toEqual([
      { index: 0, args: ["1"], stdin: "x" },
      { index: 1, args: [], stdin: "" },
      { index: 2, args: ["3", "4"], stdin: "z" },
    ]);
    expect(job.program).toBeNull();
    expect(job.check).toBe(false);
    expect(job.limits).toEqual({ timeMs: 500, memoryMb: 64, outputKb: 16 });
    expect(Object.keys(job.assets.modules).sort()).toEqual(["clang", "wasm-ld"]);
    expect(Object.keys(job.assets.archives)).toEqual(["sysroot"]);
  });

  it("builds only on `check`, whatever cases the request lists", async () => {
    const { runnoRunner } = await fresh();
    const outcome = await runnoRunner.run(request({ action: "check" }));
    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0]!.job).toMatchObject({ cases: [], check: true });
    expect(outcome).toEqual({ compile: { ok: true, stdout: "", stderr: "", ms: 120 }, cases: [] });
  });

  it("refuses a request without a file", async () => {
    const { runnoRunner } = await fresh();
    await expect(runnoRunner.run(request({ files: [] }))).rejects.toThrow(/empty request/);
  });
});

describe("the outcome", () => {
  it("maps every case the worker reported, in the request's order", async () => {
    const { runnoRunner } = await fresh();
    const outcome = await runnoRunner.run(request());
    expect(outcome.compile).toEqual({ ok: true, stdout: "", stderr: "", ms: 120 });
    expect(outcome.cases.map((c) => c.stdout)).toEqual(["out 0", "out 1", "out 2"]);
    expect(outcome.cases.every((c) => c.exitCode === 0 && !c.timedOut && !c.oom)).toBe(true);
    // One worker, terminated once it said `done`.
    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0]!.terminated).toBe(true);
  });

  it("returns a failed build with no case, and starts no second worker", async () => {
    const { runnoRunner } = await fresh();
    FakeWorker.script = (_job, worker) =>
      queueMicrotask(() => {
        worker.send(compiled({ ok: false, stderr: "main.c:1: error", program: null }));
        worker.send({ type: "done" });
      });
    const outcome = await runnoRunner.run(request());
    expect(outcome).toEqual({ compile: { ok: false, stdout: "", stderr: "main.c:1: error", ms: 120 }, cases: [] });
    expect(FakeWorker.created).toHaveLength(1);
  });

  it("fills a case the worker never reached with an empty, not-timed-out result", async () => {
    const { runnoRunner } = await fresh();
    FakeWorker.script = (_job, worker) =>
      queueMicrotask(() => {
        worker.send(compiled());
        worker.send({ type: "case.start", index: 0 });
        worker.send(caseDone(0));
        worker.send({ type: "done" });
      });
    const outcome = await runnoRunner.run(request());
    expect(outcome.cases).toHaveLength(3);
    expect(outcome.cases[1]).toEqual({
      exitCode: null,
      stdout: "",
      stderr: "",
      ms: 0,
      timedOut: false,
      oom: false,
      truncated: false,
    });
  });

  it("passes a fatal error with no result on as unavailable", async () => {
    const { runnoRunner } = await fresh();
    FakeWorker.script = (_job, worker) =>
      queueMicrotask(() => {
        worker.send(compiled());
        worker.send({ type: "fatal", message: "missing clang toolchain" });
      });
    await expect(runnoRunner.run(request())).rejects.toThrow(/missing clang toolchain/);
  });

  it("calls a worker crash before any case unavailable too", async () => {
    const { runnoRunner } = await fresh();
    FakeWorker.script = (_job, worker) => queueMicrotask(() => worker.crash(""));
    await expect(runnoRunner.run(request())).rejects.toThrow(/worker crashed/);
  });
});

describe("the wall clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("kills a case past timeMs, and resumes the rest on a fresh worker with the linked program", async () => {
    const { runnoRunner } = await fresh();
    // The first worker hangs on case 1 (a `while (1)`); the next runs what is left.
    FakeWorker.script = (job, worker) =>
      queueMicrotask(() => {
        if (FakeWorker.created.length === 1) {
          worker.send(compiled());
          worker.send({ type: "case.start", index: 0 });
          worker.send(caseDone(0));
          worker.send({ type: "case.start", index: 1 });
          return; // never answers again
        }
        allGood(job, worker);
      });
    const running = runnoRunner.run(request());
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWorker.created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await running;

    expect(FakeWorker.created).toHaveLength(2);
    expect(FakeWorker.created[0]!.terminated).toBe(true);
    const resumed = FakeWorker.created[1]!.job!;
    expect(resumed.program).toBe(PROGRAM);
    expect(resumed.cases.map((c) => c.index)).toEqual([2]);

    expect(outcome.cases[0]).toMatchObject({ stdout: "out 0", timedOut: false });
    expect(outcome.cases[1]).toEqual({
      exitCode: null,
      stdout: "",
      stderr: "",
      ms: 500,
      timedOut: true,
      oom: false,
      truncated: false,
    });
    expect(outcome.cases[2]).toMatchObject({ stdout: "out 2", timedOut: false });
    // The compile of the first pass stands: the resumed worker built nothing.
    expect(outcome.compile.ok).toBe(true);
  });

  it("takes the default two seconds when the request sets no time", async () => {
    const { runnoRunner } = await fresh();
    FakeWorker.script = (job, worker) =>
      queueMicrotask(() => {
        if (FakeWorker.created.length > 1) return allGood(job, worker);
        worker.send(compiled());
        worker.send({ type: "case.start", index: 0 });
      });
    const running = runnoRunner.run(
      request({ limits: { timeMs: 0, memoryMb: 64, outputKb: 16 }, cases: [{ name: "a", args: [], stdin: "" }] }),
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeWorker.created[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await running;
    expect(outcome.cases[0]).toMatchObject({ timedOut: true, ms: 2_000 });
  });

  it("gives up on a build that outlasts its ten-second budget", async () => {
    const { runnoRunner } = await fresh();
    FakeWorker.script = () => {}; // clang never returns
    const running = runnoRunner.run(request());
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await running;
    expect(outcome).toEqual({ compile: { ok: false, stdout: "", stderr: "", ms: 10_000 }, cases: [] });
    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0]!.terminated).toBe(true);
  });

  it("reports a worker that dies under a case as out of memory, not a timeout", async () => {
    const { runnoRunner } = await fresh();
    FakeWorker.script = (job, worker) =>
      queueMicrotask(() => {
        if (FakeWorker.created.length > 1) return allGood(job, worker);
        worker.send(compiled());
        worker.send({ type: "case.start", index: 0 });
        worker.crash("Out of memory");
      });
    const running = runnoRunner.run(request({ cases: [{ name: "a", args: [], stdin: "" }, { name: "b", args: [], stdin: "" }] }));
    await vi.runAllTimersAsync();
    const outcome = await running;
    expect(outcome.cases[0]).toMatchObject({ exitCode: null, timedOut: false, oom: true });
    expect(outcome.cases[1]).toMatchObject({ stdout: "out 1" });
    expect(FakeWorker.created[1]!.job!.cases.map((c) => c.index)).toEqual([1]);
  });

  it("never starts more passes than there are cases, even if every one hangs", async () => {
    const { runnoRunner } = await fresh();
    FakeWorker.script = (job, worker) =>
      queueMicrotask(() => {
        if (job.program === null) worker.send(compiled());
        worker.send({ type: "case.start", index: job.cases[0]!.index });
      });
    const running = runnoRunner.run(request());
    await vi.runAllTimersAsync();
    const outcome = await running;
    expect(outcome.cases.every((c) => c.timedOut)).toBe(true);
    expect(FakeWorker.created).toHaveLength(3);
  });
});
