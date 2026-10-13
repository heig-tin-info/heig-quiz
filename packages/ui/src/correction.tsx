/**
 * The pieces of the debrief's answer key (ADR-033, ADR-109) that the host and
 * more than one type's `Key` draw: the scale both densities share, the count
 * at the end of a row, and the "Expected answer" line of a written answer.
 * A size only one type draws lives in that type's package; one only the host
 * draws, in `apps/web/src/results/CorrectionQuestion.tsx`.
 */
import { Fragment, type ReactNode } from "react";
import type { KeyProps, KeyStats } from "@quiz/core/client";

import { cx } from "./styles.js";

/** `wall`: the correction projection's `clamp()` scale; `page`: the Results "Questions" tab. */
export type Density = KeyProps<unknown, unknown>["density"];

/** A program's two columns, either density; the density adds its gap. */
const PROGRAM = "grid items-start lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]";

/**
 * The sizes the host and the keys share, per density (DESIGN.md, "Correction
 * projection"). `program` is the two columns of a program, its code then its
 * test cases: a program's key fills both, the host the second alone for a
 * type that counts cases and draws no key.
 */
export const CORRECTION_SCALE = {
  wall: {
    count: "font-mono text-base",
    answer: "text-[clamp(17px,1.6vw,24px)]",
    note: "text-[clamp(16px,1.4vw,21px)]",
    caption: "text-[clamp(13px,1.2vw,17px)]",
    program: `${PROGRAM} gap-6`,
  },
  page: {
    count: "text-[13px]",
    answer: "text-sm",
    note: "text-sm",
    caption: "text-xs",
    program: `${PROGRAM} gap-4`,
  },
} as const satisfies Record<Density, Record<string, string>>;

/** The papers every figure of a question is over: its four outcomes summed. */
export const answeredCount = ({ outcomes: o }: Pick<KeyStats, "outcomes">): number =>
  o.correct + o.partial + o.wrong + o.blank;

/** The figure at the end of a row: a count of papers. */
export function CorrectionCount({ density, children }: { density: Density; children: ReactNode }) {
  return (
    <span className={cx("text-right tabular-nums text-fg-muted", CORRECTION_SCALE[density].count)}>{children}</span>
  );
}

/**
 * The answers a written one is measured against, above the answer groups:
 * "Expected answer 3 · 3.0", once revealed. With no answer named, the groups
 * alone — and nothing when there are none: the blanks alone say nothing the
 * head of the question does not.
 */
export function ExpectedAnswers({
  label,
  answers,
  revealed,
  density,
  rows,
  grouped,
}: {
  label: string;
  answers: readonly ReactNode[];
  revealed: boolean;
  density: Density;
  /** The host's answer groups (`KeyProps.rows`). */
  rows: ReactNode;
  /** The class's answers fall into at least one group (`KeyProps.stats.distribution`). */
  grouped: boolean;
}) {
  if (answers.length === 0) return grouped ? rows : null;
  return (
    <div className="flex flex-col gap-3">
      {revealed ? (
        <p className={cx("text-fg-muted", CORRECTION_SCALE[density].note)}>
          {label}{" "}
          <span className="font-semibold text-success">
            {answers.map((answer, i) => (
              <Fragment key={i}>
                {i > 0 ? " · " : null}
                {answer}
              </Fragment>
            ))}
          </span>
        </p>
      ) : null}
      {rows}
    </div>
  );
}
