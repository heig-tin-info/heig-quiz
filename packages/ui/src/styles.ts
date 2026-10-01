/**
 * The class lists of the question-type surfaces, in one place.
 *
 * A package cannot import `apps/web/src/ui/`, so the primitives it would
 * have used are reduced to their class lists here. Where the app has the
 * same thing — `cx`, `inputClass`, `inputSize`, `textareaClass`, `label`,
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
 * Field chrome, with no width and no height of its own — the one field of the
 * product: `apps/web`'s `Field`, `Select` and `Textarea` wear it, as the
 * editors and players of every question type do, so a field inside a
 * question editor is the same field as one in a settings form.
 *
 * Tailwind resolves conflicting utilities by their order in the generated
 * stylesheet, not by their order in the class attribute, so a `w-16` or an
 * `h-8` written next to this string was never guaranteed to win. Height comes
 * from `inputSize` and width from the caller, which both compose instead of
 * fighting. The radius is the `rounded-field` token, never a literal.
 */
export const inputClass =
  "rounded-field border border-line-strong bg-surface px-3 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50 disabled:hover:border-line-strong";

/**
 * Control heights, aligned on the button scale of `apps/web/DESIGN.md`:
 * `sm` 28 px for a control inside a dense row, `md` 34 px everywhere else.
 */
export const inputSize = { sm: "h-7", md: "h-8.5" } as const;

/**
 * A multi-line field: the chrome above, with the vertical padding and the
 * reading line height of `apps/web`'s `Textarea`. Its height is its content
 * (`rows`), never one of the two control heights.
 */
export const textareaClass = `${inputClass} py-2 leading-relaxed`;

export const codeArea =
  "w-full rounded-field border border-line-strong bg-surface px-3 py-2 font-mono text-[13px] leading-[1.55] text-fg transition-colors focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60";

export const lockedBlock =
  "overflow-x-auto rounded-field border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] leading-[1.55] text-fg-muted";

// disabled:pointer-events-none: hovering a disabled button must hit the
// wrapping Tip span (disabled controls swallow mouse events).
const BUTTON_BASE =
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,color,border-color,opacity,transform] duration-150 ease-out-emphasized active:scale-97 disabled:pointer-events-none disabled:opacity-50";

const BUTTON_VARIANT = {
  primary: "bg-accent text-on-fill hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-surface-2",
  subtle: "bg-surface-3 text-fg hover:bg-line-strong/70",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  danger: "bg-danger text-on-fill hover:opacity-90",
  // The trigger of a destructive action whose confirmation is the `danger`
  // dialog, in a settings row: red ink without the fill, so the row says what
  // the button does without competing with the screen's one accent.
  "danger-quiet": "border border-danger/40 bg-surface text-danger hover:border-danger hover:bg-danger-soft",
} as const;

/** The button heights of DESIGN.md: 28, 34 and 40 px. */
const BUTTON_SIZE = {
  sm: "h-7 px-3 text-[13px] [&_svg]:size-3.5",
  md: "h-8.5 px-4 text-sm [&_svg]:size-4",
  lg: "h-10 px-5 text-sm [&_svg]:size-4",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANT;
export type ButtonSize = keyof typeof BUTTON_SIZE;

/**
 * The class list of a button: a pill in one of six variants and three
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

/** Table classes, aligned on `T` in `apps/web/src/ui/page.tsx`. */
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
