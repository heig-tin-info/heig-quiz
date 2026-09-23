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
import { ScoreHeader, Verdict, type BadgeTone } from "@quiz/ui";
import { helpClass } from "./ui.js";

type ShortReviewProps = ReviewProps<
  ShortStudent,
  ShortAnswer,
  ShortSolution,
  ShortDetails
> & {
  strings?: StringOverrides<ShortReviewStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

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
  const verdict: { tone: BadgeTone; label: string } | null =
    fraction === null
      ? null
      : fraction >= 1
        ? { tone: "success", label: s.accepted }
        : fraction > 0
          ? { tone: "warning", label: s.partially }
          : { tone: "danger", label: s.rejected };

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
        {verdict ? <Verdict tone={verdict.tone}>{verdict.label}</Verdict> : null}
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

      <ScoreHeader label={s.score} points={points} maxPoints={maxPoints} />
    </div>
  );
}
