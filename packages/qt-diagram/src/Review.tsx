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
import { useId, useState } from "react";

import type { ReviewProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings, showsSection } from "@quiz/core/client";
import { DiagramView, type DiagramStrings } from "@quiz/diagram/client";
import { isEmptyScene, toText } from "@quiz/diagram/server";
import { caption, markdown, NotePanel, ReviewPrompt, ScoreHeader, Segmented } from "@quiz/ui";

import { countsOf } from "./grading.js";
import type { DiagramAnswer, DiagramDetails, DiagramSolution, DiagramStudent } from "./schema.js";
import { diagramReviewStrings, type DiagramReviewStringKey } from "./strings.js";

type DiagramReviewProps = ReviewProps<DiagramStudent, DiagramAnswer, DiagramSolution, DiagramDetails> & {
  strings?: StringOverrides<DiagramReviewStringKey>;
  canvasStrings?: Partial<DiagramStrings>;
};

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
    // `text-sm text-fg`: the body of the panels; the other blocks set their own.
    <div className="flex flex-col gap-3 text-sm text-fg">
      <ReviewPrompt prompt={student.prompt} sections={sections} renderMarkdown={renderMarkdown} />

      {details?.reason === "kind_mismatch" ? <p className="text-[13px] text-warning">{s.kindMismatch}</p> : null}

      <NotePanel
        eyebrow={s.answer}
        tone="outlined"
        aside={drawn && scene ? countsOf(scene, s) : null}
      >
        {drawn && scene ? (
          <DiagramView kind={student.kind} value={scene} strings={canvasStrings} aria-label={s.answer} />
        ) : (
          <span className={caption}>{s.noAnswer}</span>
        )}
      </NotePanel>

      {guide === null ? null : (
        <>
          <NotePanel
            eyebrow={s.reference}
            tone="soft"
            aside={countsOf(guide.reference, s)}
          >
            <DiagramView kind={student.kind} value={guide.reference} strings={canvasStrings} aria-label={s.reference} />
          </NotePanel>

          {shownText === null ? null : (
            <NotePanel eyebrow={s.text} tone="soft">
              <div className="flex flex-col gap-2">
                <Segmented<"student" | "reference">
                  name={`${id}-text`}
                  label={s.text}
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
            </NotePanel>
          )}

          {guide.rubric === undefined ? null : (
            <NotePanel eyebrow={s.rubric} tone="soft">
              {guide.rubric.trim() === "" ? <span className={caption}>{s.noRubric}</span> : markdown(renderMarkdown, guide.rubric)}
            </NotePanel>
          )}
        </>
      )}

      <ScoreHeader label={s.score} points={points} maxPoints={maxPoints} />
    </div>
  );
}
