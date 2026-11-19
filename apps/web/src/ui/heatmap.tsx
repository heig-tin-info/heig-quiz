/**
 * The heatmap (DESIGN.md, "The activity heatmap"): rows of figures on one
 * sequential hue, and its legend. `HourHeatmap` draws 24 hourly columns,
 * the hours outside class hatched: the administrator's platform activity
 * (ADR-107) and the drill's hours of the week (ADR-041 §8). `HeatTable`
 * takes any columns: a repository's commits per member and per week
 * (ADR-137). What a row is and what a figure counts belong to the caller,
 * who words the cells' sentences.
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

/** A column of a `HeatTable`: its visible head (null: none, a label every few columns) and what a screen reader hears. */
export interface HeatColumn {
  key: string;
  label: string | null;
  srLabel: string;
}

/** A row of a `HeatTable`: one figure per column. */
export interface HeatTableRow {
  key: string;
  label: string;
  /** Set apart in `fg` and 600 (today, on a dated grid). */
  strong?: boolean;
  values: readonly number[];
}

/**
 * Rows of figures on the heat ramp, one per column: a real table, so a
 * screen reader reads each figure under its row and its column; a cell's
 * `title` says it in a sentence. The step is the cell's share of the
 * table's largest figure, rounded up; an empty cell is `surface-2`.
 * `hatched` lays the off-hours texture over a cell; with `footer`, the sum
 * per column closes it as a row of bars on the same columns.
 *
 * `compact` fits the columns in a narrow box (a sheet) instead of
 * scrolling: no minimum width, short rows, and the figures printed only
 * where the box is wide enough to hold them (a container query); the title
 * and the screen reader keep every figure. Otherwise the table keeps
 * `minWidth` and scrolls inside its box; the page never does. `fixed`
 * gives every column one width, the table starting at the left instead of
 * stretching its few columns across the box (a repository's weeks).
 */
export function HeatTable({
  caption,
  rowHeader,
  columns,
  rows,
  cellTitle,
  hatched,
  footer,
  compact = false,
  minWidth = "46rem",
  fixed,
}: {
  caption: string;
  /** The (screen-reader) header of the rows' column. */
  rowHeader: string;
  columns: readonly HeatColumn[];
  rows: readonly HeatTableRow[];
  cellTitle: (row: number, column: number, n: number) => string;
  hatched?: (row: number, column: number) => boolean;
  footer?: { label: string; title: (column: number, n: number) => string };
  compact?: boolean;
  minWidth?: string;
  /** One width per column, and the rows' header's (CSS lengths): the table is as wide as they add up to. */
  fixed?: { rowHeader: string; column: string };
}) {
  const top = Math.max(0, ...rows.flatMap((r) => r.values));
  const sums = columns.map((_, c) => rows.reduce((s, r) => s + (r.values[c] ?? 0), 0));
  const topSum = Math.max(1, ...sums);
  return (
    // The grid scrolls inside its card on a phone; the page never does.
    // `relative`: the cells' `sr-only` words are positioned against this
    // box, so they scroll with it instead of widening the page.
    <div className={compact ? "@container relative overflow-x-auto" : "relative -mx-4 overflow-x-auto px-4"}>
      <table
        className={cx("table-fixed border-separate border-spacing-0.5 tabular-nums", !fixed && "w-full", compact ? "text-[10px]" : "text-[11px]")}
        style={
          fixed
            ? { width: `calc(${fixed.rowHeader} + ${columns.length} * (${fixed.column} + 2px) + 2px)` }
            : compact
              ? undefined
              : { minWidth }
        }
      >
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col className={fixed ? undefined : compact ? "w-10" : "w-24"} style={fixed ? { width: fixed.rowHeader } : undefined} />
          {columns.map((c) => (
            <col key={c.key} style={fixed ? { width: fixed.column } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              {rowHeader}
            </th>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="whitespace-nowrap pb-1 text-center font-normal text-fg-faint">
                {c.label === null ? null : <span aria-hidden>{c.label}</span>}
                <span className="sr-only">{c.srLabel}</span>
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
                  "truncate whitespace-nowrap pr-2 text-left text-xs font-normal",
                  row.strong ? "font-semibold text-fg" : "text-fg-muted",
                )}
              >
                {row.label}
              </th>
              {row.values.map((value, c) => {
                const step = heatStep(value, top);
                const off = hatched?.(r, c) ?? false;
                return (
                  <td
                    key={c}
                    title={cellTitle(r, c, value)}
                    data-off={off || undefined}
                    className={cx(
                      "rounded-[3px] p-0 text-center align-middle",
                      compact ? "h-5" : "h-7",
                      step === 0 ? "bg-surface-2 text-fg-faint" : STEPS[step - 1],
                      off && OFF_HOURS,
                    )}
                  >
                    {value === 0 ? (
                      <span className="sr-only">0</span>
                    ) : compact ? (
                      <span className="sr-only @lg:not-sr-only">{value}</span>
                    ) : (
                      value
                    )}
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
              {sums.map((sum, c) => (
                <td key={c} className="h-10 p-0 pt-2 align-bottom" title={footer.title(c, sum)}>
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
 * Rows of 24 hours, a `HeatTable` whose hours outside class are hatched.
 * `compact` labels every third hour only.
 */
export function HourHeatmap({
  caption,
  rowHeader,
  rows,
  isClassHour,
  cellTitle,
  footer,
  compact = false,
}: {
  caption: string;
  /** The (screen-reader) header of the rows' column. */
  rowHeader: string;
  rows: readonly HeatRow[];
  isClassHour: (row: number, hour: number) => boolean;
  cellTitle: (row: HeatRow, hour: number, n: number, off: boolean) => string;
  footer?: { label: string; title: (hour: number, n: number) => string };
  compact?: boolean;
}) {
  return (
    <HeatTable
      caption={caption}
      rowHeader={rowHeader}
      columns={HOURS.map((h) => ({ key: String(h), label: compact && h % 3 !== 0 ? null : String(h), srLabel: `${padHour(h)}:00` }))}
      rows={rows.map((r) => ({ key: r.key, label: r.label, strong: r.strong, values: r.hours }))}
      cellTitle={(r, h, n) => cellTitle(rows[r]!, h, n, !isClassHour(r, h))}
      hatched={(r, h) => !isClassHour(r, h)}
      footer={footer}
      compact={compact}
    />
  );
}

/** The ramp, from fewer to more, and — unless `offHours` is false — what the hatch means. */
export function HeatLegend({ offHours = true }: { offHours?: boolean }) {
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
      {offHours ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cx(swatch, "border border-line bg-surface-2", OFF_HOURS)} />
          {t("heatmap.legend.off", { window })}
        </span>
      ) : null}
    </div>
  );
}
