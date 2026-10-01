/**
 * The `diagram` review: what a teacher grades by hand (ADR-046 addendum,
 * decision 3). STACKED, top to bottom, because a diagram needs the width:
 *
 *  1. the student's diagram;
 *  2. the reference, when the key is shown — always on the teacher's panel;
 *  3. for the TEACHER only, the two text forms in tabs, "Student" and
 *     "Reference": a missing link or a wrong multiplicity reads there at a
 *     glance, where the canvas hides it in a layout (ADR-046 §4);
 *  4. the rubric, when the solution carries it (the teacher's alone, ADR-037).
 *
 * The text is derived by the kind's serialiser (`toText`, pure, the one of
 * `@quiz/diagram/server`) and never stored; `free` has no text form.
 */
import { useId, useState, type ReactNode } from "react";

import type { MarkdownRenderer, ReviewProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings, showsSection } from "@quiz/core/client";
import { DiagramView, type DiagramStrings } from "@quiz/diagram/client";
import { isEmptyScene, toText } from "@quiz/diagram/server";
import { caption, markdown, reviewPrompt, ScoreHeader, Segmented } from "@quiz/ui";

import { countsOf } from "./grading.js";
import type { DiagramAnswer, DiagramDetails, DiagramSolution, DiagramStudent } from "./schema.js";
import { diagramReviewStrings, type DiagramReviewStringKey } from "./strings.js";

type DiagramReviewProps = ReviewProps<DiagramStudent, DiagramAnswer, DiagramSolution, DiagramDetails> & {
  strings?: StringOverrides<DiagramReviewStringKey>;
  canvasStrings?: Partial<DiagramStrings>;
  renderMarkdown?: MarkdownRenderer;
};

/** A labelled panel: `outlined` for what the student drew, `soft` for the teacher's guide (the `rich` review's). */
function Panel({ title, aside, tone, children }: { title: string; aside?: ReactNode; tone: "soft" | "outlined"; children: ReactNode }) {
  return (
    <section className={tone === "soft" ? "rounded-field bg-surface-2 p-3" : "rounded-field border border-line-strong bg-surface p-3"}>
      <p className="flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        <span>{title}</span>
        {aside}
      </p>
      <div className="mt-2 text-sm text-fg">{children}</div>
    </section>
  );
}

export function DiagramReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  audience,
  sections,
  strings,
  canvasStrings,
  renderMarkdown,
}: DiagramReviewProps) {
  const s = resolveStrings(diagramReviewStrings, strings);
  const id = useId();
  const [tab, setTab] = useState<"student" | "reference">("student");
  const scene = answer?.scene;
  const drawn = scene !== undefined && !isEmptyScene(scene);
  const guide = solution !== null && showsSection(sections, "solution") ? solution : null;

  // The text forms are the teacher's (ADR-046 §4), and `free` has none.
  const texts =
    audience === "teacher" && guide !== null
      ? { student: drawn && scene ? toText(scene, student.kind) : "", reference: toText(guide.reference, student.kind) }
      : null;
  const shownText = texts === null || texts.reference === null ? null : tab === "student" ? texts.student : texts.reference;

  return (
    <div className="flex flex-col gap-3">
      {showsSection(sections, "prompt") ? <div className={reviewPrompt}>{markdown(renderMarkdown, student.prompt)}</div> : null}

      {details?.reason === "kind_mismatch" ? <p className="text-[13px] text-warning">{s.kindMismatch}</p> : null}

      <Panel
        title={s.answer}
        tone="outlined"
        aside={drawn && scene ? <span className="font-normal normal-case tracking-normal tabular-nums">{countsOf(scene, s)}</span> : null}
      >
        {drawn && scene ? (
          <DiagramView kind={student.kind} value={scene} strings={canvasStrings} aria-label={s.answer} />
        ) : (
          <span className={caption}>{s.noAnswer}</span>
        )}
      </Panel>

      {guide === null ? null : (
        <>
          <Panel
            title={s.reference}
            tone="soft"
            aside={<span className="font-normal normal-case tracking-normal tabular-nums">{countsOf(guide.reference, s)}</span>}
          >
            <DiagramView kind={student.kind} value={guide.reference} strings={canvasStrings} aria-label={s.reference} />
          </Panel>

          {shownText === null ? null : (
            <Panel title={s.text} tone="soft">
              <div className="flex flex-col gap-2">
                <Segmented<"student" | "reference">
                  name={`${id}-text`}
                  label={s.text}
                  size="sm"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: "student", label: s.textStudent },
                    { value: "reference", label: s.textReference },
                  ]}
                />
                {shownText === "" ? (
                  <span className={caption}>{s.noAnswer}</span>
                ) : (
                  <pre className="max-h-80 overflow-auto rounded-field border border-line bg-surface p-3 font-mono text-[12.5px] leading-relaxed text-fg">
                    {shownText}
                  </pre>
                )}
              </div>
            </Panel>
          )}

          {guide.rubric === undefined ? null : (
            <Panel title={s.rubric} tone="soft">
              {guide.rubric.trim() === "" ? <span className={caption}>{s.noRubric}</span> : markdown(renderMarkdown, guide.rubric)}
            </Panel>
          )}
        </>
      )}

      <ScoreHeader label={s.score} points={points} maxPoints={maxPoints} />
    </div>
  );
}
