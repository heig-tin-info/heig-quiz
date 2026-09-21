/**
 * The browser runner, main-thread half (ADR-015).
 *
 * Its whole job is the wall clock. A WebAssembly instance runs synchronously
 * on the thread that started it, so a `while (1)` in a student's program can
 * only be stopped by killing that thread: `worker.terminate()`. Everything
 * here follows from that one fact —
 *
 *  - one worker per run, armed with a timer that is re-armed at every
 *    `case.start` the worker reports;
 *  - the linked `program.wasm` travels BACK to the main thread as soon as the
 *    compile step succeeds, so when a case is killed the remaining cases go to
 *    a fresh worker without paying for clang a second time;
 *  - the runtimes are compiled once (`WebAssembly.Module`) and cached here;
 *    a module is structured-cloneable, so handing one to each new worker costs
 *    a reference, not thirty megabytes.
 *
 * Memory: a hard ceiling is only possible on a module that IMPORTS its memory,
 * and the three runtimes Runno ships all export theirs (measured — see
 * `memoryImportOf`). `limits.memoryMb` is therefore honoured when a runtime
 * allows it and best-effort otherwise; the wall clock is the real bound, and
 * the worker is a thread of its own, so what it allocates dies with it.
 */
import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";

import { BrowserRunnerUnavailable, type BrowserRunner, type RunHooks } from "../types";
import { ENTRY_FILE, RUNTIME_ASSETS, RUNTIME_BASE } from "./engine";
import type { RunnoAssets, RunnoJob, RunnoLanguage, WorkerMessage } from "./protocol";

/** Cheap compared with a student's program, and clang needs every millisecond of it. */
const COMPILE_BUDGET_MS = 10_000;
/** The default of `CodeLimits.timeMs`; a question may lower or raise it. */
const DEFAULT_CASE_MS = 2_000;
/** Between two cases the worker only copies a filesystem; this is pure slack. */
const IDLE_SLACK_MS = 1_000;

const LANGUAGES: readonly string[] = Object.keys(RUNTIME_ASSETS);

export const isRunnoLanguage = (language: string): language is RunnoLanguage =>
  LANGUAGES.includes(language);

// --- The runtime cache ------------------------------------------------------

const modules = new Map<string, Promise<WebAssembly.Module>>();
const archives = new Map<string, Promise<ArrayBuffer>>();

/**
 * Fetches one runtime file, refusing anything that is not one.
 *
 * A deployment without `public/runtimes` does not answer 404 for
 * `/runtimes/clang.wasm`: it answers the SPA's `index.html`, with a 200, like
 * every other unknown path. `WebAssembly.compileStreaming` then throws a
 * MIME-type `TypeError` — a real error, which would NOT have triggered the
 * fallback and would have shown a student a broken page instead of a run on
 * the backend. So the content type is checked here, and every failure of this
 * stage is reported as "the runtime did not load".
 */
async function fetchAsset(file: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${RUNTIME_BASE}/${file}`);
  } catch (error) {
    throw new BrowserRunnerUnavailable(
      `${file}: ${error instanceof Error ? error.message : "fetch failed"}`,
    );
  }
  if (!response.ok) throw new BrowserRunnerUnavailable(`${file}: HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (type.startsWith("text/html")) {
    throw new BrowserRunnerUnavailable(`${file}: served the application, not the runtime`);
  }
  return response;
}

/** Anything that went wrong while LOADING a runtime is the same fact. */
const asUnavailable = (file: string) => (error: unknown) => {
  if (error instanceof BrowserRunnerUnavailable) throw error;
  throw new BrowserRunnerUnavailable(
    `${file}: ${error instanceof Error ? error.message : String(error)}`,
  );
};

function moduleOf(file: string): Promise<WebAssembly.Module> {
  const cached = modules.get(file);
  if (cached !== undefined) return cached;
  // `compileStreaming` compiles off the main thread while the bytes arrive.
  const pending = fetchAsset(file)
    .then((response) => WebAssembly.compileStreaming(response))
    .catch((error: unknown) => {
      modules.delete(file);
      return asUnavailable(file)(error);
    });
  modules.set(file, pending);
  return pending;
}

function archiveOf(file: string): Promise<ArrayBuffer> {
  const cached = archives.get(file);
  if (cached !== undefined) return cached;
  // Still compressed: four megabytes cross to each worker instead of twenty,
  // and the decompression happens off the main thread.
  const pending = fetchAsset(file)
    .then((response) => response.arrayBuffer())
    .catch((error: unknown) => {
      archives.delete(file);
      return asUnavailable(file)(error);
    });
  archives.set(file, pending);
  return pending;
}

async function assetsFor(language: RunnoLanguage): Promise<RunnoAssets> {
  const spec = RUNTIME_ASSETS[language];
  const loaded: RunnoAssets = { modules: {}, archives: {} };
  await Promise.all([
    ...Object.entries(spec.modules).map(async ([role, file]) => {
      loaded.modules[role] = await moduleOf(file);
    }),
    ...Object.entries(spec.archives).map(async ([role, file]) => {
      loaded.archives[role] = await archiveOf(file);
    }),
  ]);
  return loaded;
}

/** True once every byte of that language's runtime is in memory. */
export function isRuntimeWarm(language: string): boolean {
  if (!isRunnoLanguage(language)) return false;
  const spec = RUNTIME_ASSETS[language];
  return [...Object.values(spec.modules), ...Object.values(spec.archives)].every(
    (file) => modules.has(file) || archives.has(file),
  );
}

// --- One worker, one pass ---------------------------------------------------

interface CaseResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  oom: boolean;
  truncated: boolean;
}

interface CompileResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  ms: number;
}

