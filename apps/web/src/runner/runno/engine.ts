/**
 * The Runno engine: compile and run a program with `@runno/wasi`.
 *
 * It holds no browser global, so it runs unchanged inside `worker.ts` and
 * inside a Node harness. The worker is the only thing that knows about
 * `postMessage`; everything below is bytes in, results out.
 *
 * The argument lists of the two toolchains are transcribed from
 * `@runno/runtime`'s `commandsForRuntime` (0.10.0) rather than imported: that
 * package drags CodeMirror web components into the bundle and fetches its
 * runtimes from runno.dev, and an exam room on an IP allowlist reaches exactly
 * one origin — ours (ADR-015). Two deliberate differences from the original:
 *
 *  - `-fcolor-diagnostics` is dropped. Runno prints into a terminal that reads
 *    ANSI escapes; we print into a `<pre>` that would show them as `ESC[0;1;31m`.
 *  - the entry file keeps its extension (`/main.c`, `/main.py`) instead of the
 *    extensionless `/program`, so clang picks the language from the name.
 */
import { WASI, type WASIFS } from "@runno/wasi";
import { mainFileName } from "@quiz/domain";

import { extractTarGz, type ArchiveFiles } from "./tar";
import type { RunnoJob, RunnoLanguage, WorkerMessage } from "./protocol";

/** Where the runtimes are served from. Same origin, always (ADR-015). */
export const RUNTIME_BASE = "/runtimes";

/** The files `fetch-runtimes.mjs` downloads, per language. */
export const RUNTIME_ASSETS: Record<
  RunnoLanguage,
  { modules: Record<string, string>; archives: Record<string, string> }
> = {
  c: {
    modules: { clang: "clang.wasm", "wasm-ld": "wasm-ld.wasm" },
    archives: { sysroot: "clang-fs.tar.gz" },
  },
  python: {
    modules: { python: "python-3.11.3.wasm" },
    archives: { stdlib: "python-3.11.3.tar.gz" },
  },
};

/**
 * The entry file name per language; the student's source is written there.
 *
 * It is the name the BACKEND runner compiles too (`mainFileName` in
 * `@quiz/domain`, used by `qt-code`'s `buildRunnerRequest`). The two runners
 * answer the same shapes, so they must also agree on what the single file is
 * called: a browser run that compiled `/program` while the grader compiled
 * `main.c` would differ on the first `#include "main.c"` or `__file__`.
 */
export const ENTRY_FILE: Record<RunnoLanguage, string> = {
  c: mainFileName("c"),
  python: mainFileName("python"),
};

const COMPILE_ARGS = [
  "-cc1",
  "-Werror",
  "-triple",
  "wasm32-unkown-wasi", // sic: the triple binji's clang.wasm was built with
  "-isysroot",
  "/sys",
  "-internal-isystem",
  "/sys/include",
  "-internal-isystem",
  "/sys/lib/clang/8.0.1/include",
  "-ferror-limit",
  "4",
  "-fmessage-length",
  "80",
  "-O2",
  "-emit-obj",
  "-o",
  "/program.o",
];

const LINK_ARGS = [
  "--no-threads",
  "--export-dynamic",
  "-z",
  "stack-size=1048576",
  "-L/sys/lib/wasm32-wasi",
  "/sys/lib/wasm32-wasi/crt1.o",
  "/program.o",
  "-lc",
  "-o",
  "/program.wasm",
];

// --- Filesystem -------------------------------------------------------------

const stamps = () => {
  const at = new Date();
  return { access: at, modification: at, change: at };
};

function toWasiFS(files: ArchiveFiles): WASIFS {
  const fs: WASIFS = {};
  for (const [path, content] of Object.entries(files)) {
    fs[path] = { path, timestamps: stamps(), mode: "binary", content };
  }
  return fs;
}

function withSources(fs: WASIFS, files: { name: string; content: string }[]): WASIFS {
  const next: WASIFS = { ...fs };
  for (const file of files) {
    // A name from a request is a NAME, never a path (runner invariant 12).
    const path = `/${file.name.replace(/[^\w.-]/g, "_")}`;
    next[path] = { path, timestamps: stamps(), mode: "string", content: file.content };
  }
  return next;
}

// --- stdin / stdout ---------------------------------------------------------

const encoder = new TextEncoder();

/**
 * Serves a fixed string to the program, `maxByteLength` bytes at a time, then
 * EOF.
 *
 * `@runno/wasi`'s `fd_read` encodes whatever this returns and copies only what
 * fits in the caller's buffer — the rest is DROPPED. So the cut has to be made
 * here, in bytes, and the cursor advanced by exactly what was handed over.
 */
