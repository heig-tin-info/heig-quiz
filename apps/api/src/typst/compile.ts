/**
 * One Typst compile in its sandbox (ADR-125 §2): the source and its assets
 * in a fresh temporary directory that is the compile's whole world, the
 * binary run by `execFile` with an argv array (never a shell), under a
 * closed environment, a hard timeout and, where the host has `prlimit`, an
 * address-space cap; the directory removed whatever happens.
 *
 * The child shares the API's container, with no namespace of its own: the
 * escaping of `@quiz/docexport/typst`, this environment and `--root` are
 * the defence.
 *   - `--root <dir>`: a `read`, an `image` or an `import` reaches nothing
 *     outside the temporary directory.
 *   - `--ignore-system-fonts`: the fonts embedded in the binary only, the
 *     same PDF on every machine.
 *   - The environment is built here, key by key, never copied from
 *     `process.env`: no database URL, no OIDC, LLM or GitHub secret reaches
 *     the child. Its package directories are inside the temporary directory
 *     (empty), and its proxies point at a closed port: moving the package
 *     paths alone does not stop a download (verified on Typst 0.15.1), the
 *     dead proxy does, so an `#import "@preview/…"` fails offline.
 *
 * What the child prints is for the log, never for a client.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Where a request for the network goes: a port nothing listens on. */
export const DEAD_PROXY = "http://127.0.0.1:9";

/** The most a compile may print, on each stream. */
const MAX_BUFFER = 1 << 20;

/** The largest PDF read back (ADR-125 §2). */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** An asset's place in the compile root: `assets/<id>`, the id the upload endpoint gives. */
const ASSET_PATH = /^assets\/[A-Za-z0-9_-]{1,64}$/;

export interface TypstInput {
  /** `main.typ`. */
  source: string;
  /** The images it draws, each at `path` under the root. */
  assets: readonly { path: string; bytes: Buffer }[];
}

export interface CompileOptions {
  /** The binary, on PATH or absolute. */
  bin: string;
  timeoutMs: number;
  /**
   * The address-space cap in bytes, applied through `prlimit` when it is
   * given, with the file-size cap of {@link MAX_PDF_BYTES} beside it: the
   * output is bounded while Typst writes it, not only once it is written.
   */
  memory?: { prlimit: string; bytes: number } | null | undefined;
  /** Where the temporary directory is made: the system's by default, a test's own to watch it go. */
  parent?: string | undefined;
}

/** Why a compile gave no PDF; `log` is the child's output, for the server's log only. */
export class TypstFailure extends Error {
  constructor(
    /**
     * `timeout`: killed at its deadline; `output`: it printed more than
     * {@link MAX_BUFFER}; `too_large`: a PDF over {@link MAX_PDF_BYTES};
     * `missing`: the program is not there (`ENOENT`); `error`: any other.
     */
    readonly reason: "timeout" | "output" | "too_large" | "missing" | "error",
    readonly log: string,
  ) {
    super(`typst compile failed: ${reason}`);
    this.name = "TypstFailure";
  }
}

/**
 * The child's whole environment, for the temporary directory `dir`. A key
 * added here reaches a process that reads teacher and student text: it is
 * added with the test that lists them (`compile.test.ts`).
 */
export function typstEnv(dir: string): Record<string, string> {
  return {
    // The one inherited value: where `execFile` and the binary look up
    // programs. A PATH names directories, never a secret.
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: dir,
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_DATA_HOME: join(dir, "data"),
    TYPST_PACKAGE_PATH: join(dir, "packages"),
    TYPST_PACKAGE_CACHE_PATH: join(dir, "package-cache"),
    HTTPS_PROXY: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    HTTP_PROXY: DEAD_PROXY,
    http_proxy: DEAD_PROXY,
  };
}

/** The argv of a compile of `main.typ` into `out.pdf`, rooted at `dir`. */
export const compileArgs = (dir: string): string[] => [
  "compile",
  "--root",
  dir,
  "--ignore-system-fonts",
  "--diagnostic-format",
  "short",
  "--format",
  "pdf",
  "main.typ",
  "out.pdf",
];

/** `relative` under `dir`, or a throw: a stored path is still an input. */
function inside(dir: string, relative: string): string {
  const full = resolve(dir, relative);
  if (!ASSET_PATH.test(relative) || !full.startsWith(dir + sep)) throw new Error("asset path escapes the compile root");
  return full;
}

/** What a failed `execFile` was: its own code first, since an overrun of `maxBuffer` is killed too. */
function failureReason(error: Error & { code?: unknown; killed?: boolean; signal?: string | null }): TypstFailure["reason"] {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output";
  if (error.code === "ENOENT") return "missing";
  if (error.killed === true && error.signal === "SIGKILL") return "timeout";
  return "error";
}

/** Runs `bin args` in `dir` under the closed environment; resolves with its output, or rejects with it. */
export function run(
  bin: string,
  args: readonly string[],
  dir: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    execFile(
      bin,
      args,
      { cwd: dir, env: typstEnv(dir), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return done({ stdout, stderr });
        fail(new TypstFailure(failureReason(error), `${stderr}`.slice(0, 4000)));
      },
    );
  });
}

/** A fresh compile root, its directory removed once `body` settles. */
export async function inTempDir<T>(body: (dir: string) => Promise<T>, parent = tmpdir()): Promise<T> {
  const dir = await mkdtemp(join(parent, "quiz-typst-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The PDF of `input`, or a {@link TypstFailure}. */
export function compileTypst(input: TypstInput, options: CompileOptions): Promise<Buffer> {
  return inTempDir(async (dir) => {
    await writeFile(join(dir, "main.typ"), input.source, "utf8");
    if (input.assets.length > 0) await mkdir(join(dir, "assets"));
    for (const asset of input.assets) await writeFile(inside(dir, asset.path), asset.bytes);
    const args = compileArgs(dir);
    const { memory } = options;
    await (memory
      ? run(memory.prlimit, [`--as=${memory.bytes}`, `--fsize=${MAX_PDF_BYTES}`, "--", options.bin, ...args], dir, options.timeoutMs)
      : run(options.bin, args, dir, options.timeoutMs));
    const out = join(dir, "out.pdf");
    if ((await stat(out)).size > MAX_PDF_BYTES) throw new TypstFailure("too_large", "");
    return readFile(out);
  }, options.parent);
}
