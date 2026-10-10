/**
 * The bare form controls of the product, on the control scale (ADR-094): a
 * one-line input, a select and a button. They are the elements the question
 * types and `apps/web` both used to write by hand; `apps/web`'s `Field`,
 * `Select` and `Button` add a label, help and a spinner around these.
 *
 * Nothing here carries a word of its own (invariant 1): a caller passes the
 * label as `aria-label` or points a `<label>` at the control.
 */
import type { ComponentPropsWithRef, ReactNode } from "react";

import { StrokeIcon } from "./icon.js";
import {
  buttonClass,
  controlSize,
  cx,
  inputClass,
  inputSize,
  type ButtonSize,
  type ButtonVariant,
  type ControlSize,
} from "./styles.js";

/** A one-line field: the pill, the height and padding of its step of the scale. */
export function TextInput({
  size = "md",
  className,
  type = "text",
  ...props
}: Omit<ComponentPropsWithRef<"input">, "size"> & { size?: ControlSize | undefined }): ReactNode {
  return <input type={type} {...props} className={cx(inputClass, inputSize[size], className)} />;
}

/**
 * A native select in the field family: the pill, a chevron and the right
 * padding that clears it. `width` sits on the wrapper that carries the
 * chevron (a width on the `<select>` itself would leave the chevron behind);
 * without it the select sizes to its parent. `inline` lets it sit in running
 * text (a cloze blank); `wrapperClassName` styles that wrapper (a margin).
 */
export function Select({
  size = "md",
  width,
  inline,
  wrapperClassName,
  className,
  children,
  ...props
}: Omit<ComponentPropsWithRef<"select">, "size"> & {
  size?: ControlSize | undefined;
  width?: string | undefined;
  inline?: boolean | undefined;
  wrapperClassName?: string | undefined;
}): ReactNode {
  return (
    <span className={cx("relative", inline ? "inline-block" : "block", width, wrapperClassName)}>
      <select
        {...props}
        className={cx(inputClass, inputSize[size], "block w-full appearance-none leading-none", controlSize[size].padRight, className)}
      >
        {children}
      </select>
      <StrokeIcon
        className={cx(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-fg-faint",
          controlSize[size].icon,
          controlSize[size].edgeRight,
        )}
        strokeWidth={2}
      >
        <path d="m6 9 6 6 6-6" />
      </StrokeIcon>
    </span>
  );
}

/** A button of the scale: `buttonClass` on a `<button type="button">`. */
export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
}): ReactNode {
  return <button type={type} {...props} className={buttonClass(variant, size, className)} />;
}

const ICON_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-full text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40";

/** The two disc sizes of an icon button, which stays outside the control scale (ADR-094). */
export const iconButtonClass = {
  /** 24 px: the bin of a card or a column. */
  xs: cx(ICON_BUTTON, "size-6"),
  /** 28 px: the bin and the `+` of a row. */
  sm: cx(ICON_BUTTON, "size-7"),
} as const;

/** An icon-only disc. The accessible name is `label` (a tooltip is the caller's, `Tip` or `title`); the icon is its child. */
export function IconButton({
  label,
  size = "sm",
  className,
  type = "button",
  ...props
}: Omit<ComponentPropsWithRef<"button">, "aria-label"> & {
  label: string;
  size?: keyof typeof iconButtonClass | undefined;
}): ReactNode {
  return <button type={type} aria-label={label} {...props} className={cx(iconButtonClass[size], className)} />;
}
