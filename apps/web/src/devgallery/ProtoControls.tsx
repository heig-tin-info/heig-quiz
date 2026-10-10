/*
 * PROTOTYPES for the go/no-go of issue #552. Dev gallery only: nothing here is
 * exported to the app, and no real screen imports it. If the proposal is a
 * "go", the real components change in their own PRs; these are the picture of
 * the target, not its implementation.
 *
 * One control scale (sm 28 / md 34 / lg 40), every single-line control a pill,
 * textarea and cards keep their soft squares, and a segmented control whose
 * thumb slides.
 */
import { ChevronDown, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { buttonClass, cx, inputClass, type ButtonVariant } from "@quiz/ui";

export type Scale = "sm" | "md" | "lg";

/** The one table: height, text, horizontal padding, and the inner height of a segmented option. */
export const SCALE = {
  sm: { h: "h-7", text: "text-[13px]", px: "px-3", pxIcon: "pl-8", inner: "h-5.5" },
  md: { h: "h-8.5", text: "text-sm", px: "px-4", pxIcon: "pl-9", inner: "h-7" },
  lg: { h: "h-10", text: "text-sm", px: "px-5", pxIcon: "pl-10", inner: "h-8.5" },
} as const;

/** The field chrome with the soft square swapped for the pill, and no padding of its own. */
const pillField = inputClass.replace("rounded-field", "rounded-full").replace(" px-3", "");

export function PButton({
  size = "md",
  variant = "primary",
  children,
  ...rest
}: React.ComponentProps<"button"> & { size?: Scale; variant?: ButtonVariant }) {
  return (
    <button type="button" {...rest} className={buttonClass(variant, size, rest.className)}>
      {children}
    </button>
  );
}

export function PField({ size = "md", className, ...rest }: Omit<React.ComponentProps<"input">, "size"> & { size?: Scale }) {
  return <input {...rest} className={cx(pillField, SCALE[size].h, SCALE[size].px, SCALE[size].text, "w-full", className)} />;
}

/** The search box IS a field with a leading icon. */
export function PSearch({ size = "md", className = "w-56", ...rest }: Omit<React.ComponentProps<"input">, "size"> & { size?: Scale }) {
  return (
    <label className={cx("relative block", className)}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
      <input
        type="search"
        {...rest}
        className={cx(pillField, SCALE[size].h, SCALE[size].text, SCALE[size].pxIcon, "w-full pr-4")}
      />
    </label>
  );
}

export function PSelect({ size = "md", className = "w-44", children, ...rest }: Omit<React.ComponentProps<"select">, "size"> & { size?: Scale }) {
  return (
    <span className={cx("relative block", className)}>
      <select
        {...rest}
        className={cx(pillField, SCALE[size].h, SCALE[size].px, SCALE[size].text, "w-full appearance-none pr-9")}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
    </span>
  );
}

export function PChip({
  size = "md",
  pressed,
  onToggle,
  disabled,
  children,
}: {
  size?: Scale;
  pressed: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onToggle}
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50",
        SCALE[size].h,
        SCALE[size].px,
        SCALE[size].text,
        pressed
          ? "border-accent bg-accent-soft text-accent"
          : "border-line-strong bg-surface text-fg-muted hover:border-fg-faint hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

interface Thumb {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Segmented control with a sliding thumb. The native radios stay (arrow keys,
 * grouping, announcement come from the platform); the thumb is a decorative
 * span positioned from the selected label's measured box, so labels of any
 * width, and a wrapped second row, work without a per-option width.
 */
export function PSegmented<T extends string>({
  name,
  value,
  options,
  onChange,
  size = "md",
  wrap,
  disabled,
  label,
}: {
  name: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  size?: Scale;
  wrap?: boolean;
  disabled?: boolean;
  label: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<Thumb | null>(null);
  // The first placement must not animate in from 0,0.
  const [armed, setArmed] = useState(false);

  const measure = useCallback(() => {
    const on = track.current?.querySelector<HTMLElement>('[data-on="true"]');
    setThumb(on ? { left: on.offsetLeft, top: on.offsetTop, width: on.offsetWidth, height: on.offsetHeight } : null);
  }, []);

  useLayoutEffect(measure, [measure, value, size, wrap, options.length]);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArmed(true));
    const el = track.current;
    const ro = new ResizeObserver(measure);
    if (el) ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [measure]);

  return (
    <div
      ref={track}
      role="radiogroup"
      aria-label={label}
      className={cx(
        "relative gap-0.5 bg-surface-3 p-0.75",
        wrap ? "flex w-full flex-wrap rounded-card" : "inline-flex shrink-0 rounded-full",
        disabled && "opacity-60",
      )}
    >
      {thumb ? (
        <span
          aria-hidden
          data-thumb
          className={cx(
            "pointer-events-none absolute rounded-full bg-surface shadow-sm ring-1 ring-line-strong/70",
            armed && "transition-[left,top,width,height] duration-200 ease-out-emphasized motion-reduce:transition-none",
          )}
          style={thumb}
        />
      ) : null}
      {options.map((o) => {
        const on = value === o.value;
        return (
          <label
            key={o.value}
            data-on={on}
            className={cx(
              "relative z-10 inline-flex items-center justify-center rounded-full font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
              SCALE[size].inner,
              SCALE[size].px,
              size === "sm" ? "text-xs" : "text-[13px]",
              on ? "text-fg" : cx("text-fg-muted", !disabled && "cursor-pointer hover:text-fg"),
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={on}
              disabled={disabled}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}
