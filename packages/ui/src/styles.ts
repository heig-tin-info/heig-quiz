/**
 * The class lists of the question-type surfaces, in one place.
 *
 * A package cannot import `apps/web/src/ui/`, so the primitives it would
 * have used are reduced to their class lists here, copied from there so
 * the two stay visually identical. `qt-code` and `qt-circuit` used to carry
 * this table twice, byte for byte (audit P-01a). Semantic tokens only
 * (`bg-surface`, `text-fg-muted`, `border-line`…): they swap under
 * `html.dark` by themselves, so nothing below carries a `dark:` variant
 * (DESIGN.md).
 */

/** Joins class names, skipping falsy entries. */
export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

export const card = "rounded-card border border-line bg-surface";

export const sectionTitle = "text-base font-semibold text-fg";

export const label = "flex items-center gap-1 text-[13px] font-medium text-fg";

export const hint = "text-[13px] text-fg-muted";

/** A checkbox in a column of settings (`CheckboxField.className`): no fixed height, the body ink. */
export const setting = "flex items-center gap-2 text-[13px] text-fg";

export const input =
  "rounded-field border border-line-strong bg-surface px-3 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

export const inputSm = `${input} h-7`;

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

/** Table classes, aligned on `T` in `apps/web/src/ui/page.tsx`. */
export const table = {
  table: "w-full text-[13px]",
  head: "text-left text-xs text-fg-muted",
  th: "px-3 py-2 font-medium",
  td: "px-3 py-2.5 align-middle",
  row: "border-t border-line",
} as const;

/*
 * The FORM family: the editors and players of mcq, short and cloze are
 * plain forms rather than the card-and-table screens of code and circuit,
 * and they speak in these seven class lists. They used to be copied in the
 * ui.tsx of each of the three packages — and short and cloze had drifted to
 * a literal `rounded-xl` (audit P-01, divergence 1).
 */

/**
 * Field chrome: the `--radius-field` token, `line-strong` hairline, accent
 * ring on focus. The RADIUS is a token and not `rounded-xl` on purpose — the
 * field radius of `apps/web/src/style.css` is a value the design owns, and a
 * literal here would drift the day it changes.
 */
export const inputClass =
  "rounded-field border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

export const labelClass = "text-[13px] font-medium text-fg";
export const helpClass = "text-xs text-fg-faint";
export const sectionClass = "flex flex-col gap-2";

/** The 16 px section title of a card, as `SectionHeading` writes it. */
export const cardTitleClass = "text-base font-bold tracking-tight text-fg";

/** Secondary button chrome (pill, hairline), for the editor's add/remove actions. */
export const buttonClass =
  "inline-flex h-7 shrink-0 select-none items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2 disabled:opacity-50";
