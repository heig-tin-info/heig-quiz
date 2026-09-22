import type { RunnerLanguage } from "@quiz/core/server";

/**
 * What each language does with the files it is handed: how it is built, and
 * how it is started.
 *
 * Everything is an argv, never a shell string. No `sh -c` runs in a container
 * of this service, so a teacher's `compileArgs` and a student's file name are
 * arguments of a process, not fragments of a command line — there is no shell
 * for them to escape from.
 */

/** The compiled artifact, always in the tmpfs work directory. */
const PROGRAM = "./program";

export interface LanguagePlan {
  /** `null` when the language has nothing to build (`compile.ok` is then true by definition). */
  compile: string[] | null;
  run: string[];
}

interface Spec {
  /** Extensions that count as a source file for the compiler. */
  sources: readonly string[];
  plan(mainFile: string, sources: string[], args: string[]): LanguagePlan;
}

const SPECS: Readonly<Record<RunnerLanguage, Spec>> = {
  c: {
    sources: [".c"],
    plan: (_main, sources, args) => ({
      // -lm last: the linker resolves left to right, and a student's `sqrt`
      // would otherwise be undefined.
      compile: ["gcc", "-std=c17", "-O1", "-Wall", "-o", "program", ...sources, ...args, "-lm"],
      run: [PROGRAM],
    }),
  },
  cpp: {
    sources: [".cpp", ".cc", ".cxx"],
    plan: (_main, sources, args) => ({
      compile: ["g++", "-std=c++20", "-O1", "-Wall", "-o", "program", ...sources, ...args],
      run: [PROGRAM],
    }),
  },
  python: {
    sources: [".py"],
    // There is nothing to link, but a syntax error must reach the student as a
    // compile error and not as four identical failed cases.
    plan: (main, _sources, _args) => ({
      compile: ["python3", "-m", "py_compile", main],
      run: ["python3", main],
    }),
  },
  js: {
    sources: [".js", ".mjs"],
    plan: (main, _sources, _args) => ({
      compile: ["node", "--check", main],
      run: ["node", main],
    }),
  },
  rust: {
    sources: [".rs"],
    plan: (main, _sources, args) => ({
      compile: ["rustc", "-O", "-o", "program", main, ...args],
      run: [PROGRAM],
    }),
  },
  /**
   * ngspice, for the `circuit` question type (ADR-019).
   *
   * Nothing is built: a netlist is the program. `compile` is therefore `null`
   * and a malformed netlist reaches the student as a FAILED CASE (ngspice
   * exits non-zero and says why on stderr), not as a compile error — unlike
   * `python`, where `py_compile` exists precisely so a syntax error is not
   * reported four times over. ngspice has no such check mode: `-b` on a
   * netlist is both the parse and the run.
   *
   * The netlist file is NOT in the run plan: it is the case's `args`. One
   * request carries one schematic and several stimuli — `s0.cir`, `s1.cir` …,
   * one file per stimulus, all rebuilt server-side (invariant 14) — and the
   * case named `s0` runs with `args: ["s0.cir"]`. `caseArgv` therefore yields
   * `timeout -s KILL <s> ngspice -b s0.cir`, and one container serves every
   * stimulus of the answer.
   *
   * A case with NO argument is not a hang: `ngspice -b` then reads its stdin,
   * which the engine closes immediately (`engine.exec` ends the stream), and
   * it exits 1 with "no simulations run" in a few milliseconds. Verified on
   * ngspice 42 (apps/runner/README.md).
   */
  spice: {
    sources: [".cir"],
    plan: () => ({ compile: null, run: ["ngspice", "-b"] }),
  },
};

/** The main file of a request: the first file the language can build from. */
export function mainSource(language: RunnerLanguage, names: readonly string[]): string | null {
  const spec = SPECS[language];
  return names.find((name) => spec.sources.some((ext) => name.endsWith(ext))) ?? null;
}

export function planFor(
  language: RunnerLanguage,
  names: readonly string[],
  compileArgs: readonly string[],
): LanguagePlan | null {
  const spec = SPECS[language];
  const main = mainSource(language, names);
  if (main === null) return null;
  const sources = names.filter((name) => spec.sources.some((ext) => name.endsWith(ext)));
  return spec.plan(main, sources, [...compileArgs]);
}

/**
 * A file name from a request is a name, never a path.
 *
 * The request comes from the API, which builds it from a teacher's question —
 * but the runner trusts nothing it is sent: a `../../etc/passwd` would be a
 * write outside the work directory if anything downstream ever joined it to a
 * path. Everything outside `[A-Za-z0-9._-]` becomes `_`, the directory part is
 * dropped, and a leading `-` (which a compiler would read as an option) or `.`
 * is dropped too.
 */
export function sanitizeFileName(name: string, index: number): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[-.]+/, "");
  const capped = cleaned.slice(0, 64);
  return capped === "" ? `file${index}` : capped;
}

/**
 * `compileArgs` is one string on the wire and an argv here. Whitespace splits
 * it, and nothing else: no quoting, no globbing, no variable expansion, since
 * no shell ever sees it. At most 40 tokens, each at most 64 characters.
 */
export function splitCompileArgs(compileArgs: string): string[] {
  return compileArgs
    .split(/\s+/)
    .filter((token) => token !== "")
    .slice(0, 40)
    .map((token) => token.slice(0, 64));
}