interface PassResult {
  compile: CompileResult | null;
  program: ArrayBuffer | null;
  results: Map<number, CaseResult>;
  /** The case whose wall clock ran out, or whose worker died under it. */
  killed: number | null;
  /** The worker died on that case rather than timing out: out of memory. */
  killedByCrash: boolean;
  /** The compile step itself ran out of time. */
  compileTimedOut: boolean;
  fatal: string | null;
}

function runPass(job: RunnoJob, caseMs: number, hooks?: RunHooks): Promise<PassResult> {
  return new Promise<PassResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "runno",
      });
    } catch (error) {
      reject(new BrowserRunnerUnavailable(error instanceof Error ? error.message : "no worker"));
      return;
    }

    const results = new Map<number, CaseResult>();
    let compile: CompileResult | null = null;
    let program: ArrayBuffer | null = job.program;
    let current: number | null = null;
    let settled = false;
    let timer = setTimeout(expire, job.program === null ? COMPILE_BUDGET_MS : caseMs + IDLE_SLACK_MS);

    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(expire, ms);
    };

    function finish(patch: Partial<PassResult>) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve({
        compile,
        program,
        results,
        killed: null,
        killedByCrash: false,
        compileTimedOut: false,
        fatal: null,
        ...patch,
      });
    }

    function expire() {
      if (current === null && compile === null) finish({ compileTimedOut: true });
      else finish({ killed: current });
    }

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "compile":
          compile = {
            ok: message.ok,
            stdout: message.stdout,
            stderr: message.stderr,
            ms: message.ms,
          };
          if (message.program !== null) program = message.program;
          hooks?.onStage?.("running");
          arm(caseMs + IDLE_SLACK_MS);
          break;
        case "case.start":
          current = message.index;
          arm(caseMs);
          break;
        case "case":
          current = null;
          results.set(message.index, {
            exitCode: message.exitCode,
            stdout: message.stdout,
            stderr: message.stderr,
            ms: message.ms,
            timedOut: false,
            oom: message.oom,
            truncated: message.truncated,
          });
          arm(caseMs + IDLE_SLACK_MS);
          break;
        case "done":
          finish({});
          break;
        case "fatal":
          finish({ fatal: message.message });
          break;
      }
    };
    /*
     * A worker that runs out of memory usually dies without an error event at
     * all, and then the timer above is what ends the pass. When the event does
     * arrive while a case is running, it says more than a timeout would.
     */
    worker.onerror = (event) => {
      const message = typeof event.message === "string" && event.message !== "" ? event.message : "worker crashed";
      if (current !== null) finish({ killed: current, killedByCrash: true, fatal: message });
      else finish({ fatal: message });
    };

    worker.postMessage(job);
  });
}

// --- The runner -------------------------------------------------------------

const timedOutCase = (ms: number): CaseResult => ({
  exitCode: null,
  stdout: "",
  stderr: "",
  ms,
  timedOut: true,
  oom: false,
  truncated: false,
});

class RunnoRunner implements BrowserRunner {
  readonly id = "runno";

  supports(language: string): boolean {
    return isRunnoLanguage(language);
  }

  async run(request: RunnerRequest, hooks?: RunHooks): Promise<RunnerOutcome> {
    const language = request.language;
    if (!isRunnoLanguage(language)) throw new BrowserRunnerUnavailable(`language ${language}`);

    if (!isRuntimeWarm(language)) hooks?.onStage?.("loading");
    const assets = await assetsFor(language);
    hooks?.onStage?.("compiling");

    // The entry file carries the extension the toolchain reads the language
    // from; everything else travels under the name the request gave it.
    const [entry, ...extra] = request.files;
    if (entry === undefined) throw new BrowserRunnerUnavailable("empty request");
    const files = [{ name: ENTRY_FILE[language], content: entry.content }, ...extra];

    const caseMs = request.limits.timeMs || DEFAULT_CASE_MS;
    const all = request.cases.map((c, index) => ({ index, args: c.args, stdin: c.stdin }));
    const results: (CaseResult | null)[] = all.map(() => null);
    let compile: CompileResult = { ok: true, stdout: "", stderr: "", ms: 0 };
    let program: ArrayBuffer | null = null;

    // One pass per surviving worker: a killed case costs one extra pass, and
    // there can never be more of those than there are cases.
    for (let pass = 0; pass <= all.length; pass += 1) {
      const pending = all.filter((c) => results[c.index] === null);
      if (pending.length === 0) break;
      const job: RunnoJob = {
        language,
        files,
        cases: pending,
        limits: request.limits,
        assets,
        program,
      };
      const outcome = await runPass(job, caseMs, hooks);
      if (outcome.compile !== null) compile = outcome.compile;
      if (outcome.program !== null) program = outcome.program;
      for (const [index, result] of outcome.results) results[index] = result;

      if (outcome.compileTimedOut) {
        compile = { ok: false, stdout: "", stderr: "", ms: COMPILE_BUDGET_MS };
        return { compile, cases: [] };
      }
      if (!compile.ok) return { compile, cases: [] };
      if (outcome.killed !== null) {
        results[outcome.killed] = outcome.killedByCrash
          ? { ...timedOutCase(caseMs), timedOut: false, oom: true }
          : timedOutCase(caseMs);
        continue;
      }
      if (outcome.fatal !== null && outcome.results.size === 0) {
        throw new BrowserRunnerUnavailable(outcome.fatal);
      }
      // The worker said `done` without a kill: anything still missing never ran.
      break;
    }

    return {
      compile,
      cases: results.map(
        (result) =>
          result ?? {
            exitCode: null,
            stdout: "",
            stderr: "",
            ms: 0,
            timedOut: false,
            oom: false,
            truncated: false,
          },
      ),
    };
  }
}

export const runnoRunner: BrowserRunner = new RunnoRunner();
