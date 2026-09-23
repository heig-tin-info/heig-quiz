/**
 * The feedback view of a `code` answer.
 *
 * Hidden cases are the whole point of this component: a student may see that
 * they exist and how many passed, but their names, inputs and expected outputs
 * stay closed unless the feedback policy opens them (decision D15). The
 * filtering itself happened server-side in `studentDetails`; this component
 * renders what it was given and never reconstructs a key.
 */
import { fmt, resolveStrings } from "@quiz/core/client";
import type { MarkdownRenderer, ReviewProps } from "@quiz/core/client";

import type { CodeAnswer, CodeCaseDetail, CodeDetails, CodeSolution, CodeStudent } from "./schema.js";
import { REVIEW_STRINGS, type CodeReviewStrings } from "./strings.js";
import { badge, card, cx, hint, lockedBlock, sectionTitle, table } from "./styles.js";
import { caseVerdict } from "./verdict.js";

interface CodeReviewProps
  extends ReviewProps<CodeStudent, CodeAnswer, CodeSolution, CodeDetails> {
  /** docs/06 Q8: the policy may name the hidden cases once the results are out. */
  showHiddenCaseNames?: boolean | undefined;
  strings?: Partial<CodeReviewStrings> | undefined;
  /** The host's sanitised markdown view; plain text when absent. */
  renderMarkdown?: MarkdownRenderer | undefined;
}

/** The case as the teacher wrote it, when the feedback policy sends the key. */
type CaseSpec = NonNullable<CodeSolution["cases"]>[number];

/**
 * Which check failed, not merely that one did.
 *
 * `gradings.details` stores the outcome, not the rule that judged it, so the
 * precise sentence is only available when the key travelled with it — the
 * teacher always, a student when the policy opens the solution. Without it the
 * verdict stays the honest, blunt "Failed".
 */
function verdictOf(
  detail: CodeCaseDetail,
  spec: CaseSpec | undefined,
  compare: CodeSolution["compare"] | undefined,
  s: CodeReviewStrings,
): string {
  if (detail.timedOut) return s.timedOut;
  if (detail.oom) return s.outOfMemory;
  // The STORED verdict is the grade's; it is never re-decided here.
  if (detail.ok) return s.passed;
  // Without the key, only the accidents can be named: a spec that checks
  // nothing leaves `caseVerdict` exactly those (audit R-06).
  const verdict = caseVerdict(
    spec ?? { expected: "", compareStdout: false, expectedExitCode: null },
    {
      exitCode: detail.exitCode,
      stdout: detail.actual ?? "",
      timedOut: detail.timedOut,
      oom: detail.oom,
      ms: detail.ms,
    },
    compare,
  );
  switch (verdict.failure) {
    case "crashed":
      return s.crashed;
    case "exit":
      return fmt(s.exitMismatch, { got: String(detail.exitCode), want: spec!.expectedExitCode! });
    case "output":
      return s.outputMismatch;
    default:
      // The grade failed a case whose every other check held, so it is the
      // output that differed — the stored text may be truncated and cannot
      // say so itself. With no output compared (or no key), stay blunt.
      return spec !== undefined && spec.compareStdout ? s.outputMismatch : s.failed;
  }
}

