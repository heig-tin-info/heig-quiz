/**
 * The class lists of the question-type surfaces, in one place.
 *
 * A package cannot import `apps/web/src/ui/`, so the primitives it would
 * have used are reduced to their class lists here. Where the app has the
 * same thing — `cx`, `inputClass`, `inputSize`, `controlSize`, `textareaClass`, `label`,
 * `buttonClass` — it is not copied: `apps/web/src/ui/` imports it from here,
 * so a field or a button in a question editor is the app's own. One token per
 * role (apps/web/DESIGN.md, "The question-type surfaces"). Semantic tokens only
 * (`bg-surface`, `text-fg-muted`, `border-line`…): they swap under
 * `html.dark` by themselves, so nothing below carries a `dark:` variant
 * (DESIGN.md).
 */

/** Joins class names, skipping falsy entries. */
export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

export const card = "rounded-card border border-line bg-surface";

/**
 * The 16 px title of a card or of a section, as `apps/web`'s `SectionHeading`
 * writes it: 700 with a tight tracking. It was 600 here while the app's was
 * 700, so a card title in the code editor read lighter than the heading of
 * the page around it.
 */
export const sectionTitle = "text-base font-bold tracking-tight text-fg";

/**
 * The label above a field, and the caption of a group of fields: 13 px, 500,
 * `fg`, a row so a help "?" can sit beside the word. `apps/web`'s
 * `FieldLabel` is this row.
 */
export const label = "flex items-center gap-1 text-[13px] font-medium text-fg";

/**
 * The sentence that explains a control or a section of an editor — what a
 * field accepts, what a policy does. 13 px in `fg-muted`, the description line
 * of `apps/web`'s `SettingRow`: it carries information the teacher needs.
 */
export const hint = "text-[13px] text-fg-muted";

/**
 * A quiet aside that only supports what is around it: the instruction under a
 * question in a player ("Choose one answer."), "no answer" in a review, the
 * note beside a field in a dense row. 12 px in `fg-faint`, which DESIGN.md
 * holds to 4.5:1.
 * An explanation of a control is a {@link hint}, never a caption.
 */
export const caption = "text-xs text-fg-faint";

/**
 * The statement at the head of a review, set apart from the answer under it
 * by its weight. `text-sm` is the plain-text size; a host's markdown renderer
 * sets its own (13 px in the app), so 500 is the contrast every review can
 * count on — the same in every type, since the student's results page stacks
 * them all. Not a cloze's text: there the statement IS the answer.
 */
export const reviewPrompt = "text-sm font-medium text-fg";

/** A checkbox in a column of settings (`CheckboxField.className`): no fixed height, the body ink. */
export const setting = "flex items-center gap-2 text-[13px] text-fg";

/**
 * THE control scale (ADR-094): one table read by buttons, fields, selects,
 * search boxes, segmented controls and chips, so that a toolbar of them sits
 * on one height. `sm` 28 px is for a control inside a table row or a dense
 * strip, `md` 34 px for everything else, `lg` 40 px for a form's lead action.
 *
 * - `height`, `text`, `px`: the one-line box.
 * - `svg`: the size of an icon inside a button.
 * - `icon`, `iconLeft`, `iconPad`: a field's leading icon (search), its inset
 *   and the left padding that clears it (`px` + icon + a gap).
 * - `edgeRight`, `padRight`: a trailing adornment (a select's chevron, a
 *   field's unit) at the same inset as the side padding, and the right
 *   padding that clears it.
 * - `segment`: the option inside a segmented track (`p-0.75` = 3 px of track
 *   on each side, so 22 + 6 = 28, 28 + 6 = 34, 34 + 6 = 40).
 */
export const controlSize = {
  sm: {
    height: "h-7", text: "text-[13px]", px: "px-3", svg: "[&_svg]:size-3.5",
    icon: "size-3.5", iconLeft: "left-3", iconPad: "pl-8", edgeRight: "right-3", padRight: "pr-9",
    segment: "h-5.5 text-xs",
  },
  md: {
    height: "h-8.5", text: "text-sm", px: "px-4", svg: "[&_svg]:size-4",
    icon: "size-4", iconLeft: "left-4", iconPad: "pl-10", edgeRight: "right-4", padRight: "pr-10",
    segment: "h-7 text-[13px]",
  },
  lg: {
    height: "h-10", text: "text-sm", px: "px-5", svg: "[&_svg]:size-4",
    icon: "size-4", iconLeft: "left-5", iconPad: "pl-11", edgeRight: "right-5", padRight: "pr-11",
    segment: "h-8.5 text-[13px]",
  },
} as const;

export type ControlSize = keyof typeof controlSize;

/**
 * Field chrome, with no width, no height, no padding and no radius of its own
 * — the border, the ink and the focus ring of the one field of the product.
 * `inputClass` (a pill, one line) and `textareaClass` (a soft square, many
 * lines) add the shape; `inputSize` the height and the padding.
 *
 * Tailwind resolves conflicting utilities by their order in the generated
 * stylesheet, not by their order in the class attribute, so a `w-16` or an
 * `h-8` written next to this string was never guaranteed to win. Height and
 * horizontal padding come from `inputSize` and width from the caller, which
 * both compose instead of fighting. The radius is a token, never a literal.
 */
const fieldChrome =
  "border border-line-strong bg-surface text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50 disabled:hover:border-line-strong";

/** A one-line field: the chrome and the pill. Pair it with an {@link inputSize}. */
export const inputClass = `rounded-control ${fieldChrome}`;

