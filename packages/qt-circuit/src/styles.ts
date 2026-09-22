/**
 * The class lists this package uses, in one place.
 *
 * A package cannot import `apps/web/src/ui.tsx`, so the primitives it would
 * have used are reduced to their class lists here, copied from that file so
 * the two stay visually identical. Semantic tokens only (`bg-surface`,
 * `text-fg-muted`, `border-line`…): they swap under `html.dark` by themselves,
 * so no component below carries a `dark:` variant (DESIGN.md).
 */

/** Joins class names, skipping falsy entries. */
export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

export const card = "rounded-card border border-line bg-surface";

export const sectionTitle = "text-base font-semibold text-fg";

export const label = "flex items-center gap-1 text-[13px] font-medium text-fg";

export const hint = "text-[13px] text-fg-muted";

export const input =
  "rounded-field border border-line-strong bg-surface px-3 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

export const inputSm = `${input} h-7`;
export const inputMd = `${input} h-8.5`;

export const textarea = `${input} py-2 leading-relaxed`;

export const codeArea =
  "w-full rounded-field border border-line-strong bg-surface px-3 py-2 font-mono text-[13px] leading-[1.55] text-fg transition-colors focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60";

export const lockedBlock =
  "overflow-x-auto rounded-field border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] leading-[1.55] text-fg-muted";

const BUTTON_BASE =
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,color,border-color,opacity] duration-150 disabled:pointer-events-none disabled:opacity-50";

const BUTTON_VARIANT = {
  primary: "bg-accent text-on-fill hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-surface-2",
  subtle: "bg-surface-3 text-fg hover:bg-line-strong/70",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  danger: "bg-danger text-on-fill hover:opacity-90",
} as const;

const BUTTON_SIZE = {
  sm: "h-7 px-3 text-[13px] [&_svg]:size-3.5",
  md: "h-8.5 px-4 text-sm [&_svg]:size-4",
} as const;

export function button(
  variant: keyof typeof BUTTON_VARIANT = "primary",
  size: keyof typeof BUTTON_SIZE = "md",
  extra = "",
): string {
  return cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], extra);
}

const BADGE_TONE = {
  neutral: "bg-surface-3 text-fg-muted",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
} as const;

export type BadgeTone = keyof typeof BADGE_TONE;

export function badge(tone: BadgeTone = "neutral", extra = ""): string {
  return cx(
    "inline-flex h-5.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium",
    BADGE_TONE[tone],
    extra,
  );
}

/** Table classes, aligned on `T` in `apps/web/src/ui.tsx`. */
export const table = {
  table: "w-full text-[13px]",
  head: "text-left text-xs text-fg-muted",
  th: "px-3 py-2 font-medium",
  td: "px-3 py-2.5 align-middle",
  row: "border-t border-line",
} as const;

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
