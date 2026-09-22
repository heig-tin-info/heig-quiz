/**
 * The `short` review: WHICH matcher accepted the answer, not a bare score.
 *
 * `solution` is `null` when the feedback policy hides the key; the component
 * then shows the verdict without the accepted answers.
 */
import type { MarkdownRenderer, ReviewProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import type { ShortAnswer, ShortDetails, ShortSolution, ShortStudent } from "./schema.js";
import { shortReviewStrings, type ShortReviewStringKey } from "./strings.js";
import { cx, helpClass } from "./ui.js";

type ShortReviewProps = ReviewProps<
  ShortStudent,
  ShortAnswer,
  ShortSolution,
  ShortDetails
> & {
  strings?: StringOverrides<ShortReviewStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

const badgeClass = "inline-flex h-5.5 items-center rounded-full px-2 text-xs font-medium";

export function ShortReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  strings,
  renderMarkdown,
}: ShortReviewProps) {
  const s = resolveStrings(shortReviewStrings, strings);
  const given = answer?.text ?? "";
  const fraction = details?.fraction ?? null;
  const verdict =
    fraction === null
      ? null
      : fraction >= 1
        ? { tone: "bg-success-soft text-success", label: s.accepted }
        : fraction > 0
          ? { tone: "bg-warning-soft text-warning", label: s.partially }
          : { tone: "bg-danger-soft text-danger", label: s.rejected };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg">
        {renderMarkdown ? renderMarkdown(student.prompt) : student.prompt}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-fg">{s.yourAnswer}</span>
        {given === "" ? (
          <span className={helpClass}>{s.noAnswer}</span>
        ) : (
          <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[13px] text-fg">
            {given}
          </code>
        )}
        {verdict ? <span className={cx(badgeClass, verdict.tone)}>{verdict.label}</span> : null}
      </div>

      {typeof details?.matchedIndex === "number" ? (
        <p className={helpClass}>
          {s.matchedBy} #{details.matchedIndex + 1} · {details.matchedKind}
        </p>
      ) : null}

      {solution !== null && solution.expected.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium text-fg">{s.expected}</span>
          <ul className="flex flex-wrap gap-1.5">
            {solution.expected.map((expected, i) => (
              <li
                key={`${expected}-${i}`}
                className="rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-xs text-fg-muted"
              >
                {expected}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-sm text-fg-muted">
        <span className="font-medium text-fg">{s.score}</span>{" "}
        <span className="tabular-nums">
          {points === null ? "—" : points} / {maxPoints}
        </span>
      </p>
    </div>
  );
}
