import { awardedRange, formatPoints } from "@quiz/domain";
import { controlSize } from "@quiz/ui";
import { useState, type InputHTMLAttributes } from "react";

import { useT } from "../i18n";
import { cx } from "./layers";
import { useNumberDraft } from "./useNumberDraft";

/**
 * What a points field bounds: `max` the maximum (negative for a penalty),
 * `bonus` the bonus maximum of a bonus criterion, which has no maximum of its
 * own, `min` a floor other than the kind's own (negative marking, ADR-026).
 */
export interface PointsBounds {
  max: number;
  bonus?: number;
  min?: number;
}

/**
 * The range a value may take: a normal maximum `[0, max]`, a penalty
 * (`max < 0`) `[max, 0]`, a bonus `[0, bonus]` (`awardedRange`, the rule the
 * server applies); a caller's `min` replaces the floor.
 */
export function pointsRange({ max, bonus, min }: PointsBounds): [number, number] {
  const [lo, hi] = awardedRange({ maxPoints: max, ...(bonus === undefined ? {} : { bonusPoints: bonus }) });
  return [min ?? lo, hi];
}

/** "/ 4", a penalty "/ −3" (a real minus sign), a bonus "/ +1". */
export function pointsSuffix({ max, bonus }: PointsBounds): string {
  if (bonus !== undefined) return `/ +${formatPoints(bonus)}`;
  return max < 0 ? `/ −${formatPoints(-max)}` : `/ ${formatPoints(max)}`;
}

/**
 * The pill of a points field: the input, bare, and the maximum after it, muted
 * ("3 / 4"). The pill is the field's chrome — its border, its hover, its focus
 * ring through `focus-within` (the input itself draws none) —, so the value
 * and what it counts against read as one control. The suffix is hidden from a
 * screen reader: the accessible name says it ("Tests, points out of 4").
 * Controlled like any input (a form that checks on submit wears it so);
 * `PointsInput` is the one that commits when the teacher leaves it.
 */
export function PointsPill({
  max,
  bonus,
  min,
  label,
  invalid = false,
  disabled,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "max" | "min" | "size"> &
  PointsBounds & {
    /** What is graded (a criterion, "Points"): the start of the accessible name. */
    label: string;
    invalid?: boolean;
  }) {
  const t = useT();
  const name =
    bonus !== undefined
      ? t("ui.points.bonus", { label, n: formatPoints(bonus) })
      : max < 0
        ? t("ui.points.penalty", { label, n: formatPoints(-max) })
        : t("ui.points.label", { label, max: formatPoints(max) });
  const [lo, hi] = pointsRange({ max, ...(bonus === undefined ? {} : { bonus }), ...(min === undefined ? {} : { min }) });
  return (
    <span
      className={cx(
        "inline-flex w-28 shrink-0 cursor-text items-center justify-end gap-1.5 rounded-control border bg-surface px-3.5 text-sm text-fg transition-colors",
        controlSize.md.height,
        invalid
          ? "border-danger focus-within:ring-3 focus-within:ring-danger/20"
          : "border-line-strong hover:border-fg-faint focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      // A click on the pill (on the suffix, in the padding) lands in the input.
      onMouseDown={(e) => {
        const input = e.currentTarget.querySelector("input");
        if (input && e.target !== input) {
          e.preventDefault();
          input.focus();
        }
      }}
    >
      <input
        type="number"
        inputMode="decimal"
        step={0.5}
        placeholder="—"
        {...props}
        min={lo}
        max={hi}
        disabled={disabled}
        aria-label={name}
        aria-invalid={invalid || undefined}
        className="min-w-0 flex-1 appearance-none bg-transparent p-0 text-right tabular-nums text-fg outline-none placeholder:text-fg-faint [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span aria-hidden className="select-none whitespace-nowrap tabular-nums text-fg-muted">
        {pointsSuffix({ max, ...(bonus === undefined ? {} : { bonus }) })}
      </span>
    </span>
  );
}

/**
 * The points awarded, written when the teacher leaves the field (Enter leaves
 * it, `useNumberDraft`): a value outside the range is marked on the pill
 * (`aria-invalid`) and never sent; an empty field sends nothing — 0 is a
 * value, "no points" is not one a teacher writes. Key it on the stored value,
 * so a write from elsewhere replaces the text.
 */
export function PointsInput({
  value,
  max,
  bonus,
  min,
  label,
  disabled,
  onCommit,
  onInvalid,
  describedBy,
}: PointsBounds & {
  value: number | null;
  label: string;
  disabled?: boolean;
  onCommit: (points: number) => void;
  /** Told whether the value left is outside the range, so the caller can say why under the pill. */
  onInvalid?: (invalid: boolean) => void;
  /** The id of the error line under the pill, read with it. */
  describedBy?: string;
}) {
  const bounds = { max, ...(bonus === undefined ? {} : { bonus }), ...(min === undefined ? {} : { min }) };
  const [lo, hi] = pointsRange(bounds);
  const [invalid, setInvalidState] = useState(false);
  const setInvalid = (next: boolean) => {
    setInvalidState(next);
    onInvalid?.(next);
  };
  const draft = useNumberDraft(value, (n) => {
    if (n === null) return;
    const outside = n < lo || n > hi;
    setInvalid(outside);
    if (!outside) onCommit(n);
  });
  return (
    <PointsPill
      {...bounds}
      {...draft}
      onBlur={() => {
        // Back to the stored value (no commit) is valid again.
        setInvalid(false);
        draft.onBlur();
      }}
      label={label}
      disabled={disabled}
      invalid={invalid}
      aria-describedby={describedBy}
    />
  );
}
