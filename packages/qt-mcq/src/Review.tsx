/**
 * The `mcq` review: the verdict CHOICE BY CHOICE, never a bare score.
 *
 * What it may show is decided upstream: `solution` is `null` when the feedback
 * policy hides the key, and the component then shows what the student ticked
 * without ever guessing the rest.
 */
import type { MarkdownRenderer, ReviewProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import type { McqAnswer, McqDetails, McqSolution, McqStudent } from "./schema.js";
import { mcqReviewStrings, type McqReviewStringKey } from "./strings.js";
import { cx, helpClass } from "./ui.js";

export type McqReviewProps = ReviewProps<McqStudent, McqAnswer, McqSolution, McqDetails> & {
  strings?: StringOverrides<McqReviewStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

const badgeClass = "inline-flex h-5.5 items-center rounded-full px-2 text-xs font-medium";

export function McqReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  strings,
  renderMarkdown,
}: McqReviewProps) {
  const s = resolveStrings(mcqReviewStrings, strings);
  const selected = answer?.selected ?? [];
  const key = solution === null ? null : new Set(solution.correct);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg">
        {renderMarkdown ? renderMarkdown(student.prompt) : student.prompt}
      </p>

      <ul className="flex flex-col gap-1.5">
        {student.choices.map((choice) => {
          const chosen = selected.includes(choice.id);
          const correct = key === null ? null : key.has(choice.id);
          const verdict =
            correct === null
              ? chosen
                ? { tone: "bg-surface-3 text-fg-muted", label: s.chosen }
                : null
              : chosen && correct
                ? { tone: "bg-success-soft text-success", label: s.correct }
                : chosen && !correct
                  ? { tone: "bg-danger-soft text-danger", label: s.incorrect }
                  : !chosen && correct
                    ? { tone: "bg-warning-soft text-warning", label: s.missed }
                    : null;
          return (
            <li
              key={choice.id}
              className={cx(
                "flex items-start justify-between gap-3 rounded-xl border px-3 py-2 text-sm",
                chosen ? "border-line-strong bg-surface-2" : "border-line bg-surface",
              )}
            >
              <span className="min-w-0">
                {renderMarkdown ? renderMarkdown(choice.text) : choice.text}
              </span>
              {verdict ? <span className={cx(badgeClass, verdict.tone)}>{verdict.label}</span> : null}
            </li>
          );
        })}
      </ul>

      {selected.length === 0 ? <p className={helpClass}>{s.noAnswer}</p> : null}

      <p className="text-sm text-fg-muted">
        <span className="font-medium text-fg">{s.score}</span>{" "}
        <span className="tabular-nums">
          {points === null ? "—" : points} / {maxPoints}
        </span>
        {details ? (
          <span className="ml-2 text-fg-faint">
            · {s.breakdown} {details.c}/{details.C} · {s.wrongTicked} {details.w}/{details.W}
          </span>
        ) : null}
      </p>
      {details?.truncated ? <p className={helpClass}>{s.truncated}</p> : null}
    </div>
  );
}
