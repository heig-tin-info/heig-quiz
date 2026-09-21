/**
 * The message protocol between `runner.ts` (main thread) and `worker.ts`.
 *
 * One job per worker, and the worker reports as it goes rather than at the
 * end: the main thread arms the wall clock on `case.start` and, when it fires,
 * `terminate()`s the worker — which is the ONLY way to stop a synchronous
 * `while (1)` inside a WebAssembly instance. A worker that has been terminated
 * cannot tell us anything, so everything the next worker needs to resume
 * (chiefly the linked `program.wasm`) has already travelled back in `compile`.
 */

export type RunnoLanguage = "c" | "python";

/** The bytes a language needs, fetched and cached once by the main thread. */
export interface RunnoAssets {
  /** Compiled WebAssembly modules, keyed by role (`clang`, `wasm-ld`, `python`). */
  modules: Record<string, WebAssembly.Module>;
  /** Still-compressed `.tar.gz` base filesystems, keyed the same way. */
  archives: Record<string, ArrayBuffer>;
}

export interface RunnoJob {
  language: RunnoLanguage;
  /** The files of the program; the first one is the entry point. */
  files: { name: string; content: string }[];
  /** The cases still to run, with their index in the ORIGINAL request. */
  cases: { index: number; args: string[]; stdin: string }[];
  limits: { timeMs: number; memoryMb: number; outputKb: number };
  assets: RunnoAssets;
  /**
   * An already-linked `program.wasm`. Set when a previous worker was killed on
   * a case's wall clock: the compile step is not paid twice.
   */
  program: ArrayBuffer | null;
}

export type WorkerMessage =
  | {
      type: "compile";
      ok: boolean;
      stdout: string;
      stderr: string;
      ms: number;
      /** The linked program, so a later worker can resume without recompiling. */
      program: ArrayBuffer | null;
      /** Which runtimes accepted an injected `WebAssembly.Memory` (ADR-015). */
      memoryCapped: Record<string, boolean>;
    }
  | { type: "case.start"; index: number }
  | {
      type: "case";
      index: number;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      ms: number;
      oom: boolean;
      truncated: boolean;
    }
  | { type: "done" }
  | { type: "fatal"; message: string };
