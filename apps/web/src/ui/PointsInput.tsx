import { awardedRange, formatPoints } from "@quiz/domain";
import { controlSize } from "@quiz/ui";
import { useId, useState, type InputHTMLAttributes } from "react";

import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { FieldError, fieldErrorProps } from "./controls";
import { cx } from "./layers";
import { useNumberDraft } from "./useNumberDraft";

/** What a points field counts against: `max` (negative for a penalty), or the `bonus` maximum of a bonus criterion. */
export interface PointsBounds {
  max: number;
  bonus?: number;
}

type PointsKind = "max" | "penalty" | "bonus";

export function pointsKind({ max, bonus }: PointsBounds): PointsKind {
  return bonus !== undefined ? "bonus" : max < 0 ? "penalty" : "max";
}

/** Per kind: the words of the range for a screen reader, the sign of the suffix, the magnitude it shows. */
const KIND: Record<PointsKind, { key: keyof Dict; sign: string; n: (b: PointsBounds) => number }> = {
  max: { key: "ui.points.max", sign: "", n: (b) => b.max },
  penalty: { key: "ui.points.penalty", sign: "−", n: (b) => -b.max },
  bonus: { key: "ui.points.bonus", sign: "+", n: (b) => b.bonus ?? 0 },
};

/** The range of a value: `[0, max]`, a penalty `[max, 0]`, a bonus `[0, bonus]` (`awardedRange`, the server's rule). */
export function pointsRange({ max, bonus }: PointsBounds): [number, number] {
  return awardedRange({ maxPoints: max, ...(bonus === undefined ? {} : { bonusPoints: bonus }) });
}

/** "/ 4", a penalty "/ −3" (a real minus sign), a bonus "/ +1". */
export function pointsSuffix(bounds: PointsBounds): string {
  const kind = KIND[pointsKind(bounds)];
  return `/ ${kind.sign}${formatPoints(kind.n(bounds))}`;
}

/**
 * The pill of a points field: the input, bare, and the maximum after it,
 * muted ("3 / 4"). The pill is the field's chrome (its focus ring through
 * `focus-within`); the visible suffix is hidden from a screen reader, which
 * hears the range as the input's description ("points out of 4"). Named by
 * `label`, or by the caller's own `<label htmlFor>`. Controlled like any
 * input; `PointsInput` is the one that commits when the teacher leaves it.
 */
export function PointsPill({
  bounds,
  label,
  invalid = false,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "min" | "max"> & {
  bounds: PointsBounds;
  label?: string;
  invalid?: boolean;
}) {
  const t = useT();
  const rangeId = useId();
  const kind = KIND[pointsKind(bounds)];
  return (
    <span
      className={cx(
        "inline-flex w-28 shrink-0 cursor-text items-center justify-end gap-1.5 rounded-control border bg-surface px-3.5 text-sm text-fg transition-colors",
        controlSize.md.height,
        invalid
          ? "border-danger focus-within:ring-3 focus-within:ring-danger/20"
          : "border-line-strong hover:border-fg-faint focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20",
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
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={[rangeId, props["aria-describedby"]].filter(Boolean).join(" ")}
        className="min-w-0 flex-1 appearance-none bg-transparent p-0 text-right tabular-nums text-fg outline-none placeholder:text-fg-faint [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span aria-hidden className="select-none whitespace-nowrap tabular-nums text-fg-muted">
        {pointsSuffix(bounds)}
      </span>
      <span id={rangeId} hidden>
        {t(kind.key, { n: formatPoints(kind.n(bounds)) })}
      </span>
    </span>
  );
}

/**
 * The points awarded, written when the teacher leaves the field (Enter leaves
 * it, `useNumberDraft`): a value outside the range is said under the pill and
 * never sent; an empty field sends nothing — 0 is a value, "no points" is not
 * one a teacher writes. Key it on the stored value, so a write from elsewhere
 * replaces the text.
 */
export function PointsInput({
  bounds,
  value,
  label,
  onCommit,
}: {
  bounds: PointsBounds;
  value: number | null;
  label: string;
  onCommit: (points: number) => void;
}) {
  const t = useT();
  const errorId = useId();
  const [lo, hi] = pointsRange(bounds);
  const [invalid, setInvalid] = useState(false);
  const draft = useNumberDraft(value, (n) => {
    if (n === null) return;
    const outside = n < lo || n > hi;
    setInvalid(outside);
    if (!outside) onCommit(n);
  });
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <PointsPill
        bounds={bounds}
        label={label}
        {...draft}
        onBlur={() => {
          // Back to the stored value (no commit) is valid again.
          setInvalid(false);
          draft.onBlur();
        }}
        invalid={invalid}
        {...fieldErrorProps(errorId, invalid)}
      />
      <FieldError id={errorId} className="whitespace-nowrap text-xs">
        {invalid ? t("ui.points.range", { min: formatPoints(lo), max: formatPoints(hi) }) : null}
      </FieldError>
    </span>
  );
}