export function stdinReader(text: string): (maxByteLength: number) => string | null {
  let rest = text;
  return (max) => {
    if (rest === "") return null;
    if (encoder.encode(rest).byteLength <= max) {
      const all = rest;
      rest = "";
      return all;
    }
    // Shrink one character at a time from a byte-length estimate: a UTF-8
    // sequence is never split, because we measure the candidate itself.
    let take = Math.max(1, Math.min(rest.length, max));
    while (take > 1 && encoder.encode(rest.slice(0, take)).byteLength > max) take -= 1;
    const chunk = rest.slice(0, take);
    rest = rest.slice(take);
    return chunk;
  };
}

/** Thrown out of a write callback to stop a program that will not stop printing. */
export class OutputFlood extends Error {}

/**
 * Collects a stream, capped at `limitBytes`.
 *
 * Past the cap the text is dropped and `truncated` is set, which is what the
 * backend runner does too. A program that keeps printing regardless would burn
 * its whole wall clock producing nothing, so at eight times the cap the sink
 * throws and the run ends there.
 */
export function outputSink(limitBytes: number) {
  let text = "";
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk: string) {
      bytes += encoder.encode(chunk).byteLength;
      if (bytes > limitBytes) {
        truncated = true;
        if (bytes > limitBytes * 8) throw new OutputFlood("output limit exceeded");
        return;
      }
      text += chunk;
    },
    get text() {
      return text;
    },
    get truncated() {
      return truncated;
    },
  };
}

// --- One WASI process -------------------------------------------------------

export interface ProcessResult {
  exitCode: number | null;
  fs: WASIFS;
  ms: number;
  oom: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Whether a module asks the host for its memory.
 *
 * This is the ONE place a browser runner can put a hard ceiling on a program:
 * a module that imports `env.memory` gets a `WebAssembly.Memory` with a
 * `maximum`, and every `memory.grow` past it returns -1 the way a container's
 * `--memory` makes `mmap` fail. A module that EXPORTS its memory — which is
 * what all three shipped runtimes do, measured — declares its own limits and
 * the host has no say; there, the wall clock is the only real bound (ADR-015).
 */
export function memoryImportOf(
  module: WebAssembly.Module,
): { module: string; name: string } | null {
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind === "memory") return { module: entry.module, name: entry.name };
  }
  return null;
}

const PAGE = 64 * 1024;

