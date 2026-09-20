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
import { cx, helpClass } from "./ui.js";

export type ClozeReviewProps = ReviewProps<
  ClozeStudent,
  ClozeAnswer,
  ClozeSolution,
  ClozeDetails
> & {
  strings?: StringOverrides<ClozeReviewStringKey>;
  renderText?: ClozeTextRenderer;
};

const badgeClass = "inline-flex h-5.5 items-center rounded-full px-2 text-xs font-medium";

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
  /*
   * `details` comes off the wire as whatever `gradings.details` holds, which
   * is this type's breakdown OR a grading-level marker (an unreadable
   * configuration, a grader that threw). A marker has no `perBlank`, and
   * reading it as one is a crash on a page whose whole job is to reassure.
   * Without verdicts the blanks simply read neutral, which is honest.
   */
  const perBlank = Array.isArray(details?.perBlank) ? details.perBlank : [];
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
                    <span
                      className={cx(
                        badgeClass,
                        "ml-2",
                        verdict.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                      )}
                    >
                      {verdict.ok ? s.correct : s.incorrect}
                    </span>
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

      <p className="text-sm text-fg-muted">
        <span className="font-medium text-fg">{s.score}</span>{" "}
        <span className="tabular-nums">
          {points === null ? "—" : points} / {maxPoints}
        </span>
        {typeof details?.total === "number" ? (
          <span className="ml-2 text-fg-faint">
            · {s.weights} {details.earned}/{details.total}
          </span>
        ) : null}
      </p>
    </div>
  );
}
