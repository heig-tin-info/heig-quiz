import { formatGrade, gradeBand, MAX_GRADE } from "@quiz/domain";
import type { ResultsStats } from "@quiz/contracts";

import { GRADE_BAND_TONE } from "../Grade";
import { useT } from "../i18n";
import { Bars } from "../ui";

/** How the buckets of `@quiz/domain#histogram` are named on screen. */
export function bucketLabel(bucket: number, step: number): string {
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
  className,
}: {
  buckets: ResultsStats["histogram"];
  step?: number;
  /** The height of the plot (`Bars`). */
  className?: string;
}) {
  const t = useT();
  return (
    <Bars
      showValues
      {...(className ? { className } : {})}
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
        tone: GRADE_BAND_TONE[gradeBand(b.bucket)],
      }))}
    />
  );
}
