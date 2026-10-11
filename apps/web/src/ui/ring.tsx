import type { ReactNode } from "react";

import { cx, Tip } from "./layers";

/**
 * A ring of parts (DESIGN.md › Poll outcome donut, › The project page): the
 * generic chart behind the launcher's outcome and the project page's
 * acceptance. The rules are the donut's:
 *
 * - Parts are drawn clockwise from twelve o'clock in the ORDER GIVEN, never
 *   sorted by size; a part of zero is not drawn.
 * - Four tones only: `success`, `warning`, `danger`, and `faint` (`fg-faint`
 *   at half strength, an absence rather than a category).
 * - Never colour alone: 2 px surface gaps part the segments, the figure
 *   sits in the hole, and the ring is a focusable `role="img"` whose
 *   accessible name AND hover/focus bubble are the same `sentence`, which
 *   spells every share out in words.
 *
 * The shares are `value / total`; `total` defaults to the parts' sum, and a
 * larger one leaves the rest of the ring empty (rows no part describes).
 */
export type RingTone = "success" | "warning" | "danger" | "faint";

export interface RingPart {
  value: number;
  tone: RingTone;
  /** The word of the part, for a legend drawn beside the ring (see `RingLegend`). */
  label: string;
}

const STROKE: Record<RingTone, string> = {
  success: "stroke-success",
  warning: "stroke-warning",
  danger: "stroke-danger",
  faint: "stroke-fg-faint/50",
};
const FILL: Record<RingTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  faint: "bg-fg-faint/50",
};

/** The surface gap between two segments, along the ring. */
const GAP = 2;

export function RingChart({
  parts,
  total,
  size = 36,
  thickness = 5,
  hole,
  holeClassName = "text-[10px]",
  sentence,
  className,
}: {
  parts: RingPart[];
  total?: number;
  size?: number;
  thickness?: number;
  /** The figure in the hole. */
  hole?: ReactNode;
  /** Sizes the figure in the hole; `text-[10px]` for a 36 px ring. */
  holeClassName?: string;
  /** Every share in words: the bubble, and the ring's accessible name. */
  sentence: string;
  className?: string;
}) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const sum = parts.reduce((s, p) => s + p.value, 0);
  const whole = Math.max(total ?? sum, sum);
  const drawn = whole > 0 ? parts.filter((p) => p.value > 0) : [];
  const gap = drawn.length > 1 ? GAP : 0;
  let start = 0;
  return (
    <Tip label={sentence}>
      <span
        role="img"
        tabIndex={0}
        aria-label={sentence}
        className={cx("relative grid shrink-0 place-items-center rounded-full", className)}
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
          {drawn.map((part) => {
            const length = (part.value / whole) * circumference;
            const dash = Math.max(length - gap, 0.75);
            const offset = -start;
            start += length;
            return (
              <circle
                key={part.tone}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={offset}
                className={STROKE[part.tone]}
              />
            );
          })}
        </svg>
        {hole !== undefined ? (
          <span className={cx("absolute font-semibold tabular-nums text-fg", holeClassName)} aria-hidden>
            {hole}
          </span>
        ) : null}
      </span>
    </Tip>
  );
}

/** The swatch of a legend, the same token as the segment. */
export const ringFill = (tone: RingTone): string => FILL[tone];

/** One line naming the parts' colours beside a ring: swatch, count and word, never the swatch alone. */
export function RingLegend({ parts, className }: { parts: RingPart[]; className?: string }) {
  return (
    <ul className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted", className)}>
      {parts.map((part) => (
        <li key={part.tone} className="inline-flex items-center gap-1.5">
          <span className={cx("size-2 rounded-full", FILL[part.tone])} aria-hidden />
          <span className="tabular-nums">{part.value}</span> {part.label}
        </li>
      ))}
    </ul>
  );
}
