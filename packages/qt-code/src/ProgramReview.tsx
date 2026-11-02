/**
 * The PROGRAM half of a review, shared by `code` and `codeimage` (ADR-021):
 * the score line with the runner's state, the compiler's refusal, the
 * student's own program, and the reference solution when the feedback
 * policy sends it. What the program was
 * judged against — cases, a picture — is each review's own.
 */
import type { ReactNode } from "react";

import { fmt, showsSection, type ReviewSections } from "@quiz/core/client";
import { joinSegments, type TemplateSegment } from "@quiz/domain/lockedTemplate";

import type { CodeReviewStrings } from "./strings.js";
import { badge, card, cx, hint, lockedBlock, pointsOrDash, sectionTitle } from "@quiz/ui";

/** The keys of the review dictionary the program half reads. */
export type ProgramReviewStrings = Pick<
  CodeReviewStrings,
  | "score"
  | "compileFailed"
  | "compilerOutput"
  | "runnerUnavailable"
  | "runnerBusy"
  | "runnerError"
  | "referenceSolution"
  | "notAnswered"
  | "yourCode"
>;

/**
 * A review with no breakdown to show — an absent answer, a grading-level
 * marker, a run still to come — which reads the same to a student either
 * way: the statement, why there is nothing more, then the program as
 * written and the key when the policy sends it. An answer not graded yet
 * (`graded: false`, no points: its run is still to come, as after a check,
 * ADR-124 §3) has no reason to give, and is not said to have failed.
 */
export function NoBreakdown({
  statement,
  student,
  answer,
  solution,
  sections,
  graded,
  s,
}: {
  statement: ReactNode;
  student: ProgramStudent;
  answer: ProgramAnswer | null;
  solution: { referenceSolution: string } | null;
  sections: ReviewSections | undefined;
  graded: boolean;
  s: ProgramReviewStrings;
}): ReactNode {
  const why = answer === null ? s.notAnswered : graded ? s.runnerError : null;
  return (
    <div className="flex flex-col gap-3">
      {statement}
      {why === null ? null : <p className={hint}>{why}</p>}
      <ProgramCards student={student} answer={answer} solution={solution} sections={sections} s={s} />
    </div>
  );
}

/** What of a student view the program half reads: the template, split. */
interface ProgramStudent {
  segments: readonly TemplateSegment[];
}

/** What of an answer it reads: the editable regions. */
interface ProgramAnswer {
  regions: readonly string[];
}

/**
 * The two programs under a review: the student's own, then the reference
 * solution when the policy sends it and the reader keeps it (#109).
 */
export function ProgramCards({
  student,
  answer,
  solution,
  sections,
  s,
}: {
  student: ProgramStudent;
  answer: ProgramAnswer | null;
  solution: { referenceSolution: string } | null;
  sections: ReviewSections | undefined;
  s: ProgramReviewStrings;
}): ReactNode {
  return (
    <>
      <StudentProgramCard student={student} answer={answer} s={s} />
      {showsSection(sections, "solution") ? <ReferenceSolutionCard solution={solution} s={s} /> : null}
    </>
  );
}

/**
 * The program the student wrote, whole: the template's locked lines with
 * their regions in place, joined as the run joins them (`joinSegments`). An
 * answer that no longer fits the template shows nothing rather than a
 * program that never ran.
 */
export function StudentProgramCard({
  student,
  answer,
  s,
}: {
  student: ProgramStudent;
  answer: ProgramAnswer | null;
  s: ProgramReviewStrings;
}): ReactNode {
  if (answer === null) return null;
  let source: string;
  try {
    source = joinSegments(student.segments, answer.regions);
  } catch {
    return null;
  }
  return (
    <section className={cx(card, "flex flex-col gap-2 p-4")}>
      <h3 className={sectionTitle}>{s.yourCode}</h3>
      <pre className={lockedBlock}>
        <code>{source}</code>
      </pre>
    </section>
  );
}

/** The score, and a badge when the runner could not grade by itself. */
export function ScoreLine({
  points,
  maxPoints,
  runner,
  s,
}: {
  points: number | null;
  maxPoints: number;
  runner: "ok" | "unavailable" | "busy" | "error";
  s: ProgramReviewStrings;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={cx(sectionTitle, "tabular-nums")}>
        {fmt(s.score, { points: pointsOrDash(points), max: maxPoints })}
      </span>
      {runner === "unavailable" ? <span className={badge("warning")}>{s.runnerUnavailable}</span> : null}
      {runner === "busy" ? <span className={badge("warning")}>{s.runnerBusy}</span> : null}
      {runner === "error" ? <span className={badge("danger")}>{s.runnerError}</span> : null}
    </div>
  );
}

/** The compiler's refusal, with its words when it said any. */
export function CompileFailure({
  compile,
  s,
}: {
  compile: { ok: boolean; stderr: string } | null;
  s: ProgramReviewStrings;
}): ReactNode {
  if (compile === null || compile.ok) return null;
  return (
    <section className={cx(card, "flex flex-col gap-2 p-4")}>
      <h3 className={cx(sectionTitle, "text-danger")}>{s.compileFailed}</h3>
      {compile.stderr === "" ? null : (
        <pre className={lockedBlock} aria-label={s.compilerOutput}>
          <code>{compile.stderr}</code>
        </pre>
      )}
    </section>
  );
}

/** The teacher's own solution, when the feedback policy sends the key. */
export function ReferenceSolutionCard({
  solution,
  s,
}: {
  solution: { referenceSolution: string } | null;
  s: ProgramReviewStrings;
}): ReactNode {
  if (solution === null || solution.referenceSolution === "") return null;
  return (
    <section className={cx(card, "flex flex-col gap-2 p-4")}>
      <h3 className={sectionTitle}>{s.referenceSolution}</h3>
      <pre className={lockedBlock}>
        <code>{solution.referenceSolution}</code>
      </pre>
    </section>
  );
}
