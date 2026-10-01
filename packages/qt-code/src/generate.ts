/**
 * "Generate answers" for a code question (ADR-059 §7): the model writes the
 * reference solution and the test INPUTS; the expected outputs are computed
 * by running the reference on the runner (`settle`), never taken from the
 * model. The merge keeps the teacher's reference and cases: the reference is
 * written only when empty and only when it fits the template's regions, the
 * empty placeholder case goes, the proposed cases are appended.
 */
import { z } from "zod";

import type { AnswerGenerator, RunnerOutcome, RunnerService } from "@quiz/core/server";

import { assembleCodeSource, buildRunnerRequest } from "./grade.js";
import { referenceRegions } from "./reference.js";
import { emptyCodeCase, type CodeCase, type CodeConfig, type ProgramConfig } from "./schema.js";

const MAX_CASES = 30;

const blank = (text: unknown) => (typeof text === "string" ? text : "").trim() === "";
const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

/**
 * The rules every program question shares (`code` and `codeimage`): how the
 * reference fits a locked template.
 */
export const REFERENCE_RULES = [
  "`language` is the program's language and `template` the file the student starts from: the lines between",
  "`@@lock` and `@@endlock` are fixed, the rest is editable. Write `referenceSolution` as the content of the",
  "EDITABLE regions only, in order, separated by a line `// @@next` (`# @@next` in Python) when there are",
  "several; with an empty template or no lock, it is the whole program. It must compile and be correct:",
  "the platform runs it to compute what the question checks. Never rewrite a reference the draft already has",
  "(leave it empty then).",
].join(" ");

/** The proposed reference, when the draft has none and it fits the template; else the draft's. */
export function mergeReference<C extends ProgramConfig>(config: C, proposed: string): C {
  if (!blank(config.referenceSolution) || blank(proposed)) return config;
  const next = { ...config, referenceSolution: proposed };
  return referenceRegions(next) === null ? config : next;
}

/** A run whose stdout is the whole of what the program printed: it neither timed out, ran out of memory, nor was cut. */
export const usableRun = (run: RunnerOutcome["cases"][number] | undefined): run is RunnerOutcome["cases"][number] =>
  run !== undefined && !run.timedOut && !run.oom && !run.truncated;

/** The reference's regions, or null when there is no reference to run or it does not fit. */
export function runnableReference(config: ProgramConfig): string[] | null {
  return blank(config.referenceSolution) ? null : referenceRegions(config);
}

const CodeProposal = z.object({
  referenceSolution: z.string(),
  cases: z.array(
    z.object({ name: z.string(), stdin: z.string(), args: z.array(z.string()), visible: z.boolean() }),
  ),
});
type CodeProposal = z.infer<typeof CodeProposal>;

/** The placeholder of a fresh draft, or a case the teacher cleared. */
const isEmptyCase = (c: CodeCase) => blank(c.name) && blank(c.stdin) && blank(c.expected) && list(c.args).length === 0;

export function mergeCode(config: CodeConfig, proposal: CodeProposal): CodeConfig {
  const withReference = mergeReference(config, proposal.referenceSolution);
  const kept = list(config.tests?.cases).filter((c) => !isEmptyCase(c));
  const names = new Set(kept.map((c) => c.name.trim().toLowerCase()));
  const added: CodeCase[] = [];
  for (const proposed of proposal.cases) {
    if (kept.length + added.length >= MAX_CASES) break;
    const name = proposed.name.trim().slice(0, 60);
    if (!name || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    added.push(
      emptyCodeCase({
        name,
        stdin: proposed.stdin.slice(0, 16_000),
        args: proposed.args.slice(0, 32).map((a) => a.slice(0, 200)),
        visible: proposed.visible,
      }),
    );
  }
  if (added.length === 0) return withReference;
  return { ...withReference, tests: { ...withReference.tests, cases: [...kept, ...added] } };
}

/**
 * Runs the reference on every case whose expected output is empty and that
 * compares stdout, and writes what it printed — and its exit code when it is
 * not 0. A case that timed out, ran out of memory or was cut keeps its empty
 * output, and the result says `partial`.
 */
export async function settleCode(
  config: CodeConfig,
  runner: RunnerService,
): Promise<{ config: CodeConfig; incomplete?: "compile_failed" | "partial" }> {
  const regions = runnableReference(config);
  const cases = list(config.tests?.cases);
  const targets = cases.flatMap((c, i) => (c.compareStdout && c.expected === "" && !blank(c.name) ? [i] : []));
  if (regions === null || targets.length === 0) return { config };
  const outcome = await runner.run(
    buildRunnerRequest(config, assembleCodeSource(config, { regions }), {
      priority: "interactive",
      cases: targets.map((i) => cases[i]!),
    }),
  );
  if (!outcome.compile.ok) return { config, incomplete: "compile_failed" };
  const filled = [...cases];
  let missed = false;
  targets.forEach((caseIndex, runIndex) => {
    const run = outcome.cases[runIndex];
    if (!usableRun(run)) {
      missed = true;
      return;
    }
    filled[caseIndex] = {
      ...filled[caseIndex]!,
      expected: run.stdout,
      ...(run.exitCode !== null && run.exitCode !== 0 ? { expectedExitCode: run.exitCode } : {}),
    };
  });
  const settled = { ...config, tests: { ...config.tests, cases: filled } };
  return missed ? { config: settled, incomplete: "partial" } : { config: settled };
}

export const codeGenerator: AnswerGenerator<CodeConfig, CodeProposal> = {
  statement: (config) => config.prompt ?? "",
  instructions: [
    "The question is a programming exercise, graded by running the student's program on test cases.",
    REFERENCE_RULES,
    "Propose `cases`: 4 to 8 test cases, each with a short `name` (at most 60 characters), what the program",
    "reads on `stdin` and its command-line `args`, and `visible` — a few visible cases the student can run,",
    "the rest hidden, covering the edge cases. Do NOT write expected outputs: the platform computes them by",
    "running the reference. Never repeat a case the draft holds.",
  ].join(" "),
  proposalSchema: CodeProposal,
  merge: mergeCode,
  settle: settleCode,
};
