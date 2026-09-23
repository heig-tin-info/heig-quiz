/**
 * The class lists only this package uses. The shared table — `card`,
 * `label`, `input`, `button()`, `badge()`… — lives in `@quiz/ui`; what is left
 * here is the circuit's own chrome, in the same semantic tokens (DESIGN.md).
 */
import { cx } from "@quiz/ui";

/**
 * A native `<select>` in the chrome of the inputs above, with room on the
 * right for the browser's own arrow. `apps/web`'s `Select` draws its own
 * chevron over an `appearance-none` control; a leaf package copies the
 * TOKENS, not the icon set, so this one keeps the platform arrow.
 */
const SELECT_BASE =
  "rounded-field border border-line-strong bg-surface pl-3 pr-8 text-sm text-fg transition-colors hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

export const select = `${SELECT_BASE} py-1.5`;

/** The 28 px variant, aligned on {@link inputSm}: a fixed height, no padding. */
export const selectSm = `${SELECT_BASE} h-7 py-0`;

/**
 * A palette chip: the KIND IS THE CONTROL.
 *
 * The teacher restricts the palette by pressing the component itself, so the
 * row reads as the palette the student will get rather than as a column of
 * boxes labelled with component names. The `<label>` the caller draws holds a
 * visually hidden native checkbox, exactly as `qt-mcq`'s pastille does: the
 * keyboard, the role and the announcement come from the platform.
 */
export function chip(on: boolean, disabled = false): string {
  return cx(
    // `min-h`, not `h`: a two-word component name wraps at 390 px, and a pill
    // with a fixed height spills its label outside its own border.
    "inline-flex min-h-7 items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium leading-tight transition-colors",
    "has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
    on
      ? "border-accent bg-accent-soft text-accent"
      : cx("border-line-strong bg-surface text-fg-muted", !disabled && "hover:bg-surface-2"),
    disabled ? "opacity-50" : "cursor-pointer",
  );
}

/**
 * The segmented control of `apps/web/src/ui.tsx`, mirrored class for class as
 * `qt-mcq/ui.tsx` mirrors it: a recessed track, the chosen pill lifted onto
 * `surface`. The caller draws the `role="radiogroup"` track with
 * {@link segmentTrack} and one `<label>` per option with {@link segment}, each
 * holding an `sr-only` native radio.
 */
export const segmentTrack =
  "inline-flex shrink-0 flex-wrap items-center gap-0.5 rounded-full bg-surface-3 p-0.75";

export function segment(on: boolean, disabled = false): string {
  return cx(
    "inline-flex h-7 items-center justify-center rounded-full px-3 text-[13px] font-medium transition-colors",
    "has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
    on
      ? "bg-surface text-fg ring-1 ring-line-strong/70"
      : cx("text-fg-muted", !disabled && "cursor-pointer hover:text-fg"),
    disabled && "opacity-60",
  );
}

/** A quiet one-line strip under a canvas: the counts and the diagnostics. */
export const strip = "flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-muted";
