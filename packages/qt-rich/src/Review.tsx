/**
 * The `rich` review: what a teacher grades by hand.
 *
 * The answer, rendered as the student saw it while writing, and — when the
 * feedback policy lets the key through, which the teacher's panel always
 * does — the rubric and the model answer BESIDE it on a wide pane, under it on
 * a narrow one. A student's key holds the model answer alone (ADR-037). There is no verdict: the points are the teacher's, and the
 * score line under the review says them once set.
 */
import type { ReactNode } from "react";

import type { MarkdownRenderer, ReviewProps, StringOverrides } from "@quiz/core/client";
import { fmt, resolveStrings, showsSection } from "@quiz/core/client";
import { caption, markdown, ScoreHeader } from "@quiz/ui";

import { countChars, type RichAnswer, type RichDetails, type RichSolution, type RichStudent } from "./schema.js";
import { richReviewStrings, type RichReviewStringKey } from "./strings.js";

type RichReviewProps = ReviewProps<RichStudent, RichAnswer, RichSolution, RichDetails> & {
  strings?: StringOverrides<RichReviewStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

/** A labelled panel: `outlined` for what the student wrote, `soft` for the teacher's guide. */
function Panel({
  title,
  aside,
  tone,
  children,
}: {
  title: string;
  aside?: ReactNode;
  tone: "soft" | "outlined";
  children: ReactNode;
}) {
  return (
    <section
      className={
        tone === "soft"
          ? "rounded-field bg-surface-2 p-3"
          : "rounded-field border border-line-strong bg-surface p-3"
      }
    >
      <p className="flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        <span>{title}</span>
        {aside}
      </p>
      <div className="mt-1 text-sm text-fg">{children}</div>
    </section>
  );
}

export function RichReview({
  student,
  answer,
  solution,
  points,
  maxPoints,
  sections,
  strings,
  renderMarkdown,
}: RichReviewProps) {
  const s = resolveStrings(richReviewStrings, strings);
  const text = answer?.text ?? "";
  const written = text.trim() !== "";
  const guide = solution !== null && showsSection(sections, "solution") ? solution : null;

  const body = written ? (
    student.format === "markdown" ? (
      markdown(renderMarkdown, text)
    ) : (
      <p className="whitespace-pre-wrap break-words">{text}</p>
    )
  ) : (
    <span className={caption}>{s.noAnswer}</span>
  );

  return (
    <div className="flex flex-col gap-3">
      {showsSection(sections, "prompt") ? (
        <div className="text-sm text-fg">{markdown(renderMarkdown, student.prompt)}</div>
      ) : null}

      <div className="@container">
        <div className={guide ? "grid items-start gap-3 @2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : "grid"}>
          <Panel
            title={s.answer}
            tone="outlined"
            aside={
              written ? (
                <span className="font-normal normal-case tracking-normal tabular-nums">
                  {fmt(s.count, { count: countChars(text) })}
                </span>
              ) : null
            }
          >
            {body}
          </Panel>

          {guide ? (
            <div className="flex flex-col gap-3">
              {/* Absent from a student's key (ADR-037): no panel at all. */}
              {guide.rubric === undefined ? null : (
                <Panel title={s.rubric} tone="soft">
                  {guide.rubric.trim() === "" ? (
                    <span className={caption}>{s.noRubric}</span>
                  ) : (
                    markdown(renderMarkdown, guide.rubric)
                  )}
                </Panel>
              )}
              {guide.reference !== undefined && guide.reference.trim() !== "" ? (
                <Panel title={s.reference} tone="soft">
                  {markdown(renderMarkdown, guide.reference)}
                </Panel>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <ScoreHeader label={s.score} points={points} maxPoints={maxPoints} />
    </div>
  );
}
