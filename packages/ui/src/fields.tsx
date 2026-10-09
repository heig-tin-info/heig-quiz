/**
 * The small form controls the editors are made of (audit P-01d, h, j, n):
 * a segmented control, a labelled cell, a labelled number field and a
 * checkbox with its word. Native elements every time — the keyboard, the
 * grouping and the announcement come from the platform.
 */
import type { ReactNode } from "react";

import { cx, inputClass, inputSize, label as labelToken } from "./styles.js";

/**
 * The segmented control of the whole product — `apps/web` re-exports this
 * one: a pill track on `surface-3`, the selected option lifted onto `surface`
 * with a hairline ring (selection is structure, never colour: the accent
 * stays for primary actions). At `md` its track is 34 px tall, the height of
 * a field, so a segmented control and the fields beside it sit on one
 * baseline; `sm` is the dense toolbar variant.
 *
 * Native radios, visually hidden inside the labels: the arrow keys, the
 * grouping and the announcement come from the platform rather than from a
 * `role="radiogroup"` re-implementation.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
  size = "md",
  wrap,
  label,
  labelledBy,
}: {
  /** Groups the native radios (one form holds several groups). */
  name: string;
  value: T;
  /** An option may be disabled on its own, with the `title` that says why. */
  options: ReadonlyArray<{ value: T; label: ReactNode; disabled?: boolean | undefined; title?: string | undefined }>;
  onChange: (value: T) => void;
  disabled?: boolean | undefined;
  size?: "sm" | "md" | undefined;
  /**
   * The name of the GROUP, for a radiogroup with no visible caption of its
   * own — two segmented controls side by side ("Group by", "Sort by") are
   * otherwise two anonymous rows of pills to a screen reader. With a visible
   * caption, point at it with `labelledBy` instead.
   */
  label?: string | undefined;
  /**
   * Lets the pills fall on a second row instead of sizing the track to their
   * total width. Six policies do not fit the 288 px right column on one line,
   * and a track that overflows its card is worse than a track two rows tall —
   * the pill radius is what says "press me", and it survives the wrap.
   */
  wrap?: boolean | undefined;
  /**
   * The id of the element that names the group. A segmented control is a
   * radiogroup, and a radiogroup without a name is six pills the reader has
   * to guess the subject of.
   */
  labelledBy?: string | undefined;
}): ReactNode {
  return (
    <div
      role="radiogroup"
      {...(label === undefined ? {} : { "aria-label": label })}
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      className={cx(
        "gap-0.5 bg-surface-3 p-0.75",
        // A track two rows tall is not a pill any more: `rounded-full` on it
        // draws two half-circles the height of both rows. It becomes what it
        // now is — a recessed panel — and keeps the card radius of the design
        // scale, while the pills inside stay pills.
        wrap ? "flex w-full flex-wrap rounded-card" : "inline-flex shrink-0 rounded-full",
        disabled && "opacity-60",
      )}
    >
      {options.map((o) => (
        <label
          key={o.value}
          {...(o.title === undefined ? {} : { title: o.title })}
          className={cx(
            o.disabled && "opacity-60",
            "inline-flex items-center justify-center rounded-full px-3 font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
            size === "sm" ? "h-6 text-xs" : "h-7 text-[13px]",
            value === o.value
              ? "bg-surface text-fg ring-1 ring-line-strong/70"
              : cx("text-fg-muted", !disabled && !o.disabled && "cursor-pointer hover:text-fg"),
          )}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={value === o.value}
            disabled={disabled || o.disabled}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** How a {@link FieldCell} is dressed, beyond its label and its control. */
export interface FieldCellChrome {
  /** The label token of the caller's family; `label` of the shared table by default. */
  labelClassName?: string | undefined;
  /** Added to the column (`min-w-40 flex-1`, …). */
  className?: string | undefined;
  /** The space between the label and the control; `gap-1.5` by default. */
  gap?: string | undefined;
  /**
   * Read after the label by a screen reader only: the row number of a label
   * several rows share, so "Value" of row 2 is announced "Value 2".
   */
  srSuffix?: ReactNode;
}

/** One cell of a row of labelled fields: the label above, the control below. */
export function FieldCell({
  label,
  htmlFor,
  labelClassName = labelToken,
  className,
  gap = "gap-1.5",
  srSuffix,
  children,
}: FieldCellChrome & {
  label: ReactNode;
  htmlFor?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={cx("flex flex-col", gap, className)}>
      <label className={labelClassName} {...(htmlFor === undefined ? {} : { htmlFor })}>
        {label}
        {srSuffix === undefined ? null : <span className="sr-only"> {srSuffix}</span>}
      </label>
      {children}
    </div>
  );
}

/**
 * A labelled number field, right-aligned in tabular figures.
 *
 * An EMPTY field calls `onClear` when the caller gave one — a nullable
 * number: "no budget", "any exit code", "no rail" — and `onChange(0)`
 * otherwise. A value that is not a finite number shows as an empty field
 * rather than as `NaN`.
 */
export function NumberField({
  id,
  label,
  value,
  onChange,
  onClear,
  disabled,
  min,
  max,
  step,
  placeholder,
  width = "w-28",
  size = "sm",
  "aria-label": ariaLabel,
  ...chrome
}: FieldCellChrome & {
  id: string;
  label: ReactNode;
  value: number | null;
  onChange: (value: number) => void;
  onClear?: (() => void) | undefined;
  disabled?: boolean | undefined;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | string | undefined;
  placeholder?: string | undefined;
  width?: string;
  /** The control height: `sm` 28 px in a dense row (the default), `md` 34 px in a form. */
  size?: keyof typeof inputSize;
  /** When the visible label is shared by several rows ("Points" → "Points 2"). */
  "aria-label"?: string | undefined;
}): ReactNode {
  return (
    <FieldCell label={label} htmlFor={id} {...chrome}>
      <input
        id={id}
        type="number"
        className={cx(inputClass, inputSize[size], width, "text-right tabular-nums")}
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
        disabled={disabled}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        {...(step === undefined ? {} : { step })}
        {...(placeholder === undefined ? {} : { placeholder })}
        value={value === null || !Number.isFinite(value) ? "" : value}
        onChange={(e) => {
          if (e.target.value !== "") onChange(Number(e.target.value));
          else if (onClear) onClear();
          else onChange(0);
        }}
      />
    </FieldCell>
  );
}

/**
 * A checkbox and its word. The default chrome is `h-8.5`, the height of a
 * field, so a checkbox dropped into a row of labelled fields lands on their
 * baseline instead of floating half a line above it; `className` replaces it
 * where the checkbox stands in a list of settings instead.
 */
export function CheckboxField({
  label,
  checked,
  onChange,
  disabled,
  "aria-label": ariaLabel,
  className = "inline-flex h-8.5 items-center gap-1.5 text-[13px] text-fg-muted",
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  /** When the visible word is shared by several rows ("Hidden" → "Hidden 2"). */
  "aria-label"?: string | undefined;
  className?: string | undefined;
}): ReactNode {
  return (
    <label className={className}>
      <input
        type="checkbox"
        className="size-4 accent-accent"
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
