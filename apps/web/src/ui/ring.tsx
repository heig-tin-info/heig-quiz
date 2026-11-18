import type { CSSProperties, ReactNode } from "react";

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
 * larger one leaves the rest of the ring empty (rows no part describes), or
 * on its `track`.
 *
 * A part may sit on the red-to-green ramp instead of a tone (`ramp`): the
 * live grid's `.score-ramp`, at the part's own share of the ring, as a
 * stroke that deepens with it (`.score-ramp-stroke`) — a single rate drawn
 * as an arc over the track (`RateRing`).
 */
export type RingTone = "success" | "warning" | "danger" | "faint";

export interface RingPart {
  value: number;
  tone: RingTone | "ramp";
}

const STROKE: Record<RingPart["tone"], string> = {
  success: "stroke-success",
  warning: "stroke-warning",
  danger: "stroke-danger",
  faint: "stroke-fg-faint/50",
  ramp: "score-ramp-stroke",
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
  track = false,
  className,
}: {
  parts: RingPart[];
  total?: number;
  size?: number;
  thickness?: number;
  /** The whole ring drawn under the parts, in `surface-3` (a segmented track's): the empty rest then reads as one. */
  track?: boolean;
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
          {track ? (
            <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={thickness} className="stroke-surface-3" />
          ) : null}
          {drawn.map((part, i) => {
            const length = (part.value / whole) * circumference;
            const dash = Math.max(length - gap, 0.75);
            const offset = -start;
            start += length;
            return (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={offset}
                className={STROKE[part.tone]}
                style={part.tone === "ramp" ? ({ "--rate": `${Math.round((part.value / whole) * 100)}%` } as CSSProperties) : undefined}
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

/**
 * One rate as a small ring (20 px by default): an arc as long as the rate,
 * on the red-to-green ramp, over the track. A rate below 0 draws nothing,
 * above 1 the whole ring. The figure is beside it, never inside: the
 * caller writes it, and `sentence` says it to a screen reader and on hover.
 */
export function RateRing({ rate, sentence, size = 20 }: { rate: number; sentence: string; size?: number }) {
  const share = Math.min(Math.max(rate, 0), 1);
  return <RingChart parts={[{ value: share, tone: "ramp" }]} total={1} size={size} thickness={3} track sentence={sentence} />;
}

/** The swatch of a legend: the same token as the segment. */
export const ringFill = (tone: RingTone): string => FILL[tone];