/** Builds one value per step of the scale, so no row of the table is spelled twice. */
const bySize = <T>(pick: (size: ControlSize) => T): Record<ControlSize, T> => ({
  sm: pick("sm"),
  md: pick("md"),
  lg: pick("lg"),
});

/**
 * The one-line box of the scale: height, side padding and text size. A field,
 * a select, a search box, a chip and a button wear it; the question types
 * import it too.
 */
export const inputSize = bySize((size) =>
  cx(controlSize[size].height, controlSize[size].px, controlSize[size].text),
);

/**
 * A multi-line field, or a field that holds content (a rich-text editor, a
 * formula box): the chrome with the soft square, not the pill. Its height is
 * its content, never one of the control heights; the caller sets the vertical
 * padding.
 */
export const areaClass = `rounded-field ${fieldChrome} px-3 text-sm`;

/** {@link areaClass} with the vertical padding and the reading line height of a textarea. */
export const textareaClass = `${areaClass} py-2 leading-relaxed`;

export const codeArea =
  "w-full rounded-field border border-line-strong bg-surface px-3 py-2 font-mono text-[13px] leading-[1.55] text-fg transition-colors focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60";

export const lockedBlock =
  "overflow-x-auto rounded-field border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] leading-[1.55] text-fg-muted";

// disabled:pointer-events-none: hovering a disabled button must hit the
// wrapping Tip span (disabled controls swallow mouse events).
const BUTTON_BASE =
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-[background-color,color,border-color,opacity,transform] duration-150 ease-out-emphasized active:scale-97 disabled:pointer-events-none disabled:opacity-50";

const BUTTON_VARIANT = {
  primary: "bg-accent text-on-fill hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-surface-2",
  subtle: "bg-surface-3 text-fg hover:bg-line-strong/70",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  // The primary of a neutral tool's own layer (the assistant's cards, ADR-069,
  // ADR-080 P3): ink, never the accent, which stays the screen's one primary.
  ink: "bg-fg text-surface hover:bg-fg/85",
  danger: "bg-danger text-on-fill hover:opacity-90",
  // The trigger of a destructive action whose confirmation is the `danger`
  // dialog, in a settings row: red ink without the fill, so the row says what
  // the button does without competing with the screen's one accent.
  "danger-quiet": "border border-danger/40 bg-surface text-danger hover:border-danger hover:bg-danger-soft",
} as const;

/** The button sizes are the control scale: the one-line box and the icon size. */
const BUTTON_SIZE = bySize((size) => cx(inputSize[size], controlSize[size].svg));

export type ButtonVariant = keyof typeof BUTTON_VARIANT;
export type ButtonSize = ControlSize;

/**
 * The class list of a button: a pill in one of seven variants and three
 * sizes, pressed to 0.97. `apps/web`'s `Button` and `LinkButton` are this
 * list on a `<button>` and an `<a>`; a question type, which cannot import
 * them, writes it on its own `<button>`.
 */
export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
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

/** Table classes: the base of the app's `T` (`apps/web/src/ui/table.tsx`). */
export const table = {
  table: "w-full text-[13px]",
  head: "text-left text-xs text-fg-muted",
  th: "px-3 py-2 font-medium",
  td: "px-3 py-2.5 align-middle",
  row: "border-t border-line",
} as const;

/**
 * A section of an editor laid out as a plain form (mcq, short, cloze): its
 * label, its hint and its fields, stacked 8 px apart. The code and circuit
 * editors put the same content in an `EditorSection` card instead, because
 * their sections are many and long; the tokens inside are the same.
 */
export const sectionClass = "flex flex-col gap-2";

/**
 * The drag handle of a reorderable row ({@link GripIcon} inside a button).
 *
 * VISIBLE at rest, which the first version was not: the grip was drawn in the
 * hover colour only, so a teacher looking at the list saw no affordance at all
 * and the reordering might as well not have existed. `fg-muted` at rest, `fg`
 * as soon as the pointer is anywhere on a row that wears `group/grip`, or the
 * handle has the focus, and the two cursors that say what the thing does.
 */
export const gripClass =
  "inline-flex h-7 w-6 shrink-0 cursor-grab items-center justify-center rounded-md text-fg-muted transition-colors group-hover/grip:text-fg hover:bg-surface-2 focus-visible:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:cursor-grabbing disabled:pointer-events-none disabled:opacity-40";

/**
 * What the two drawing surfaces, the circuit's canvas and the diagram's,
 * share word for word: monochrome ink on paper, hairlines, and ONE accent
 * use — what is selected. Each keeps its own list for the rest.
 */
export const canvasStyles = {
  frame: "overflow-hidden rounded-card border border-line bg-surface",
  toolbar: "flex flex-wrap items-center gap-1 border-b border-line bg-surface-2 px-2 py-1.5",
  separator: "mx-1 h-5 w-px shrink-0 bg-line",
  gridMinor: "fill-none stroke-line",
  gridMajor: "fill-none stroke-line-strong",
  inkNormal: "text-fg",
  inkSelected: "text-accent",
  /** The invisible wide stroke a line is picked by. */
  lineHit: "fill-none stroke-transparent stroke-[12] cursor-pointer",
  selectedHalo: "fill-accent-soft stroke-accent stroke-[1] [stroke-dasharray:3_3]",
  marquee: "fill-accent-soft stroke-accent stroke-[1] [stroke-dasharray:4_3]",
} as const;