export function CodeReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  audience,
  showHiddenCaseNames,
  strings,
  renderMarkdown,
}: CodeReviewProps) {
  const s = resolveStrings(REVIEW_STRINGS, strings);
  const reveal = audience === "teacher" || showHiddenCaseNames === true;

  /* The statement, so a verdict is never read without the question it judges. */
  const statement = (
    <div className="whitespace-pre-wrap text-sm text-fg">
      {renderMarkdown ? renderMarkdown(student.prompt) : student.prompt}
    </div>
  );

  /*
   * `details` is whatever `gradings.details` holds: this type's breakdown, or
   * a grading-level marker with no `cases` at all — an absent answer, an
   * unreadable configuration, a grader that threw. Both read the same to a
   * student, and reading a marker as a breakdown is a blank page.
   */
  if (details === null || !Array.isArray(details.cases)) {
    return (
      <div className="flex flex-col gap-3">
        {statement}
        <p className={hint}>{answer === null ? s.notAnswered : s.runnerError}</p>
      </div>
    );
  }

  // The key, when it travelled: it is what turns "Failed" into "exit 1 ≠ 0".
  const specs = new Map<string, CaseSpec>((solution?.cases ?? []).map((c) => [c.name, c]));
  const shown = details.cases.filter((c) => c.visible || reveal);
  const hidden = details.cases.filter((c) => !c.visible && !reveal);
  const hiddenPassed = hidden.filter((c) => c.ok).length;

  return (
    <div className="flex flex-col gap-4">
      {statement}

      <div className="flex flex-wrap items-center gap-2">
        <span className={cx(sectionTitle, "tabular-nums")}>
          {fmt(s.score, { points: points ?? 0, max: maxPoints })}
        </span>
        {details.runner === "unavailable" ? (
          <span className={badge("warning")}>{s.runnerUnavailable}</span>
        ) : null}
        {details.runner === "busy" ? <span className={badge("warning")}>{s.runnerBusy}</span> : null}
        {details.runner === "error" ? <span className={badge("danger")}>{s.runnerError}</span> : null}
      </div>

      {details.compile !== null && !details.compile.ok ? (
        <section className={cx(card, "flex flex-col gap-2 p-4")}>
          <h3 className={cx(sectionTitle, "text-danger")}>{s.compileFailed}</h3>
          {details.compile.stderr === "" ? null : (
            <pre className={lockedBlock} aria-label={s.compilerOutput}>
              <code>{details.compile.stderr}</code>
            </pre>
          )}
        </section>
      ) : null}

      {shown.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className={table.table}>
            <caption className="sr-only">{s.cases}</caption>
            <thead className={table.head}>
              <tr>
                <th scope="col" className={table.th}>
                  {s.caseName}
                </th>
                <th scope="col" className={table.th}>
                  {s.args}
                </th>
                <th scope="col" className={table.th}>
                  {s.expected}
                </th>
                <th scope="col" className={table.th}>
                  {s.got}
                </th>
                <th scope="col" className={table.th}>
                  {s.verdict}
                </th>
                <th scope="col" className={cx(table.th, "text-right")}>
                  {s.points}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((detail, i) => {
                const spec = specs.get(detail.name);
                return (
                <tr key={i} className={table.row}>
                  <td className={cx(table.td, "font-medium")}>
                    {detail.name}
                    {detail.visible ? null : (
                      <span className={badge("neutral", "ml-2")}>{s.hiddenCase}</span>
                    )}
                  </td>
                  <td className={cx(table.td, "whitespace-pre-wrap font-mono")}>
                    {spec === undefined || (spec.args ?? []).length === 0
                      ? s.noArgs
                      : spec.args.join(" ")}
                  </td>
                  <td className={cx(table.td, "whitespace-pre-wrap font-mono")}>
                    {detail.expected ?? "—"}
                  </td>
                  <td className={cx(table.td, "whitespace-pre-wrap font-mono")}>
                    {detail.actual ?? "—"}
                  </td>
                  <td className={table.td}>
                    <span className={badge(detail.ok ? "success" : "danger")}>
                      {verdictOf(detail, spec, solution?.compare, s)}
                    </span>
                  </td>
                  <td className={cx(table.td, "text-right tabular-nums")}>
                    {detail.ok ? detail.points : 0} / {detail.points}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hidden.length > 0 ? (
        <p className={hint}>{fmt(s.hiddenSummary, { passed: hiddenPassed, count: hidden.length })}</p>
      ) : null}

      {solution !== null && solution.referenceSolution !== "" ? (
        <section className={cx(card, "flex flex-col gap-2 p-4")}>
          <h3 className={sectionTitle}>{s.referenceSolution}</h3>
          <pre className={lockedBlock}>
            <code>{solution.referenceSolution}</code>
          </pre>
        </section>
      ) : null}
    </div>
  );
}

export default CodeReview;
