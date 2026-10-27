/**
 * What a project's LLM pass sends (ADR-106 §4): the llm criteria of a
 * snapshot ({@link llmLeaves}) and the repository's evidence rendered as
 * the model reads it — a schema-2 snapshot's runner evidence
 * ({@link renderMaterial}), a schema-3 snapshot's sources and CI logs
 * ({@link renderCiMaterial}, ADR-119 §7) — every piece masked BEFORE any
 * cut so that no truncated fragment of a name, an address or a login
 * escapes the mask (N-DATA-05). Pure: the `project` module loads and calls.
 */
import { classifyCriterion, type CriteriaLeaf, type CriterionSettings } from "./criteria.js";
import { REPORT_FILE, sourcePaths, type JunitCase } from "./evidence.js";

/**
 * The llm criteria of a snapshot under the project's tests and identity
 * criteria (a schema-2 snapshot; null for a schema-3 one, `classifyCriterion`):
 * an identity criterion never is one.
 */
export function llmLeaves(leaves: readonly CriteriaLeaf[], settings: CriterionSettings | null): CriteriaLeaf[] {
  return leaves.filter((leaf) => classifyCriterion(leaf, settings) === "llm");
}

/** One step of an evidence run, as the material reads it. */
export interface MaterialStep {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** An evidence row, as the material reads it. */
export interface MaterialEvidence {
  cases: readonly JunitCase[] | null;
  build: MaterialStep | null;
  test: MaterialStep | null;
  files: Readonly<Record<string, { content: string; truncated: boolean }>> | null;
}

/** What one file, one step's output, and the whole material may weigh in characters. */
export const MATERIAL_LIMITS = { file: 30_000, output: 4_000, log: 8_000, material: 150_000, failures: 50 } as const;

/** The end of a step's output, where the error is. */
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);
const head = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

/**
 * The repository's material: the test summary and its failures, the steps'
 * exit codes and outputs, then the output files the sources name (the
 * JUnit report aside), each piece passed through `mask` before it is cut
 * to its limit.
 */
export function renderMaterial(evidence: MaterialEvidence, sources: readonly string[], mask: (text: string) => string): string {
  const parts: string[] = [];
  const cases = evidence.cases ?? [];
  const failed = cases.filter((c) => !c.passed);
  parts.push(`Tests: ${cases.length - failed.length} of ${cases.length} passed.`);
  if (failed.length > 0) {
    const lines = failed
      .slice(0, MATERIAL_LIMITS.failures)
      .map((c) => mask(`- ${c.classname ? `${c.classname}.` : ""}${c.name}${c.message ? `: ${c.message}` : ""}`));
    parts.push(`Failed tests:\n${lines.join("\n")}`);
  }
  for (const [label, step] of [["Build", evidence.build], ["Test", evidence.test]] as const) {
    if (!step) continue;
    const out = [
      step.stdout && `stdout:\n${tail(mask(step.stdout), MATERIAL_LIMITS.output)}`,
      step.stderr && `stderr:\n${tail(mask(step.stderr), MATERIAL_LIMITS.output)}`,
    ].filter(Boolean);
    parts.push(`${label} step: exit code ${step.exitCode}${step.timedOut ? " (timed out)" : ""}\n${out.join("\n")}`);
  }
  const files = evidence.files ?? {};
  for (const path of sourcePaths(sources, Object.keys(files).filter((p) => p !== REPORT_FILE))) {
    const file = files[path]!;
    const content = head(mask(file.content), MATERIAL_LIMITS.file);
    parts.push(`File ${mask(path)}${file.truncated ? " (truncated)" : ""}:\n\`\`\`\n${content}\n\`\`\``);
  }
  return head(parts.join("\n\n"), MATERIAL_LIMITS.material);
}

/** A schema-3 pass's material (ADR-119 §7), as the `project` module reads it. */
export interface CiMaterialInput {
  /** The repository's text files at the target commit, by path (the tarball's root stripped). */
  files: Readonly<Record<string, string>>;
  /** The `log` of each automatic criterion of the pass in the accepted `results.json`; null when the pass accepted no run. */
  logs: readonly { id: string; log: string }[] | null;
}

/**
 * A GitHub-hosted runner's checkout, `/home/runner/work/<repo>/<repo>`: it
 * names the repository (N-DATA-05), so it goes whatever the repository's
 * name became.
 */
const RUNNER_WORKSPACE = /\/home\/runner\/work\/[^/\s]+\/[^/\s]+/g;

/**
 * `text` fenced as quoted material: the fence a run of backticks longer
 * than any inside, so nothing in a file or a log can close it early and
 * pass for the prompt's own words.
 */
export function quoted(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * A schema-3 repository's material (ADR-119 §7): the logs of the CI's
 * checks — or, when the pass accepted no run, that the sources are judged
 * alone — then the files the sources name; each piece masked (the runner's
 * workspace path first), then cut, then quoted. Never a commit's metadata:
 * the caller hands none.
 */
export function renderCiMaterial(input: CiMaterialInput, sources: readonly string[], mask: (text: string) => string): string {
  const clean = (text: string) => mask(text.replace(RUNNER_WORKSPACE, "<workspace>"));
  const parts: string[] = [];
  if (input.logs === null) parts.push("CI checks: no accepted result for this pass. Judge the sources alone.");
  else parts.push(input.logs.length === 0 ? "CI checks: no log." : "CI checks: the logs of their commands, quoted.");
  for (const { id, log } of input.logs ?? []) parts.push(`Log of ${id}:\n${quoted(tail(clean(log), MATERIAL_LIMITS.log))}`);
  // Whole quoted pieces only, so the cap never leaves a fence open.
  let size = parts.reduce((n, part) => n + part.length + 2, 0);
  for (const path of sourcePaths(sources, Object.keys(input.files))) {
    const part = `File ${clean(path)}:\n${quoted(head(clean(input.files[path]!), MATERIAL_LIMITS.file))}`;
    if (size + part.length > MATERIAL_LIMITS.material) {
      parts.push("More files are left out: the material is full.");
      break;
    }
    parts.push(part);
    size += part.length + 2;
  }
  return parts.join("\n\n");
}
