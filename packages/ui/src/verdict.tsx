/**
 * How a review says "right", "wrong" and "how much" — the same way in every
 * question type (audit P-01f and P-01l).
 */
import type { ReactNode } from "react";

import { badge, type BadgeTone } from "./styles.js";

/**
 * The tone of a pass / fail verdict. `null` (or `undefined`) is a case that
 * was never judged — not run, not graded — and reads neutral, never red.
 */
export function verdictTone(ok: boolean | null | undefined): BadgeTone {
  if (ok === null || ok === undefined) return "neutral";
  return ok ? "success" : "danger";
}

/** A verdict pill: the badge chrome, the tone's soft fill, one short word. */
export function Verdict({
  tone = "neutral",
  className,
  children,
}: {
  tone?: BadgeTone | undefined;
  className?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return <span className={badge(tone, className ?? "")}>{children}</span>;
}

/**
 * The points of an answer as a reader sees them. An answer nobody graded yet
 * reads `—`, never `0`: a zero is a grade, and a student who reads one before
 * the teacher has looked is told something false.
 */
export function pointsOrDash(points: number | null): number | "—" {
  return points === null ? "—" : points;
}

/**
 * The score line under a review: the caller's word for "Score", then
 * `points / max`, then whatever breakdown the type adds (`children`).
 *
 * The mcq, short and cloze reviews end with it, a quiet line under the
 * answer, which is short. The code and circuit reviews do not: their score is
 * the HEADING of a long review (cases, stimuli, a compiler's output), with the
 * runner's state as badges beside it, so they write it as a `sectionTitle`
 * over their own sentence. What both share is the rule, {@link pointsOrDash};
 * making one look like the other is a design decision, not a refactoring.
 */
export function ScoreHeader({
  label,
  points,
  maxPoints,
  children,
}: {
  label: string;
  points: number | null;
  maxPoints: number;
  children?: ReactNode;
}): ReactNode {
  return (
    <p className="text-sm text-fg-muted">
      <span className="font-medium text-fg">{label}</span>{" "}
      <span className="tabular-nums">
        {pointsOrDash(points)} / {maxPoints}
      </span>
      {children}
    </p>
  );
}
