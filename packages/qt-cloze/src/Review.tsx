/**
 * The `cloze` review: the verdict BLANK BY BLANK, never a bare score.
 *
 * The text is shown once with each blank replaced by what the student typed,
 * then a table gives the verdict and — when the feedback policy allows it — the
 * expected answer. `details.expected` is teacher-facing: the results endpoint
 * strips it for a student unless the key is revealed.
 */
import type { ReviewProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import type { ClozeAnswer, ClozeDetails, ClozeSolution, ClozeStudent } from "./schema.js";
import { clozeReviewStrings, type ClozeReviewStringKey } from "./strings.js";
import { ClozeFallbackText, type ClozeTextRenderer } from "./text.js";
import { breakdownOf, cx, helpClass, ScoreHeader, Verdict, verdictTone } from "@quiz/ui";

type ClozeReviewProps = ReviewProps<
  ClozeStudent,
  ClozeAnswer,
  ClozeSolution,
  ClozeDetails
> & {
  strings?: StringOverrides<ClozeReviewStringKey>;
  renderText?: ClozeTextRenderer;
};

/** What the student wrote, as a reader sees it: the label for a dropdown. */
function givenLabel(student: ClozeStudent, index: number, given: string | null): string | null {
  if (given === null || given === "") return null;
  const blank = student.blanks.find((b) => b.index === index);
  if (blank?.kind !== "select") return given;
  return blank.options.find((option) => option.id === Number(given))?.label ?? given;
}

export function ClozeReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  strings,
  renderText,
}: ClozeReviewProps) {
  const s = resolveStrings(clozeReviewStrings, strings);
  const given = answer?.blanks ?? [];
  // Without a breakdown the blanks simply read neutral, which is honest.
  const perBlank = breakdownOf(details, "perBlank")?.perBlank ?? [];
  const verdicts = new Map(perBlank.map((blank) => [blank.index, blank]));
  const expected = new Map(solution?.blanks.map((blank) => [blank.index, blank.expected]) ?? []);
  const Text = renderText ?? ClozeFallbackText;

  return (
    <div className="flex flex-col gap-4">
      <Text
        template={student.template}
        renderBlank={(index) => {
          const label = givenLabel(student, index, given[index] ?? null);
          const ok = verdicts.get(index)?.ok;
          return (
            <span
              className={cx(
                "mx-0.5 rounded px-1.5 py-0.5 font-mono text-[0.9em]",
                ok === undefined
                  ? "bg-surface-3 text-fg"
                  : ok
                    ? "bg-success-soft text-success"
                    : "bg-danger-soft text-danger",
              )}
            >
              {label ?? "…"}
            </span>
          );
        }}
      />

      <table className="w-full text-left text-[13px]">
        <thead className="text-fg-faint">
          <tr>
            <th className="py-1 pr-3 font-medium">{s.blank}</th>
            <th className="py-1 pr-3 font-medium">{s.yourAnswer}</th>
            {expected.size > 0 ? <th className="py-1 font-medium">{s.expected}</th> : null}
          </tr>
        </thead>
        <tbody>
          {student.blanks.map((blank) => {
            const verdict = verdicts.get(blank.index);
            const label = givenLabel(student, blank.index, given[blank.index] ?? null);
            return (
              <tr key={blank.index} className="border-t border-line">
                <td className="py-1 pr-3 tabular-nums text-fg-muted">{blank.index + 1}</td>
                <td className="py-1 pr-3">
                  {label === null ? (
                    <span className={helpClass}>{s.noAnswer}</span>
                  ) : (
                    <span className="font-mono text-fg">{label}</span>
                  )}
                  {verdict ? (
                    <Verdict tone={verdictTone(verdict.ok)} className="ml-2">
                      {verdict.ok ? s.correct : s.incorrect}
                    </Verdict>
                  ) : null}
                </td>
                {expected.size > 0 ? (
                  <td className="py-1 font-mono text-fg-muted">{expected.get(blank.index) ?? "—"}</td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>

      <ScoreHeader label={s.score} points={points} maxPoints={maxPoints}>
        {typeof details?.total === "number" ? (
          <span className="ml-2 text-fg-faint">
            · {s.weights} {details.earned}/{details.total}
          </span>
        ) : null}
      </ScoreHeader>
    </div>
  );
}
