import { formatGrade, gradeBand, MAX_GRADE, type GradeBand } from "@quiz/domain";
import type { ResultsStats } from "@quiz/contracts";

import { useT } from "../i18n";
import { Bars, type BarTone } from "../ui";

/**
 * A band's fill on a bar: red below the pass mark and orange just above it,
 * as a grade is written (`GRADE_BAND_TONE`); green above that, where the
 * written grade keeps the ink — a bar is a share of the class, and the
 * passing share reads at a glance (#1083).
 */
export const GRADE_BAND_BAR = {
  fail: "danger",
  borderline: "warning",
  pass: "success",
} as const satisfies Record<GradeBand, BarTone>;

/** How the buckets of `@quiz/domain#histogram` are named on screen. */
export function bucketLabel(bucket: number, step = 0.5): string {
  if (bucket >= MAX_GRADE) return formatGrade(bucket);
  return `${formatGrade(bucket)}–${formatGrade(bucket + step)}`;
}

/**
 * The grade distribution, 1.0 to 6.0 in half-grade buckets (F-RES-01),
 * through the shared `Bars`: eleven numbers, each count above its bar, the
 * whole grades under the axis, and the same figures as a hidden table.
 */
export function Histogram({
  buckets,
  step = 0.5,
  onSelect,
  selected,
  className,
}: {
  buckets: ResultsStats["histogram"];
  step?: number;
  /** A bar pressed, by its bucket: the filter of a grade table. */
  onSelect?: ((bucket: number) => void) | undefined;
  /** The bucket chosen, marked on its bar. */
  selected?: number | null | undefined;
  /** The height of the plot (`Bars`). */
  className?: string;
}) {
  const t = useT();
  return (
    <Bars
      showValues
      {...(className ? { className } : {})}
      onSelect={onSelect && ((key) => onSelect(Number(key)))}
      selected={selected == null ? null : String(selected)}
      caption={t("results.histogram.title")}
      labelHeader={t("results.histogram.col.range")}
      valueHeader={t("results.histogram.col.count")}
      bars={buckets.map((b) => ({
        key: String(b.bucket),
        value: b.count,
        label: bucketLabel(b.bucket, step),
        tick: Number.isInteger(b.bucket) ? b.bucket.toFixed(0) : "",
        // The buckets are half grades, so 4.0 and 4.5 fall on their edges:
        // a bucket's band is its lower bound's (the letters would not be).
        tone: GRADE_BAND_BAR[gradeBand(b.bucket)],
      }))}
    />
  );
}
