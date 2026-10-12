/**
 * What a project's LLM pass sends (ADR-106 §4): the llm criteria of a
 * snapshot ({@link llmLeaves}) and the repository's evidence rendered as
 * the model reads it ({@link renderMaterial}), every piece masked BEFORE
 * any cut so that no truncated fragment of a name, an address or a login
 * escapes the mask (N-DATA-05). Pure: the `project` module loads and calls.
 */
import { classifyCriterion, type CriteriaLeaf, type CriterionSettings } from "./criteria.js";
import { REPORT_FILE, sourcePaths, type JunitCase } from "./evidence.js";

/** The llm criteria of a snapshot under the project's tests and identity criteria: an identity criterion never is one. */
export function llmLeaves(leaves: readonly CriteriaLeaf[], settings: CriterionSettings): CriteriaLeaf[] {
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
export const MATERIAL_LIMITS = { file: 30_000, output: 4_000, material: 150_000, failures: 50 } as const;

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
