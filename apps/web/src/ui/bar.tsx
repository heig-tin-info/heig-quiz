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
  const label = parts.every((p) => p.label)
    ? parts
        .filter((p) => p.value > 0)
        .map((p) => t("bar.part", { word: p.label!, n: p.value }))
        .join(" · ")
    : "";
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

export interface BarDatum {
  key: string;
  value: number;
  /** The row of the hidden table: what the bar stands for ("3.5–4.0", "Sep 21"). */
  label: string;
  /** Under the bar; empty for none, when the axis would not fit every label. */
  tick?: string;
  /** The bar's own tooltip, on hover. */
  title?: string;
}

/**
 * Vertical bars on one axis, one count each: plain `<div>`s on the tokens
 * rather than a chart library — a bar whose height is a percentage survives
 * every width the page has. Neutral ink, not the accent: a chart is a
 * reading, not the thing to press. An empty bar keeps a 2 px stub so the
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
              className={cx("w-full rounded-t-[4px]", b.value === 0 ? "bg-surface-3" : "bg-fg-muted")}
              style={{ height: `${Math.max(b.value === 0 ? 2 : 6, (b.value / top) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-0.5 border-t border-line pt-1.5 sm:gap-1" aria-hidden>
        {bars.map((b) => (
          <span
            key={b.key}
            className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[10px] tabular-nums text-fg-faint"
          >
            {b.tick ?? ""}
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
            <th scope="col">{labelHeader}</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.key}>
              <th scope="row">{b.label}</th>
              <td>{b.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
