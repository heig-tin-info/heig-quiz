/**
 * The `mcq` review: the verdict CHOICE BY CHOICE, never a bare score.
 *
 * What it may show is decided upstream: `solution` is `null` when the feedback
 * policy hides the key, and the component then shows what the student ticked
 * without ever guessing the rest.
 *
 * `sections` (#109): without the prompt the choices stay — they ARE the
 * answer; without the solution the choices the student missed lose their
 * mark, while the verdict on each ticked choice stays, since it is the grade.
 */
import type { MarkdownRenderer, ReviewProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings, showsSection } from "@quiz/core/client";
import type { McqAnswer, McqDetails, McqSolution, McqStudent } from "./schema.js";
import { mcqReviewStrings, type McqReviewStringKey } from "./strings.js";
import { type BadgeTone, cx, helpClass, markdown, ScoreHeader, Verdict } from "@quiz/ui";

type McqReviewProps = ReviewProps<McqStudent, McqAnswer, McqSolution, McqDetails> & {
  strings?: StringOverrides<McqReviewStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

export function McqReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  sections,
  strings,
  renderMarkdown,
}: McqReviewProps) {
  const s = resolveStrings(mcqReviewStrings, strings);
  const selected = answer?.selected ?? [];
  const key = solution === null ? null : new Set(solution.correct);
  const showKey = showsSection(sections, "solution");

  return (
    <div className="flex flex-col gap-3">
      {showsSection(sections, "prompt") ? (
        <p className="text-sm text-fg">{markdown(renderMarkdown, student.prompt)}</p>
      ) : null}

      <ul className="flex flex-col gap-1.5">
        {student.choices.map((choice) => {
          const chosen = selected.includes(choice.id);
          const correct = key === null ? null : key.has(choice.id);
          const verdict: { tone: BadgeTone; label: string } | null =
            correct === null
              ? chosen
                ? { tone: "neutral", label: s.chosen }
                : null
              : chosen && correct
                ? { tone: "success", label: s.correct }
                : chosen && !correct
                  ? { tone: "danger", label: s.incorrect }
                  : !chosen && correct && showKey
                    ? { tone: "warning", label: s.missed }
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
                {markdown(renderMarkdown, choice.text)}
              </span>
              {verdict ? <Verdict tone={verdict.tone}>{verdict.label}</Verdict> : null}
            </li>
          );
        })}
      </ul>

      {selected.length === 0 ? <p className={helpClass}>{s.noAnswer}</p> : null}

      <ScoreHeader label={s.score} points={points} maxPoints={maxPoints}>
        {typeof details?.C === "number" ? (
          <span className="ml-2 text-fg-faint">
            · {s.breakdown} {details.c}/{details.C} · {s.wrongTicked} {details.w}/{details.W}
          </span>
        ) : null}
      </ScoreHeader>
      {details?.negativeMarking ? <p className={helpClass}>{s.negativeMarking}</p> : null}
      {details?.truncated ? <p className={helpClass}>{s.truncated}</p> : null}
    </div>
  );
}
