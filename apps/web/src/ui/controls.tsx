import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

import { cx, HelpIcon, type IconType } from "./layers";

// --- Buttons ---

type ButtonVariant = "primary" | "secondary" | "subtle" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-fill hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-surface-2",
  subtle: "bg-surface-3 text-fg hover:bg-line-strong/70",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  danger: "bg-danger text-on-fill hover:opacity-90",
};
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-3 text-[13px] [&_svg]:size-3.5",
  md: "h-8.5 px-4 text-sm [&_svg]:size-4",
  lg: "h-10 px-5 text-sm [&_svg]:size-4",
};

/** Class list of a button; shared by <Button>, <LinkButton> and raw anchors. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra = "") {
  return cx(
    // disabled:pointer-events-none: hovering a disabled button must hit the
    // wrapping Tip span (disabled controls swallow mouse events).
    "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,color,border-color,opacity,transform] duration-150 ease-out-emphasized active:scale-97 disabled:pointer-events-none disabled:opacity-50",
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    extra,
  );
}

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

/**
 * Field chrome, with no width and no height of its own. Tailwind resolves
 * conflicting utilities by their order in the generated stylesheet, not by
 * their order in the class attribute, so a `w-16` or an `h-8` written next to
 * this string was never guaranteed to win. Size comes from `inputSize` and
 * width from the caller, which both compose instead of fighting.
 */
export const inputClass =
  "rounded-field border border-line-strong bg-surface px-3 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50 disabled:hover:border-line-strong";

/** Control heights, aligned on the button scale of DESIGN.md (sm 28, md 34). */
type InputSize = "sm" | "md";
export const inputSize: Record<InputSize, string> = {
  sm: "h-7",
  md: "h-8.5",
};

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
    <div className="flex items-center gap-1 text-[13px] font-medium text-fg">
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
      <input {...props} id={id} className={cx(inputClass, inputSize[size], "w-full", className)} />
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
      className={cx(inputClass, "min-h-24 w-full py-2 leading-relaxed", className)}
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
  className?: string;
  /** For a chip whose visible label is a bare number ("3" is not a name). */
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] font-medium transition-colors duration-150",
        pressed
          ? "border-accent bg-accent-soft text-accent"
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

/**
 * Segmented control for a small set of mutually exclusive choices: the
 * selected chip is raised (surface + hairline) — selection is structure,
 * never color, the accent stays reserved for primary actions. Native radios
 * underneath (sr-only) keep it a keyboard-accessible radiogroup.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
  size = "md",
  label,
}: {
  /** Groups the native radios (one form can hold several groups). */
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  /**
   * The name of the GROUP, for a radiogroup that has no visible caption of
   * its own — two segmented controls side by side ("Group by", "Sort by")
   * are otherwise two anonymous rows of pills to a screen reader.
   */
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      {...(label === undefined ? {} : { "aria-label": label })}
      className={cx(
        "inline-flex shrink-0 gap-0.5 rounded-full bg-surface-3 p-0.75",
        disabled && "opacity-60",
      )}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className={cx(
            "inline-flex items-center justify-center rounded-full px-3 font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
            size === "sm" ? "h-6 text-xs" : "h-7 text-[13px]",
            value === o.value
              ? "bg-surface text-fg ring-1 ring-line-strong/70"
              : cx("text-fg-muted", !disabled && "cursor-pointer hover:text-fg"),
          )}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            disabled={disabled}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
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
