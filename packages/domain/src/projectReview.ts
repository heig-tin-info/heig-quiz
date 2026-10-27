/**
 * What a project's LLM pass sends (ADR-106 §4): the llm criteria of a
 * snapshot ({@link llmLeaves}) and the repository's evidence rendered as
 * the model reads it — a schema-2 snapshot's runner evidence
 * ({@link renderMaterial}), a schema-3 snapshot's sources and CI logs
 * ({@link renderCiMaterial}, ADR-119 §7) — every piece masked BEFORE any
 * cut so that no truncated fragment of a name, an address or a login
 * escapes the mask (N-DATA-05), and every file or log quoted whole
 * ({@link quoted}, {@link whole}). Pure: the `project` module loads and calls.
 */
import { TRUNCATED_MARK, type CheckResults } from "./checkResults.js";
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

/** A file of the material: its content and whether its producer already cut it. */
export interface MaterialFile {
  content: string;
  truncated: boolean;
}

/** An evidence row, as the material reads it. */
export interface MaterialEvidence {
  cases: readonly JunitCase[] | null;
  build: MaterialStep | null;
  test: MaterialStep | null;
  files: Readonly<Record<string, MaterialFile>> | null;
}

/** What one file, one step's output, one log and the whole material may weigh in characters. */
export const MATERIAL_LIMITS = { file: 30_000, output: 4_000, log: 8_000, material: 150_000, failures: 50 } as const;

/** The end of a step's output, where the error is. */
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);
const head = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

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

/** The line that ends a material whose pieces did not all fit. */
export const LEFT_OUT = "More is left out: the material is full.";

/**
 * `pieces`, whole, as many as fit in `budget` characters once joined by
 * blank lines, then {@link LEFT_OUT} when one did not — within the budget
 * too. Never a piece cut: a cut could leave a fence open.
 */
export function whole(pieces: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let size = 0;
  const reserve = LEFT_OUT.length + 2;
  for (const piece of pieces) {
    const cost = piece.length + (out.length > 0 ? 2 : 0);
    if (size + cost + reserve > budget) {
      out.push(LEFT_OUT);
      break;
    }
    out.push(piece);
    size += cost;
  }
  return out;
}

/** The files the sources name, in their order, each `clean`ed, then cut to its limit, then quoted. */
function filePieces(files: Readonly<Record<string, MaterialFile>>, sources: readonly string[], clean: (text: string) => string): string[] {
  return sourcePaths(sources, Object.keys(files)).map((path) => {
    const file = files[path]!;
    return `File ${clean(path)}${file.truncated ? " (truncated)" : ""}:\n${quoted(head(clean(file.content), MATERIAL_LIMITS.file))}`;
  });
}

/**
 * The repository's material: the test summary and its failures, the steps'
 * exit codes and outputs, then the output files the sources name (the
 * JUnit report aside), each piece passed through `mask` before it is cut
 * to its limit, the files quoted whole within the material's cap.
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
  // The summary is bounded by its own limits (50 failures, two outputs of 4 000), far under the cap: the files take what remains, whole.
  const summary = parts.join("\n\n");
  const files = Object.fromEntries(Object.entries(evidence.files ?? {}).filter(([path]) => path !== REPORT_FILE));
  return [summary, ...whole(filePieces(files, sources, mask), MATERIAL_LIMITS.material - summary.length - 2)].join("\n\n");
}

/** A log of a schema-3 pass: its criterion and its text, as `results.json` gave it (cut to its tail at the intake). */
export interface CiLog {
  id: string;
  log: string;
}

/**
 * The logs the model reads (ADR-119 §7): those of the pass's automatic
 * criteria (`classifyCriterion`, schema 3) in the accepted `results.json`,
 * in the criteria's order; null when the pass accepted no run.
 */
export function ciLogs(leaves: readonly CriteriaLeaf[], results: CheckResults | null): CiLog[] | null {
  if (results === null) return null;
  return leaves.flatMap((leaf) => {
    const log = classifyCriterion(leaf, null) === "automatic" ? results.criteria[leaf.id]?.log : undefined;
    return log ? [{ id: leaf.id, log }] : [];
  });
}

/**
 * A log cut at the intake (`tailUtf8`, {@link TRUNCATED_MARK}) was cut
 * BEFORE any mask: its first line may start inside a name or an address
 * that the mask no longer recognises. That line goes, whole.
 */
export function untruncated(log: string): string {
  if (!log.startsWith(TRUNCATED_MARK)) return log;
  const rest = log.slice(TRUNCATED_MARK.length);
  const newline = rest.indexOf("\n");
  return `${TRUNCATED_MARK}${newline < 0 ? "" : rest.slice(newline + 1)}`;
}

/** A schema-3 pass's material (ADR-119 §7), as the `project` module reads it. */
export interface CiMaterialInput {
  /** The repository's text files at the target commit the sources name, by path (the tarball's root stripped). */
  files: Readonly<Record<string, string>>;
  /** {@link ciLogs}: null when the pass accepted no run. */
  logs: readonly CiLog[] | null;
}

/**
 * A GitHub-hosted runner's checkout, `/home/runner/work/<repo>/<repo>`: it
 * names the repository (N-DATA-05), so it goes whatever the repository's
 * name became.
 */
const RUNNER_WORKSPACE = /\/home\/runner\/work\/[^/\s]+\/[^/\s]+/g;

/**
 * A schema-3 repository's material (ADR-119 §7): the logs of the CI's
 * checks — or, when the pass accepted no run, that the sources are judged
 * alone — then the files the sources name; each piece masked (the runner's
 * workspace path first, a log's cut first line dropped), then cut, then
 * quoted, whole within the material's cap. Never a commit's metadata: the
 * caller hands none.
 */
export function renderCiMaterial(input: CiMaterialInput, sources: readonly string[], mask: (text: string) => string): string {
  const clean = (text: string) => mask(text.replace(RUNNER_WORKSPACE, "<workspace>"));
  const statement =
    input.logs === null
      ? "CI checks: no accepted result for this pass. Judge the sources alone."
      : input.logs.length === 0
        ? "CI checks: no log."
        : "CI checks: the logs of their commands, quoted.";
  const logs = (input.logs ?? []).map(({ id, log }) => `Log of ${id}:\n${quoted(tail(clean(untruncated(log)), MATERIAL_LIMITS.log))}`);
  const files = filePieces(
    Object.fromEntries(Object.entries(input.files).map(([path, content]) => [path, { content, truncated: false }])),
    sources,
    clean,
  );
  return [statement, ...whole([...logs, ...files], MATERIAL_LIMITS.material - statement.length - 2)].join("\n\n");
}
