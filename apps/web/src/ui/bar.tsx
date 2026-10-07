import { useT } from "../i18n";
import { cx, Tip } from "./layers";

// Bar: one horizontal bar cut into parts, for counts that add up to a whole;
// Bars: a row of vertical bars, one count each (a distribution, a series).

/** The meaning of a part, never a raw colour (DESIGN.md, "Correction projection"). */
export type BarTone = "success" | "partial" | "danger" | "warning" | "muted" | "info";

export const BAR_TONES: Record<BarTone, string> = {
  success: "bg-success",
  // Partial credit is green HATCHED over the track: the same family as full
  // credit, told apart by texture as well as by tone.
  partial: "bg-[repeating-linear-gradient(135deg,var(--success)_0_5px,transparent_5px_9px)]",
  danger: "bg-danger",
  warning: "bg-warning",
  muted: "bg-fg-faint/50",
  // A share with no verdict: the choices picked on a question of the pool (ADR-043).
  info: "bg-info",
};

/** "wrong: 4 · no answer: 1": the non-empty labelled parts, spelled out. */
function partsLabel(t: ReturnType<typeof useT>, parts: readonly BarPart[]): string {
  return parts
    .filter((p) => p.value > 0 && p.label)
    .map((p) => t("bar.part", { word: p.label!, n: p.value }))
    .join(" · ");
}

export interface BarPart {
  tone: BarTone;
  value: number;
  /** What the part counts ("wrong"). A bar whose parts all say it speaks. */
  label?: string;
}

/**
 * A thin segmented bar: each part takes its share of `total` (the sum of the
 * parts by default; what is left of a larger total stays the empty track).
 * The parts are parted by 2 px gaps, so a colour is never the only thing that
 * tells two of them apart.
 *
 * The figures are never printed beside it — the bar is the one reading — but
 * they are one hover or one Tab away: when every part has a `label`, the bar
 * spells its non-empty parts out ("wrong: 4 · no answer: 1"), as the bubble
 * AND as its accessible name. Without labels it is decoration, hidden from
 * assistive technology, and says nothing more than the text next to it.
 *
 * The height is the caller's (`className`, e.g. `h-2`). An empty part draws
 * nothing, not even its gap.
 */
export function SegmentedBar({
  parts,
  total,
  className = "h-2",
}: {
  parts: readonly BarPart[];
  total?: number;
  className?: string;
}) {
  const t = useT();
  const label = parts.every((p) => p.label) ? partsLabel(t, parts) : "";
  const sum = parts.reduce((s, p) => s + p.value, 0);
  const rest = Math.max(0, (total ?? sum) - sum);
  const bar = (
    <span
      {...(label ? { role: "img", tabIndex: 0, "aria-label": label } : { "aria-hidden": true })}
      className={cx("flex w-full gap-0.5 overflow-hidden rounded-full bg-surface-3", className)}
    >
      {parts.map((part, index) =>
        part.value > 0 ? (
          <span
            key={index}
            className={cx("min-w-0 basis-0", BAR_TONES[part.tone])}
            style={{ flexGrow: part.value }}
          />
        ) : null,
      )}
      {rest > 0 ? <span className="min-w-0 basis-0" style={{ flexGrow: rest }} /> : null}
    </span>
  );
  return label ? (
    <Tip label={label} className="flex w-full">
      {bar}
    </Tip>
  ) : (
    bar
  );
}

const BAR_FILL = { danger: "bg-danger", warning: "bg-warning" } as const;

export interface BarDatum {
  key: string;
  value: number;
  /** The row of the hidden table: what the bar stands for ("3.5–4.0", "Sep 21"). */
  label: string;
  /** Under the bar; empty for none, when the axis would not fit every label. */
  tick?: string;
  /** The bar's own tooltip, on hover. */
  title?: string;
  /** A semantic fill instead of the neutral ink (a failing grade range). */
  tone?: "danger" | "warning" | undefined;
}

/**
 * Under a chart of `Bars` or `StackedBars`: the ticks of its axis, and the
 * same figures as a real table, visually hidden — a screen reader gets the
 * data, not a shape. A row is its key, its label and its figures.
 */
