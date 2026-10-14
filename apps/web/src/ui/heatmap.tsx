/**
 * The hour heatmap (DESIGN.md, "The activity heatmap"): rows of 24 hourly
 * figures on one sequential hue, the hours outside class hatched, and its
 * legend. Drawn by the administrator's platform activity (ADR-107) and the
 * drill's hours of the week (ADR-041 §8); what a row is and what a figure
 * counts belong to the caller, who words the cells' sentences.
 */
import { CLASS_HOURS, SCHOOL_TIME_ZONE } from "@quiz/domain";

import { useT } from "../i18n";
import { cx } from "./layers";

/** The five steps of the ramp (`--heat-1..5`), and their ink. */
const STEPS = [
  "bg-heat-1 text-fg",
  "bg-heat-2 text-fg",
  "bg-heat-3 text-fg",
  "bg-heat-4 text-heat-ink-4",
  "bg-heat-5 text-on-fill",
] as const;

/** The step of `value` on a scale that ends at `top`: 0 for nothing, else 1–5. */
export function heatStep(value: number, top: number): number {
  if (value <= 0 || top <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil((value / top) * 5)));
}

/** Outside class hours: a hatch over whatever the cell holds, faint enough to keep its figure legible. */
const OFF_HOURS = "bg-[image:repeating-linear-gradient(135deg,color-mix(in_srgb,var(--fg)_11%,transparent)_0_1.5px,transparent_1.5px_6px)]";

/** An hour as two digits. */
export const padHour = (h: number) => String(h).padStart(2, "0");

/** The class-hours window in words, with its zone: "Mon–Fri 08:00–18:00 (Europe/Zurich)". */
export function useClassHoursWindow(): string {
  const t = useT();
  return t("heatmap.window", {
    start: padHour(CLASS_HOURS.weekdayStart),
    end: padHour(CLASS_HOURS.weekdayEnd),
    zone: SCHOOL_TIME_ZONE,
  });
}

export interface HeatRow {
  key: string;
  label: string;
  /** Set apart in `fg` and 600 (today, on a dated grid). */
  strong?: boolean;
  /** Twenty-four figures, from 00:00. */
  hours: readonly number[];
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * Rows of 24 hours: a real table, so a screen reader reads each figure under
 * its row and its hour; a cell's `title` says it in a sentence. With
 * `footer`, the sum per hour closes it as a row of bars on the same columns.
 */
export function HourHeatmap({
  caption,
  rowHeader,
  rows,
  isClassHour,
  cellTitle,
  footer,
}: {
  caption: string;
  /** The (screen-reader) header of the rows' column. */
  rowHeader: string;
  rows: readonly HeatRow[];
  isClassHour: (row: number, hour: number) => boolean;
  cellTitle: (row: HeatRow, hour: number, n: number, off: boolean) => string;
  footer?: { label: string; title: (hour: number, n: number) => string };
}) {
  const top = Math.max(0, ...rows.flatMap((r) => r.hours));
  const sums = HOURS.map((h) => rows.reduce((s, r) => s + (r.hours[h] ?? 0), 0));
  const topSum = Math.max(1, ...sums);
  return (
    // The grid scrolls inside its card on a phone; the page never does.
    // `relative`: the cells' `sr-only` words are positioned against this
    // box, so they scroll with it instead of widening the page.
    <div className="relative -mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0.5 text-[11px] tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col className="w-24" />
          {HOURS.map((h) => (
            <col key={h} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              {rowHeader}
            </th>
            {HOURS.map((h) => (
              <th key={h} scope="col" className="pb-1 text-center font-normal text-fg-faint">
                <span aria-hidden>{h}</span>
                <span className="sr-only">{`${padHour(h)}:00`}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row.key}>
              <th
                scope="row"
                className={cx(
                  "whitespace-nowrap pr-2 text-left text-xs font-normal",
                  row.strong ? "font-semibold text-fg" : "text-fg-muted",
                )}
              >
                {row.label}
              </th>
              {row.hours.map((value, h) => {
                const step = heatStep(value, top);
                const off = !isClassHour(r, h);
                return (
                  <td
                    key={h}
                    title={cellTitle(row, h, value, off)}
                    data-off={off || undefined}
                    className={cx(
                      "h-7 rounded-[3px] p-0 text-center align-middle",
                      step === 0 ? "bg-surface-2 text-fg-faint" : STEPS[step - 1],
                      off && OFF_HOURS,
                    )}
                  >
                    {value > 0 ? value : <span className="sr-only">0</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr>
              <th scope="row" className="pr-2 pt-2 text-left align-bottom text-xs font-normal text-fg-muted">
                {footer.label}
              </th>
              {sums.map((sum, h) => (
                <td key={h} className="h-10 p-0 pt-2 align-bottom" title={footer.title(h, sum)}>
                  <div
                    aria-hidden
                    className={cx("mx-auto w-full rounded-t-[3px]", sum > 0 ? "bg-heat-4" : "bg-line")}
                    style={{ height: sum > 0 ? `${Math.max(12, (sum / topSum) * 100)}%` : "2px" }}
                  />
                  <span className="sr-only">{sum}</span>
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/** The ramp, from fewer to more, and what the hatch means. */
export function HeatLegend() {
  const t = useT();
  const window = useClassHoursWindow();
  const swatch = "inline-block size-3 rounded-[3px]";
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-fg-muted">
      <span className="inline-flex items-center gap-1.5">
        {t("heatmap.legend.fewer")}
        <span aria-hidden className="inline-flex gap-0.5">
          {STEPS.map((step) => (
            <span key={step} className={cx(swatch, step)} />
          ))}
        </span>
        {t("heatmap.legend.more")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={cx(swatch, "border border-line bg-surface-2", OFF_HOURS)} />
        {t("heatmap.legend.off", { window })}
      </span>
    </div>
  );
}
