import { formatGrade, MAX_GRADE } from "@quiz/domain";
import type { ResultsStats } from "@quiz/contracts";

import { useT } from "../i18n";
import { cx } from "../ui";

/** How the buckets of `@quiz/domain#histogram` are named on screen. */
export function bucketLabel(bucket: number, step: number): string {
  if (bucket >= MAX_GRADE) return formatGrade(bucket);
  return `${formatGrade(bucket)}–${formatGrade(bucket + step)}`;
}

/**
 * The grade distribution, 1.0 to 6.0 in half-grade buckets (F-RES-01).
 *
 * Plain `<div>` bars on the tokens rather than a chart library: eleven
 * numbers do not need an SVG runtime, and a bar whose height is a percentage
 * survives every width the page has. Neutral ink, not the accent — a
 * histogram is a reading, not the thing to press.
 *
 * The bars are `aria-hidden` and the same numbers are published as a real
 * table, visually hidden: a screen reader gets the data, not a shape.
 */
export function Histogram({
  buckets,
  step = 0.5,
}: {
  buckets: ResultsStats["histogram"];
  step?: number;
}) {
  const t = useT();
  const top = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div>
      <div className="flex h-32 items-end gap-1" aria-hidden>
        {buckets.map((b) => (
          <div key={b.bucket} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1">
            <span className="text-center text-[11px] tabular-nums text-fg-faint">
              {b.count || ""}
            </span>
            <span
              className={cx(
                "w-full rounded-t-[4px]",
                b.count === 0 ? "bg-surface-3" : "bg-fg-muted",
              )}
              style={{ height: `${Math.max(b.count === 0 ? 2 : 6, (b.count / top) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1 border-t border-line pt-1.5" aria-hidden>
        {buckets.map((b) => (
          <span
            key={b.bucket}
            className="min-w-0 flex-1 text-center text-[10px] tabular-nums text-fg-faint"
          >
            {Number.isInteger(b.bucket) ? b.bucket.toFixed(0) : ""}
          </span>
        ))}
      </div>
      {/* `sr-only` and nothing else: a width utility beside it wins by
          stylesheet order and turns the hidden table into 1440 px of
          absolutely positioned overflow. */}
      <table className="sr-only">
        <caption>{t("results.histogram.title")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("results.histogram.col.range")}</th>
            <th scope="col">{t("results.histogram.col.count")}</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.bucket}>
              <th scope="row">{bucketLabel(b.bucket, step)}</th>
              <td>{b.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
