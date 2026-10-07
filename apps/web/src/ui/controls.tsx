import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

import {
  buttonClass,
  cx,
  ErrorText as ErrorTextBase,
  inputClass,
  inputSize,
  label as fieldLabel,
  Segmented,
  textareaClass,
  type ButtonSize,
  type ButtonVariant,
} from "@quiz/ui";

import { HelpIcon, type IconType } from "./layers";

// --- Buttons ---

/*
 * The class list of a button (`buttonClass`, six variants, three sizes) is
 * written once, in `@quiz/ui`, where the question types read it too; <Button>,
 * <LinkButton> and the raw anchors of the app wear the same list.
 */
export { buttonClass };

/** A link in running text: the parent's ink until hovered, then `fg` and an underline. */
export const textLink = "underline-offset-2 transition-colors hover:text-fg hover:underline";

export function Button({
  children,
  variant = "primary",
  size = "md",
  loading,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the leading icon and disables the button. */
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={buttonClass(variant, size, className)}
    >
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  );
}

/**
 * A click on a link that the app may route itself: the main button, no
 * modifier, not already taken. A new tab, a new window, a download or a
 * middle click stays the browser's, which follows the link's real `href`.
 */
export function isPlainClick(event: React.MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** Anchor styled as a button (external links, downloads, plain navigations). */
export function LinkButton({
  children,
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <a {...props} className={buttonClass(variant, size, className)}>
      {children}
    </a>
  );
}

// --- Form controls ---

/*
 * The field chrome (`inputClass`, no width and no height of its own), the two
 * control heights (`inputSize`) and the multi-line field (`textareaClass`)
 * are written once, in `@quiz/ui`: the editors and players of the question
 * types wear them too, so a field in a question editor is the field of every
 * other form of the app.
 */
export { inputClass, inputSize, textareaClass };
type InputSize = keyof typeof inputSize;

/**
 * Label above a control; used by Field, Select and Textarea.
 *
 * The <label> covers the text only. A <label> wrapping the help "?" button
 * makes that BUTTON its labelled control, which leaves the real input with no
 * accessible name and turns a click on the label into a click on help; so the
 * row is a div and the label points at the control through `htmlFor`.
 */
export function FieldLabel({
  children,
  htmlFor,
  help,
  hint,
}: {
  children: ReactNode;
  /** Id of the control this labels; omit for a label with no control. */
  htmlFor?: string;
  help?: string;
  hint?: ReactNode;
}) {
  return (
    <div className={fieldLabel}>
      <label htmlFor={htmlFor}>{children}</label>
      {help ? <HelpIcon topic={help} /> : null}
      {hint ? <span className="ml-auto font-normal text-fg-faint">{hint}</span> : null}
    </div>
  );
}

export function Field({
  label,
  help,
  hint,
  description,
  fullWidth,
  size = "md",
  width = "w-52",
  className = "",
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  label: string;
  help?: string;
  /** Right-aligned note on the label line. */
  hint?: ReactNode;
  /** What the value is, one line under the input, read with it (`aria-describedby`). */
  description?: ReactNode;
  /** Stretch label and input to the parent width (grid cells). */
  fullWidth?: boolean;
  /** Control height: `sm` 28 px for dense rows, `md` 34 px by default. */
  size?: InputSize;
  /**
   * Width utility, on the wrapper so the label shares it. It lives here and
   * not in `className` because two width utilities on the same element are
   * resolved by the stylesheet order, not by the caller's intent.
   */
  width?: string;
}) {
  const auto = useId();
  const id = props.id ?? auto;
  return (
    <div className={cx("flex flex-col gap-1.5", fullWidth ? "w-full" : width)}>
      <FieldLabel htmlFor={id} help={help} hint={hint}>
        {label}
      </FieldLabel>
      <input
        {...props}
        // Added to, never replaced by, a caller's own (`fieldErrorProps`).
        aria-describedby={
          [description ? `${id}-description` : null, props["aria-describedby"]]
            .filter(Boolean)
            .join(" ") || undefined
        }
        id={id}
        className={cx(inputClass, inputSize[size], "w-full", className)}
      />
      {description ? (
        <p id={`${id}-description`} className="text-xs text-fg-muted">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** Native select with the field chrome and a chevron. */
export function Select({
  label,
  help,
  size = "md",
  width,
  className = "",
  children,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  label?: string;
  help?: string;
  /** Control height: `sm` 28 px for dense rows, `md` 34 px by default. */
  size?: InputSize;
  /** Width utility on the wrapper; without it the select sizes to its parent. */
  width?: string;
}) {
  const auto = useId();
  const id = props.id ?? auto;
  const control = (
    <span className={cx("relative block", width)}>
      <select
        {...props}
        id={id}
        className={cx(inputClass, inputSize[size], "w-full appearance-none pr-8", className)}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
    </span>
  );
  if (!label) return control;
  // The width sits on the control; the label column takes it from there.
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id} help={help}>
        {label}
      </FieldLabel>
      {control}
    </div>
  );
}

export function Textarea({
  label,
  help,
  className = "",
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; help?: string }) {
  // No `size` prop here on purpose: a textarea's height is its content, not
  // one of the two control heights.
  const auto = useId();
  const id = props.id ?? auto;
  const control = (
    <textarea
      {...props}
      id={id}
      className={cx(textareaClass, "min-h-24 w-full", className)}
    />
  );
  if (!label) return control;
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id} help={help}>
        {label}
      </FieldLabel>
      {control}
    </div>
  );
}

/** Pill search box; keeps its own width so toolbars stay aligned. */
export function SearchInput({
  className = "w-56",
  ...props
}: React.ComponentPropsWithRef<"input">) {
  return (
    <label className={cx("relative block", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
      <input
        type="search"
        {...props}
        className={cx(inputClass, inputSize.md, "w-full rounded-full pl-9 pr-3")}
      />
    </label>
  );
}

/**
 * A value you switch on, drawn as a pill rather than as a box with a label
 * beside it (DESIGN.md › Components).
 *
 * A column of checkboxes is the right shape for a list of independent
 * settings; it is the wrong shape for a SET of values — the type of a
 * question, a difficulty, a tag — where the reader wants to see what is on
 * at a glance and where the labels are two words long. Ticked boxes laid out
 * in rows collide as soon as one label is long; pills carry their own
 * bounds, wrap cleanly and say "pressed" with a fill instead of a glyph.
 *
 * It is a real `aria-pressed` button, so a screen reader hears the state and
 * the label without the two ever getting separated. Containers lay them out
 * with `flex flex-wrap gap-2`.
 */
export function ToggleChip({
  label,
  icon: Icon,
  pressed,
  onToggle,
  tone = "accent",
  disabled,
  className = "",
  "aria-label": ariaLabel,
}: {
  label: ReactNode;
  icon?: IconType;
  /**
   * On or off. `undefined` drops `aria-pressed` altogether, for the one pill
   * in a row that is an ACTION and not a value ("Show all (37)"): announcing
   * it as an unpressed toggle would promise a state it does not have.
   */
  pressed?: boolean;
  onToggle: () => void;
  /**
   * `neutral` for a chip on a screen whose accent belongs to something else
   * (the player's own tools under a question, issue #128): pressed, it is
   * filled `fg` with `surface` text — the progress strip's "done" fill, as
   * plain to read as the accent one, without taking the screen's colour.
   */
  tone?: "accent" | "neutral";
  disabled?: boolean;
  className?: string;
  /** For a chip whose visible label is a bare number ("3" is not a name). */
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50",
        pressed
          ? tone === "neutral"
            ? "border-fg bg-fg text-surface"
            : "border-accent bg-accent-soft text-accent"
          : "border-line-strong bg-surface text-fg-muted hover:border-fg-faint hover:text-fg",
        className,
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
      {label}
    </button>
  );
}

/** Checkbox with the accent tick, label on the right. */
export function Checkbox({
  label,
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2.5 text-sm", props.disabled && "opacity-50", className)}>
      <span className="relative inline-flex size-4 shrink-0">
        <input type="checkbox" {...props} className="peer size-4 appearance-none rounded-[5px] border border-line-strong bg-surface transition-colors checked:border-accent checked:bg-accent" />
        <Check className="pointer-events-none absolute inset-0 m-auto size-3 text-on-fill opacity-0 peer-checked:opacity-100" strokeWidth={3} />
      </span>
      {label}
    </label>
  );
}

/**
 * One choice of a list of radios drawn as rows (the regrade's versions, the
 * pairing's exams, the GitHub organizations): the accent ring, the row tinted
 * `accent-soft` when checked, `surface-2` on hover. The radio is centred on
 * the first line of the row's own text size (`h-[1lh]`), so a 15 px title
 * and a 14 px one both line up without a per-site margin. `className` is the
 * row's padding and text size, whole: `cx` does not merge, so it replaces the
 * default rather than fighting it. Wrap the rows in a `fieldset`.
 */
export function RadioRow<V extends string | number>({
  name,
  value,
  checked,
  disabled,
  onPick,
  children,
  className = "px-3 py-2.5 text-sm",
}: {
  name: string;
  value: V;
  checked: boolean;
  disabled?: boolean;
  onPick: (value: V) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cx(
        "flex items-start gap-3 transition-colors",
        disabled
          ? "cursor-not-allowed opacity-60"
          : checked
            ? "cursor-pointer bg-accent-soft"
            : "cursor-pointer hover:bg-surface-2",
        className,
      )}
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={() => onPick(value)}
          className="size-4 appearance-none rounded-full border border-line-strong bg-surface transition-[border-width] checked:border-[5px] checked:border-accent"
        />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

/** On/off switch (settings rows). Accent when on: it is a state, not an action. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50",
        checked ? "bg-success" : "bg-line-strong",
      )}
    >
      <span
        className={cx(
          "absolute left-0.5 size-5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-150 ease-out-emphasized",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

/*
 * The segmented control (`Segmented`) is written once, in `@quiz/ui`: the
 * question editors use the very same one, their `wrap` and `labelledBy`
 * beside the app's `size` and `label`.
 */
export { Segmented };

/**
 * One option of a `Segmented` that switches between pictures of the same
 * list (table, cards, heat…): the icon alone, its name for the pointer
 * (`title`) and the reader (`sr-only`). A pair of words beside the icons
 * would weigh more than the switch.
 */
export function iconOption<T extends string>(value: T, icon: ReactNode, label: string) {
  return {
    value,
    label: (
      <span title={label} className="flex items-center">
        {icon}
        <span className="sr-only">{label}</span>
      </span>
    ),
  };
}
export { ErrorText } from "@quiz/ui";

/**
 * A field's error, said under it: `fieldErrorProps` on the control whose id
 * is `id` (`aria-invalid`, and `aria-describedby` pointing at the message),
 * `<FieldError id>` under it. Both are nothing while there is no message.
 */
export function fieldErrorProps(id: string, message: ReactNode) {
  return message ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};
}

export function FieldError({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  return children ? (
    <ErrorTextBase id={`${id}-error`} className={className}>
      {children}
    </ErrorTextBase>
  ) : null;
}

/**
 * Settings row: label + a description of the CURRENT choice on the left
 * (one dynamic line, not one per option), the control on the right.
 */
export function SettingRow({
  title,
  desc,
  help,
  children,
  className = "",
}: {
  title: ReactNode;
  desc?: ReactNode;
  help?: string;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    // The row wraps rather than squeezing: the text keeps a 14 rem floor, so a
    // wide control (segmented, select) drops to its own line on a phone while a
    // switch, which costs 40 px, stays on the label's line at any width.
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-56">
        <span id={id} className="flex items-center gap-1 text-sm font-medium text-fg">
          {title}
          {help ? <HelpIcon topic={help} /> : null}
        </span>
        {desc ? <p className="mt-0.5 text-[13px] text-fg-muted">{desc}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}