function ChartAxis({
  ticks,
  caption,
  headers,
  rows,
}: {
  ticks: readonly (readonly [key: string, tick: string])[];
  caption: string;
  headers: readonly string[];
  rows: readonly (readonly [key: string, label: string, values: readonly number[]])[];
}) {
  return (
    <>
      <div className="mt-1.5 flex gap-0.5 border-t border-line pt-1.5 sm:gap-1" aria-hidden>
        {ticks.map(([key, tick]) => (
          <span
            key={key}
            className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[10px] tabular-nums text-fg-faint"
          >
            {tick}
          </span>
        ))}
      </div>
      {/* `sr-only` and nothing else: a width utility beside it wins by
          stylesheet order and turns the hidden table into 1440 px of
          absolutely positioned overflow. */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, label, values]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              {values.map((v, i) => (
                <td key={i}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Vertical bars on one axis, one count each: plain `<div>`s on the tokens
 * rather than a chart library — a bar whose height is a percentage survives
 * every width the page has. Neutral ink, not the accent: a chart is a
 * reading, not the thing to press; a bar that is a verdict (a failing grade
 * range) may take a semantic `tone`. An empty bar keeps a 2 px stub so the
 * axis reads, a non-empty one at least 6 px so it is never mistaken for one.
 *
 * The bars are `aria-hidden`, and the same numbers are published as a real
 * table, visually hidden: a screen reader gets the data, not a shape.
 */
export function Bars({
  bars,
  caption,
  labelHeader,
  valueHeader,
  showValues = false,
  className = "h-32",
}: {
  bars: readonly BarDatum[];
  /** The hidden table's caption: what the chart is. */
  caption: string;
  labelHeader: string;
  valueHeader: string;
  /** The count above each bar: for a few bars, where every figure matters. */
  showValues?: boolean;
  /** The height of the plot. */
  className?: string;
}) {
  const top = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div>
      <div className={cx("flex items-end gap-0.5 sm:gap-1", className)} aria-hidden>
        {bars.map((b) => (
          <div key={b.key} title={b.title} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1">
            {showValues ? (
              <span className="text-center text-[11px] tabular-nums text-fg-faint">{b.value || ""}</span>
            ) : null}
            <span
              className={cx("w-full rounded-t-[4px]", b.value === 0 ? "bg-surface-3" : b.tone ? BAR_FILL[b.tone] : "bg-fg-muted")}
              style={{ height: `${Math.max(b.value === 0 ? 2 : 6, (b.value / top) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <ChartAxis
        ticks={bars.map((b) => [b.key, b.tick ?? ""])}
        caption={caption}
        headers={[labelHeader, valueHeader]}
        rows={bars.map((b) => [b.key, b.label, [b.value]])}
      />
    </div>
  );
}

export interface StackedBarDatum {
  key: string;
  /** The row of the hidden table, and the bar's accessible name ("Question 3"). */
  label: string;
  /** Under the bar. */
  tick: string;
  /** Bottom to top; each `label` is a column of the hidden table. */
  parts: readonly BarPart[];
}

/**
 * `Bars` whose every bar is cut into parts, each the share of its bar's own
 * total: a row of 100 % columns, for counts over the same papers (how the
 * class fared on each question). The tones are `SegmentedBar`'s, so a
 * question's column reads as its bar in the correction. A part spells its
 * count on hover, and `onSelect` turns each bar into a button.
 *
 * As `Bars`, the shape is decoration and the figures a hidden table.
 */
export function StackedBars({
  bars,
  caption,
  labelHeader,
  onSelect,
  className = "h-32",
}: {
  bars: readonly StackedBarDatum[];
  caption: string;
  labelHeader: string;
  onSelect?: (key: string) => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div>
      <div className={cx("flex items-stretch gap-0.5 sm:gap-1", className)}>
        {bars.map((b) => {
          const sum = b.parts.reduce((s, p) => s + p.value, 0);
          const tip = partsLabel(t, b.parts);
          const stack = (
            <span className="flex h-full w-full flex-col-reverse gap-0.5 overflow-hidden rounded-t-[4px] bg-surface-3">
              {b.parts.map((part, index) =>
                part.value > 0 ? (
                  <span
                    key={index}
                    className={cx("min-h-0 basis-0", BAR_TONES[part.tone])}
                    style={{ flexGrow: part.value }}
                  />
                ) : null,
              )}
              {sum === 0 ? <span className="flex-1" /> : null}
            </span>
          );
          return (
            <Tip key={b.key} label={tip ? `${b.label} — ${tip}` : b.label} className="flex min-w-0 flex-1">
              {onSelect ? (
                <button
                  type="button"
                  aria-label={b.label}
                  onClick={() => onSelect(b.key)}
                  className="flex w-full rounded-t-[4px] transition-opacity duration-150 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {stack}
                </button>
              ) : (
                <span aria-hidden className="flex w-full">
                  {stack}
                </span>
              )}
            </Tip>
          );
        })}
      </div>
      <ChartAxis
        ticks={bars.map((b) => [b.key, b.tick])}
        caption={caption}
        headers={[labelHeader, ...(bars[0]?.parts.map((p) => p.label ?? "") ?? [])]}
        rows={bars.map((b) => [b.key, b.label, b.parts.map((p) => p.value)])}
      />
    </div>
  );
}

/** What each tone of a chart stands for, under it: a swatch and a word. */
export function BarLegend({ parts }: { parts: readonly { tone: BarTone; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted" aria-hidden>
      {parts.map((p) => (
        <li key={p.label} className="inline-flex items-center gap-1.5">
          <span className={cx("size-2.5 rounded-[3px]", BAR_TONES[p.tone])} />
          {p.label}
        </li>
      ))}
    </ul>
  );
}