export async function runProcess(options: {
  module: WebAssembly.Module;
  args: string[];
  fs: WASIFS;
  stdin: string;
  memoryMb: number;
  outputBytes: number;
}): Promise<ProcessResult & { memoryCapped: boolean }> {
  const stdout = outputSink(options.outputBytes);
  const stderr = outputSink(options.outputBytes);
  const wasi = new WASI({
    args: options.args,
    env: {},
    fs: options.fs,
    stdin: stdinReader(options.stdin),
    stdout: (out) => stdout.push(out),
    stderr: (err) => stderr.push(err),
    isTTY: false,
  });

  const imports = wasi.getImportObject() as Record<string, WebAssembly.ModuleImports>;
  const wants = memoryImportOf(options.module);
  let memory: WebAssembly.Memory | undefined;
  if (wants !== null) {
    memory = new WebAssembly.Memory({
      initial: 2,
      maximum: Math.max(2, Math.floor((options.memoryMb * 1024 * 1024) / PAGE)),
    });
    imports[wants.module] = { ...(imports[wants.module] ?? {}), [wants.name]: memory };
  }

  const started = Date.now();
  try {
    const instance = await WebAssembly.instantiate(options.module, imports);
    const result = wasi.start(
      { instance, module: options.module },
      memory === undefined ? {} : { memory },
    );
    return {
      exitCode: result.exitCode,
      fs: result.fs,
      ms: Date.now() - started,
      oom: false,
      truncated: stdout.truncated || stderr.truncated,
      stdout: stdout.text,
      stderr: stderr.text,
      memoryCapped: memory !== undefined,
    };
  } catch (error) {
    const flood = error instanceof OutputFlood;
    const oom =
      !flood &&
      (error instanceof RangeError ||
        /out of memory|memory|allocation/i.test(error instanceof Error ? error.message : ""));
    return {
      exitCode: null,
      fs: options.fs,
      ms: Date.now() - started,
      oom,
      truncated: flood || stdout.truncated || stderr.truncated,
      stdout: stdout.text,
      stderr: flood ? stderr.text : `${stderr.text}${describe(error)}`,
      memoryCapped: memory !== undefined,
    };
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}\n` : `${String(error)}\n`;

// --- The job ----------------------------------------------------------------

export interface EngineEvents {
  emit(message: WorkerMessage): void;
}

/**
 * Compiles (C only) and then runs each case, reporting as it goes.
 *
 * Nothing here enforces the wall clock: a WebAssembly instance runs to
 * completion on the thread that started it. The deadline is the caller's, and
 * on this side of it there is only `case.start` — the signal the main thread
 * arms its timer on.
 */
export async function runJob(job: RunnoJob, events: EngineEvents): Promise<void> {
  const outputBytes = job.limits.outputKb * 1024;
  const assets = RUNTIME_ASSETS[job.language];
  const memoryCapped: Record<string, boolean> = {};

  let fs: WASIFS;
  let program: WebAssembly.Module;
  let programBytes: ArrayBuffer | null = job.program;

  if (job.language === "python") {
    const started = Date.now();
    const stdlib = job.assets.archives["stdlib"];
    if (stdlib === undefined) throw new Error("missing python stdlib archive");
    fs = withSources(toWasiFS(await extractTarGz(new Uint8Array(stdlib))), job.files);
    const python = job.assets.modules["python"];
    if (python === undefined) throw new Error("missing python module");
    program = python;
    memoryCapped["python"] = memoryImportOf(python) !== null;
    // Python has no compile step; the message still fires so the player can
    // leave its "loading the runtime" state on the same signal for both.
    events.emit({
      type: "compile",
      ok: true,
      stdout: "",
      stderr: "",
      ms: Date.now() - started,
      program: null,
      memoryCapped,
    });
  } else {
    const sysroot = job.assets.archives["sysroot"];
    if (sysroot === undefined) throw new Error("missing clang sysroot archive");
    const base = withSources(toWasiFS(await extractTarGz(new Uint8Array(sysroot))), job.files);
    if (programBytes === null) {
      const started = Date.now();
      const clang = job.assets.modules["clang"];
      const linker = job.assets.modules["wasm-ld"];
      if (clang === undefined || linker === undefined) throw new Error("missing clang toolchain");
      memoryCapped["clang"] = memoryImportOf(clang) !== null;
      memoryCapped["wasm-ld"] = memoryImportOf(linker) !== null;

      const compiled = await runProcess({
        module: clang,
        args: ["clang", ...COMPILE_ARGS, `/${ENTRY_FILE.c}`],
        fs: base,
        stdin: "",
        memoryMb: job.limits.memoryMb,
        outputBytes,
      });
      if (compiled.exitCode !== 0) {
        events.emit({
          type: "compile",
          ok: false,
          stdout: compiled.stdout,
          stderr: compiled.stderr,
          ms: compiled.ms,
          program: null,
          memoryCapped,
        });
        events.emit({ type: "done" });
        return;
      }
      const linked = await runProcess({
        module: linker,
        args: ["wasm-ld", ...LINK_ARGS],
        fs: compiled.fs,
        stdin: "",
        memoryMb: job.limits.memoryMb,
        outputBytes,
      });
      const built = linked.fs["/program.wasm"];
      if (linked.exitCode !== 0 || built === undefined || built.mode !== "binary") {
        events.emit({
          type: "compile",
          ok: false,
          stdout: compiled.stdout + linked.stdout,
          stderr: compiled.stderr + linked.stderr,
          ms: Date.now() - started,
          program: null,
          memoryCapped,
        });
        events.emit({ type: "done" });
        return;
      }
      programBytes = built.content.slice().buffer as ArrayBuffer;
      events.emit({
        type: "compile",
        ok: true,
        stdout: compiled.stdout + linked.stdout,
        stderr: compiled.stderr + linked.stderr,
        ms: Date.now() - started,
        program: programBytes,
        memoryCapped,
      });
    }
    fs = base;
    program = await WebAssembly.compile(programBytes);
  }

  const argv0 = job.language === "python" ? "python" : "program";
  const prelude = job.language === "python" ? [`/${ENTRY_FILE.python}`] : [];

  for (const testCase of job.cases) {
    events.emit({ type: "case.start", index: testCase.index });
    const result = await runProcess({
      module: program,
      // `argv[0]` is the program's own name; the case's arguments follow it.
      args: [argv0, ...prelude, ...testCase.args],
      fs: { ...fs },
      stdin: testCase.stdin,
      memoryMb: job.limits.memoryMb,
      outputBytes,
    });
    events.emit({
      type: "case",
      index: testCase.index,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ms: result.ms,
      oom: result.oom,
      truncated: result.truncated,
    });
  }
  events.emit({ type: "done" });
}
