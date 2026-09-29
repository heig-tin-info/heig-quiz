/**
 * The marks of a grading-table cell (ADR-040), the same in every question
 * type that gives the table columns (`QuestionTypeClient.grading`).
 *
 * A cell is read at a glance across thirty rows, so it says right, wrong,
 * missed and expected by FILL before it says anything in words: success and
 * danger for the student's marks, a dashed success outline for a correct
 * choice the student left out, and `info` for the key — the "set of
 * possibilities" colour of DESIGN.md, which is neither a verdict nor the
 * accent. The words are the accessible name, passed in by the caller.
 */
import type { ReactNode } from "react";

import { cx } from "./styles.js";

/**
 * Where a piece of an answer stands: `good` and `bad` are the student's,
 * graded; `neutral` is theirs, not graded yet; `expected` is the key.
 */
export type AnswerTone = "good" | "bad" | "neutral" | "expected";

const CHIP: Record<AnswerTone, string> = {
  good: "bg-success-soft text-success",
  bad: "bg-danger-soft text-danger",
  neutral: "bg-surface-3 text-fg",
  expected: "font-medium text-info",
};

/**
 * A piece of text answer as a chip: mono, because what a student typed is
 * compared character by character ("malloc()" is not "malloc"), and tinted
 * by its verdict. The key is the same chip without a fill, in `info`.
 */
export function AnswerChip({
  tone,
  title,
  children,
}: {
  tone: AnswerTone;
  title?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        "inline-block max-w-full truncate rounded-md px-1.5 py-px align-middle font-mono text-[12.5px]",
        CHIP[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * A tick box of the grading table: ticked right, ticked wrong, ticked with
 * no key to judge it by (`on`), a correct choice left out, the key, or empty.
 */
export type ChoiceMarkState = "good" | "bad" | "on" | "missed" | "expected" | "off";

const MARK: Record<ChoiceMarkState, string> = {
  good: "border-transparent bg-success",
  bad: "border-transparent bg-danger",
  on: "border-transparent bg-fg-muted",
  missed: "border-dashed border-success",
  expected: "border-transparent bg-info",
  off: "border-line-strong",
};

/**
 * One choice of one answer: a 16 px square, filled when ticked. Its state
 * in words is its accessible name (`label`), since a colour is not one.
 */
export function ChoiceMark({ state, label }: { state: ChoiceMarkState; label: string }): ReactNode {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-mark={state}
      className={cx("inline-block size-4 rounded border-[1.5px] align-middle", MARK[state])}
    />
  );
}

/** A part of an answer the student left empty: quiet, italic, never a verdict colour. */
export function NoAnswer({ children }: { children: ReactNode }): ReactNode {
  return <span className="text-[13px] italic text-fg-faint">{children}</span>;
}
