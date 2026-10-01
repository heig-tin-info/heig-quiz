/**
 * The `mcq` review: the verdict CHOICE BY CHOICE, never a bare score.
 *
 * It reads like the correction projection: the statement first, set apart by
 * its weight (`reviewPrompt`), then the choices, each behind its letter —
 * A, B, C… in the order the host hands them, as the player letters its rows
 * (`LetteredChoice`). The key's letter is filled `success`; a choice the
 * student ticked wears a soft tint, `success` when it is right and `danger`
 * when it is wrong. Every tinted row and every filled letter carries its
 * verdict in words beside it. The state of a choice is the grading table's
 * (`choiceMark`), so the two never read one answer differently.
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
import {
  type BadgeTone,
  caption,
  type ChoiceMarkState,
  cx,
  markdown,
  reviewPrompt,
  ScoreHeader,
  Verdict,
} from "@quiz/ui";
import { choiceLetter, choiceMark, LetteredChoice } from "./ui.js";

type McqReviewProps = ReviewProps<McqStudent, McqAnswer, McqSolution, McqDetails> & {
  strings?: StringOverrides<McqReviewStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

/** What each state wears: its row (only a tick is tinted) and its verdict in words. */
const LOOK: Record<
  Exclude<ChoiceMarkState, "expected">,
  { row: string; verdict: { tone: BadgeTone; label: McqReviewStringKey } | null }
> = {
  good: { row: "bg-success-soft", verdict: { tone: "success", label: "correct" } },
  bad: { row: "bg-danger-soft", verdict: { tone: "danger", label: "incorrect" } },
  on: { row: "bg-surface-2", verdict: { tone: "neutral", label: "chosen" } },
  missed: { row: "", verdict: { tone: "warning", label: "missed" } },
  off: { row: "", verdict: null },
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
    <div className="flex flex-col gap-4">
      {showsSection(sections, "prompt") ? (
        <p className={reviewPrompt}>{markdown(renderMarkdown, student.prompt)}</p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {student.choices.map((choice, index) => {
          const mark = choiceMark(selected.includes(choice.id), key?.has(choice.id) ?? null, showKey);
          const { row, verdict } = LOOK[mark];
          return (
            <li
              key={choice.id}
              className={cx("flex items-start gap-3 rounded-xl px-2.5 py-1.5 text-sm", row)}
            >
              <LetteredChoice letter={choiceLetter(index)} mark={mark}>
                {markdown(renderMarkdown, choice.text)}
              </LetteredChoice>
              {verdict ? (
                <Verdict tone={verdict.tone} className="mt-0.75">
                  {s[verdict.label]}
                </Verdict>
              ) : null}
            </li>
          );
        })}
      </ul>

      {selected.length === 0 ? <p className={caption}>{s.noAnswer}</p> : null}

      <ScoreHeader label={s.score} points={points} maxPoints={maxPoints}>
        {typeof details?.C === "number" ? (
          <span className="ml-2 text-fg-faint">
            · {s.breakdown} {details.c}/{details.C} · {s.wrongTicked} {details.w}/{details.W}
          </span>
        ) : null}
      </ScoreHeader>
      {details?.negativeMarking ? <p className={caption}>{s.negativeMarking}</p> : null}
      {details?.truncated ? <p className={caption}>{s.truncated}</p> : null}
    </div>
  );
}
