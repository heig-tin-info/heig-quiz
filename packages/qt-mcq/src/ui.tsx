/**
 * The components of this package that no other type has.
 *
 * What only the choice list of this type draws — the pastille, the lettered
 * choice of a correction and the one rule of its state (`choiceMark`), the
 * tooltip of its drag handle, two icons. The class lists and the primitives
 * the five types share live in `@quiz/ui`; this file uses the same design
 * tokens of `apps/web/DESIGN.md`: no raw colour, no `dark:` variant.
 */
import type { ReactNode } from "react";
import { cx, type ChoiceMarkState } from "@quiz/ui";

/**
 * Letter of a choice, as the editor and the review show it: A, B, C…
 *
 * Defined in `schema.ts` and re-exported here: the SERVER half needs the same
 * letters for its dashboard summary, and nothing in its import graph may
 * reach React.
 */
export { choiceLetter } from "./schema.js";

/**
 * The choice pastille: the LETTER IS THE CONTROL.
 *
 * A row used to carry a letter AND a checkbox labelled "Correct" — a word that
 * says nothing to a teacher reading a list of answers, and a second target for
 * one fact. The round letter is now the toggle itself: ticked, it is the
 * accent disc; at rest, a hairline circle. The student's player wears the same
 * face, so "the disc is the chosen one" is learnt once.
 *
 * It is a NATIVE input, visually hidden inside the `<label>` the caller draws,
 * with the disc as its visible face: the keyboard, the grouping of the radios,
 * the announcement and the `checkbox`/`radio` role all come from the platform.
 * The face is `aria-hidden`, so the letter never joins the accessible name —
 * in the player that name is the text of the choice, and nothing else.
 *
 * The caller owns the `<label>`, because the clickable area differs: a small
 * pill beside the editor's field, the WHOLE row in the player. Two things that
 * label must carry — `relative`, so the hidden input has an origin, and
 * `group/opt` while it is enabled, which is what lights the disc on hover.
 *
 * The focus ring is the app's own (2 px accent at 2 px offset), forwarded to
 * the face: an `sr-only` input is a clipped pixel, and a ring drawn on it is a
 * ring nobody sees.
 */
export function Pastille({
  letter,
  checked,
  size = "sm",
  disabled,
  type = "checkbox",
  name,
  id,
  onChange,
  "aria-label": ariaLabel,
}: {
  letter: string;
  checked: boolean;
  /** `sm` 32 px in the editor's row, `md` 40 px under the student's finger. */
  size?: "sm" | "md";
  disabled?: boolean;
  /** A radio when the question takes ONE answer; a checkbox otherwise. */
  type?: "checkbox" | "radio";
  name?: string;
  id?: string;
  onChange: (checked: boolean) => void;
  /**
   * The name of the control, when the `<label>` around it does not already
   * give it one. The editor's row says "Choice B is correct" — a pill beside a
   * field names nothing by itself. The player's whole row IS the label, and
   * the text of the choice is the name there: an `aria-label` would replace it
   * with a letter, which is the one thing a reader does not need to hear.
   */
  "aria-label"?: string;
}): ReactNode {
  return (
    <>
      <input
        type={type}
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
        {...(name === undefined ? {} : { name })}
        {...(id === undefined ? {} : { id })}
      />
      <span
        aria-hidden
        className={cx(
          "grid shrink-0 select-none place-items-center rounded-full border-2 font-bold leading-none",
          // 120 ms of micro feedback, and none at all for a reader who asked
          // the system for none (DESIGN.md, Motion).
          "transition-[background-color,border-color,color,transform] duration-120 motion-reduce:transition-none",
          size === "md" ? "size-10 text-sm" : "size-8 text-[13px]",
          "border-line-strong bg-surface text-fg-muted group-hover/opt:border-accent",
          "peer-checked:border-accent peer-checked:bg-accent peer-checked:text-on-fill",
          "peer-active:scale-[.94]",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
          "peer-disabled:opacity-50",
        )}
      >
        {letter}
      </span>
    </>
  );
}

/**
 * The state of one choice in one answer, as the grading table's tick box and
 * the review's letter both read it: ticked right or wrong, ticked with no key
 * to judge it (`correct` null), a key left out — `missed`, only where the
 * caller may say so — or nothing. Never `expected`: that is the key's own
 * row, not an answer's.
 */
export function choiceMark(
  ticked: boolean,
  correct: boolean | null,
  showMissed: boolean,
): Exclude<ChoiceMarkState, "expected"> {
  if (ticked) return correct === null ? "on" : correct ? "good" : "bad";
  return correct === true && showMissed ? "missed" : "off";
}

/** A letter's face per state: filled once it has a verdict, at rest otherwise. */
const LETTER: Record<ChoiceMarkState, string> = {
  good: "bg-success text-on-fill",
  missed: "bg-success text-on-fill",
  expected: "bg-success text-on-fill",
  bad: "bg-danger text-on-fill",
  on: "bg-fg-muted text-on-fill",
  off: "border-2 border-line-strong bg-surface text-fg-muted",
};

/**
 * A choice in a CORRECTION — the review, the poll's reveal on a phone —
 * behind its letter: the key's filled `success`, a wrong tick's `danger`, a
 * tick with no key `fg-muted`, the rest the player's pastille at rest. A
 * filled letter always has its verdict in words beside it, which the caller
 * draws; the tone is never the only reading.
 */
export function LetteredChoice({
  letter,
  mark,
  children,
}: {
  letter: string;
  mark: ChoiceMarkState;
  children: ReactNode;
}): ReactNode {
  return (
    <span className="flex min-w-0 flex-1 items-start gap-3">
      <span
        data-mark={mark}
        className={cx(
          "grid size-7 shrink-0 select-none place-items-center rounded-full text-xs font-bold leading-none",
          LETTER[mark],
        )}
      >
        {letter}
      </span>
      {/* The first line, not the block, lines up with the 28 px letter: half
          of what it is taller than a line of text. */}
      <span className="mt-1 min-w-0 flex-1">{children}</span>
    </span>
  );
}

/**
 * The app's tooltip, in the little that a leaf package can carry of it: a
 * bubble on `fg` with `canvas` ink, shown on hover and on focus, out of the
 * accessibility tree (the control it wraps already carries the same sentence
 * as its accessible name) and out of the pointer's way.
 *
 * `apps/web`'s `Tip` portals itself and arms on a timer; a package cannot
 * import it, and only this list uses one, so what is mirrored here
 * are the TOKENS and the two rules that matter — never focusable, never
 * clickable. The absolute position is enough for the two places this is used:
 * the handle and the `+` of a list nothing clips.
 */
export function Tip({
  label,
  align = "center",
  children,
}: {
  label: string;
  /**
   * `end` pins the bubble's right edge to the control's: a control at the
   * right edge of the column (the `+` of the list) would otherwise push half
   * the bubble past it, and on a phone off the screen.
   */
  align?: "center" | "end";
  children: ReactNode;
}): ReactNode {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        aria-hidden
        className={cx(
          "pointer-events-none absolute bottom-full z-20 mb-1.5 whitespace-nowrap",
          align === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
          "rounded-lg bg-fg px-2.5 py-1.5 text-xs font-medium leading-snug text-canvas opacity-0 transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100",
        )}
      >
        {label}
      </span>
    </span>
  );
}

