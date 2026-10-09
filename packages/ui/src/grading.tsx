/**
 * The marks of a grading-table cell (ADR-044), the same in every question
 * type that gives the table columns (`QuestionTypeClient.grading`).
 *
 * A cell is read at a glance across thirty rows, so it says right, wrong,
 * missed and expected by FILL before it says anything in words: success and
 * danger for the student's marks, a dashed success outline for a correct
 * choice the student left out, and `info` for the key — the "set of
 * possibilities" colour of DESIGN.md, which is neither a verdict nor the
 * accent. The words are the accessible name, passed in by the caller.
 */
import { useState, type ReactNode } from "react";

import { isMachineReason, isRetryableReason, reasonOf } from "@quiz/core/reasons";

import { cx } from "./styles.js";

/**
 * Where a piece of an answer stands: `good`, `partial` and `bad` are the
 * student's, graded (`partial`: a count only some of which is right, "3/4
 * tests"); `neutral` is theirs, not graded yet; `expected` is the key.
 */
export type AnswerTone = "good" | "partial" | "bad" | "neutral" | "expected";

const CHIP: Record<AnswerTone, string> = {
  good: "bg-success-soft text-success",
  // Some of it: the green of a right answer, drawn dashed and without a
  // fill — the convention of a correct choice left out ("missed").
  partial: "outline-1 -outline-offset-1 outline-dashed outline-success text-success",
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
  mono = true,
  children,
}: {
  tone: AnswerTone;
  title?: string | undefined;
  /**
   * `false` for words that are not typed by the student: a column's name,
   * a count ("3/4 tests") — the same chip in the text face.
   */
  mono?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        "inline-block max-w-full truncate rounded-md px-1.5 py-px align-middle",
        mono ? "font-mono text-[12.5px]" : "text-[13px]",
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

/** The lines a clamped program shows before its foot. */
const CODE_LINES = 5;

/**
 * A program in a grading cell (`code`, `codeimage`): a mono box that takes
 * the WHOLE width of its column, never the width of its longest line, so
 * thirty programs line up down the table. Past {@link CODE_LINES} lines (two past: one
 * line more is shown, not hidden) it is clamped, a fade and "⋯ N more
 * lines" at its foot; a click on it — or Enter / Space,
 * it is a button then — unfolds it in place and folds it back.
 *
 * The click stops there: the row under it opens the answer panel, and
 * reading a program to its end is not asking for the panel. The key in
 * `info`, like every key of the table.
 */
export function ClampedCode({
  code,
  tone = "neutral",
  more,
  expand,
  collapse,
}: {
  code: string;
  tone?: "neutral" | "expected";
  /** The foot of a clamped box, from the number of lines it hides: "⋯ 4 more lines". */
  more: (hidden: number) => string;
  /** The tooltip of a clamped box ("Show the whole program") and of an unfolded one. */
  expand: string;
  collapse: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const total = code.split("\n").length;
  // One line past the clamp is shown rather than hidden: its foot would be
  // as tall as the line it hides.
  const hidden = total > CODE_LINES + 1 ? total - CODE_LINES : 0;
  const box = (
    <pre
      className={cx(
        "m-0 w-full min-w-0 whitespace-pre rounded-field bg-surface-2 px-2.5 py-2 font-mono text-xs leading-[1.45]",
        tone === "expected" ? "text-info" : "text-fg",
        open ? "overflow-x-auto" : "overflow-hidden",
      )}
      // The top padding, CODE_LINES whole lines, and one more line's height for
      // the foot, over the fade of the first hidden line.
      style={hidden > 0 && !open ? { maxHeight: `calc(${CODE_LINES + 1} * 1.45em + 8px)` } : undefined}
    >
      {code}
    </pre>
  );
  if (hidden <= 0) return box;
  const toggle = (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    setOpen((o) => !o);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title={open ? collapse : expand}
      data-clamped={open ? undefined : ""}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggle(e);
      }}
      className={cx(
        "relative w-full min-w-0 rounded-field focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        open ? "cursor-zoom-out" : "cursor-zoom-in",
      )}
    >
      {box}
      {open ? null : (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-field bg-linear-to-b from-transparent to-surface-2 to-40% px-2.5 pt-1.5 pb-1 text-[11px] leading-[1.45] text-fg-muted">
          ⋯ {more(hidden)}
        </span>
      )}
    </div>
  );
}

/** An empty cell, or a key with nothing to show: a faint em dash, never a verdict. */
export function Dash({ className }: { className?: string | undefined }): ReactNode {
  return <span className={cx("text-fg-faint", className)}>—</span>;
}

/**
 * A chip of words that are not the student's (a count, a column's name, a
 * run's state), in the text face; its whole text is its tooltip, since a
 * narrow column cuts it.
 */
export function WordChip({ tone, text }: { tone: AnswerTone; text: string }): ReactNode {
  return (
    <AnswerChip tone={tone} title={text} mono={false}>
      {text}
    </AnswerChip>
  );
}

/** A count of parts right (tests, stimuli, cards): all, none, or some of them. */
export function countTone(passed: number, total: number): AnswerTone {
  return passed === total ? "good" : passed === 0 ? "bad" : "partial";
}

/**
 * A column's header from a piece of the question (a choice, a card): its
 * text on one line — markdown line breaks collapsed, code spans' backticks
 * dropped — cut at `max` characters, the whole of it as the tooltip.
 */
export function headerOf(text: string, max: number): { label: string; title: string } {
  const title = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const label = title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
  return { label, title };
}

/**
 * Where a graded run stands, from a grading's `details` (`code`,
 * `codeimage`, `circuit`): `waiting` while no verdict exists or a new pass
 * could still bring one (the runner away or busy, a retryable machine
 * reason); `failed` when the run itself failed or a machine gave up for
 * good; `ran` when the breakdown is the runner's own. `null` when the
 * details say nothing about a run: a teacher's override (`{ manual: true }`)
 * or a type's own "not simulated" (`runner: "none"`).
 */
export type RunStatus = "waiting" | "failed" | "ran";

export function runStatus(details: unknown): RunStatus | null {
  if (details === null || details === undefined) return "waiting";
  const runner =
    typeof details === "object" && "runner" in details ? (details as { runner: unknown }).runner : undefined;
  switch (runner) {
    case "ok":
      return "ran";
    case "unavailable":
    case "busy":
      return "waiting";
    case "error":
      return "failed";
    case undefined: {
      // A marker the grading pass left instead of the type's breakdown.
      const reason = reasonOf(details);
      if (isRetryableReason(reason)) return "waiting";
      return isMachineReason(reason) ? "failed" : null;
    }
    default:
      return null;
  }
}
