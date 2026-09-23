/**
 * The PROGRAM half of a review, shared by `code` and `codeimage` (ADR-021):
 * the score line with the runner's state, the compiler's refusal, and the
 * reference solution when the feedback policy sends it. What the program was
 * judged against — cases, a picture — is each review's own.
 */
import type { ReactNode } from "react";

import { fmt } from "@quiz/core/client";

import type { CodeReviewStrings } from "./strings.js";
import { badge, card, cx, lockedBlock, pointsOrDash, sectionTitle } from "@quiz/ui";

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
>;

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
