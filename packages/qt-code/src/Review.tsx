/**
 * The feedback view of a `code` answer.
 *
 * Hidden cases are the whole point of this component: a student may see that
 * they exist and how many passed, but their names, inputs and expected outputs
 * stay closed unless the feedback policy opens them (decision D15). The
 * filtering itself happened server-side in `studentDetails`; this component
 * renders what it was given and never reconstructs a key.
 */
import { useId, useState } from "react";

import { fmt, resolveStrings, showsSection } from "@quiz/core/client";
import type { ReviewProps } from "@quiz/core/client";

import type { CodeAnswer, CodeCaseDetail, CodeDetails, CodeSolution, CodeStudent } from "./schema.js";
import { CompileFailure, NoBreakdown, ReferenceSolutionCard, ScoreLine } from "./ProgramReview.js";
import { REVIEW_STRINGS, type CodeReviewStrings } from "./strings.js";
import {
  badge,
  breakdownOf,
  cx,
  hint,
  OutputCells,
  OutputControls,
  OutputHeads,
  ReviewPrompt,
  table,
  TableHead,
  Th,
  useOutputMode,
  Verdict,
  verdictTone,
} from "@quiz/ui";
import { caseVerdict } from "./verdict.js";

interface CodeReviewProps
  extends ReviewProps<CodeStudent, CodeAnswer, CodeSolution, CodeDetails> {
  /** docs/06 Q8: the policy may name the hidden cases once the results are out. */
  showHiddenCaseNames?: boolean | undefined;
  strings?: Partial<CodeReviewStrings> | undefined;
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
  sections,
  showHiddenCaseNames,
  strings,
  renderMarkdown,
}: CodeReviewProps) {
  const s = resolveStrings(REVIEW_STRINGS, strings);
  const reveal = audience === "teacher" || showHiddenCaseNames === true;
  /** How the cases' outputs are read: side by side or as a diff (#553). */
  const [outputMode, setOutputMode] = useOutputMode();
  const [showWhitespace, setShowWhitespace] = useState(false);
  const controlsName = useId();
  // The grade's comparison options: the key's when it travelled, the student view's otherwise.
  const compare = solution?.compare ?? student.compare;

  /* The statement, so a verdict is never read without the question it judges —
     unless the reader chose to hide it (#109). The cases table stays either
     way: its expected column is what the run was judged against, the
     verdict itself, not the solution. */
  const statement = (
    <ReviewPrompt preWrap prompt={student.prompt} sections={sections} renderMarkdown={renderMarkdown} />
  );

  const breakdown = breakdownOf(details, "cases");
  if (breakdown === null) return <NoBreakdown statement={statement} answered={answer !== null} s={s} />;

  // The key, when it travelled: it is what turns "Failed" into "exit 1 ≠ 0".
  const specs = new Map<string, CaseSpec>((solution?.cases ?? []).map((c) => [c.name, c]));
  const shown = breakdown.cases.filter((c) => c.visible || reveal);
  const hidden = breakdown.cases.filter((c) => !c.visible && !reveal);
  const hiddenPassed = hidden.filter((c) => c.ok).length;

  return (
    <div className="flex flex-col gap-4">
      {statement}

      <ScoreLine points={points} maxPoints={maxPoints} runner={breakdown.runner} s={s} />

      <CompileFailure compile={breakdown.compile} s={s} />

      {shown.some((c) => c.expected !== undefined && c.actual !== undefined) ? (
        <div className="flex justify-end">
          <OutputControls
            name={controlsName}
            mode={outputMode}
            onMode={setOutputMode}
            showWhitespace={showWhitespace}
            onShowWhitespace={setShowWhitespace}
            strings={s}
          />
        </div>
      ) : null}

      {shown.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className={table.table}>
            <caption className="sr-only">{s.cases}</caption>
            <TableHead>
              <Th>{s.caseName}</Th>
              <Th>{s.args}</Th>
              <OutputHeads mode={outputMode} strings={s} className={table.th} />
              <Th>{s.verdict}</Th>
              <Th right>{s.points}</Th>
            </TableHead>
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
                  <OutputCells
                    mode={outputMode}
                    expected={detail.expected ?? null}
                    expectedFallback="—"
                    actual={detail.actual ?? null}
                    ok={detail.ok}
                    compare={compare}
                    showWhitespace={showWhitespace}
                    strings={s}
                    className={cx(table.td, "whitespace-pre-wrap font-mono")}
                  />
                  <td className={table.td}>
                    <Verdict tone={verdictTone(detail.ok)}>
                      {verdictOf(detail, spec, solution?.compare, s)}
                    </Verdict>
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

      {showsSection(sections, "solution") ? <ReferenceSolutionCard solution={solution} s={s} /> : null}
    </div>
  );
}

export default CodeReview;
