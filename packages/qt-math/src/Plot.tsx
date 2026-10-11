/**
 * The graph of the `math` player: the student's expression drawn over the
 * window of the one symbol, and, when the teacher asked for it, the target
 * curve behind it (docs/spec/04 §4.16). Display only: what is graded is the
 * expression, at random points that are never the ones drawn here.
 *
 * Plain SVG in semantic tokens (DESIGN.md): no charting library, since a
 * polyline and two axes are the whole need. Every series is sampled on the
 * same even grid over `axis` (`MATH_PLOT_POINTS`), so a series is its values
 * alone. A curve breaks where the expression has no value and where it
 * leaves the window.
 */
import { caption, cx } from "@quiz/ui";

export interface PlotSeries {
  /** `null` where the expression has no real value. */
  y: readonly (number | null)[];
  kind: "answer" | "target";
  label: string;
}

const W = 480;
const H = 240;
const M = { left: 60, right: 12, top: 12, bottom: 24 };

/** Two significant figures, an exponent for the very small and the very large: a tick, not a measurement. */
const tick = (value: number): string => {
  const magnitude = Math.abs(value);
  if (magnitude < 1e-12) return "0";
  if (magnitude < 1e-3 || magnitude >= 1e5) return value.toExponential(1);
  return String(Number(value.toPrecision(2)));
};

/**
 * The y window: the finite values, with a 5 % margin. A pole sends a few
 * samples to the moon; when the full span dwarfs the middle 90 % of the
 * values twentyfold, the middle 90 % wins and the spikes leave the window.
 * A window that never crosses zero keeps its zero edge.
 */
function yWindow(series: readonly PlotSeries[]): [number, number] {
  const values = series.flatMap((s) => s.y.filter((y): y is number => y !== null)).sort((a, b) => a - b);
  if (values.length === 0) return [-1, 1];
  let lo = values[0]!;
  let hi = values[values.length - 1]!;
  const p5 = values[Math.floor(values.length * 0.05)]!;
  const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]!;
  if (hi - lo > 20 * (p95 - p5) && p95 > p5) [lo, hi] = [p5, p95];
  if (hi - lo < 1e-9) [lo, hi] = [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.05;
  return [lo >= 0 && lo - pad < 0 ? 0 : lo - pad, hi <= 0 && hi + pad > 0 ? 0 : hi + pad];
}

export function Plot({
  axis,
  series,
  title,
  className,
}: {
  axis: { from: number; to: number };
  series: readonly PlotSeries[];
  title: string;
  className?: string | undefined;
}) {
  const [yLo, yHi] = yWindow(series);
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const py = (y: number) => M.top + ((yHi - y) / (yHi - yLo)) * innerH;

  const path = (y: readonly (number | null)[]): string => {
    const steps = Math.max(1, y.length - 1);
    let d = "";
    let pen = false;
    y.forEach((value, i) => {
      if (value === null || value < yLo || value > yHi) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${(M.left + (innerW * i) / steps).toFixed(1)} ${py(value).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const x0 = axis.from <= 0 && 0 <= axis.to ? M.left + ((0 - axis.from) / (axis.to - axis.from || 1)) * innerW : M.left;
  const y0 = yLo <= 0 && 0 <= yHi ? py(0) : M.top + innerH;
  // The target last, so a right answer shows as the dashed target over its own solid line.
  const ordered = [...series.filter((s) => s.kind === "answer"), ...series.filter((s) => s.kind === "target")];

  return (
    <figure className={cx("flex flex-col gap-1", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="h-auto w-full max-w-lg rounded-field border border-line bg-surface">
        <line x1={M.left} x2={M.left + innerW} y1={y0} y2={y0} className="stroke-line-strong" strokeWidth={1} />
        <line x1={x0} x2={x0} y1={M.top} y2={M.top + innerH} className="stroke-line-strong" strokeWidth={1} />
        <text x={M.left} y={H - 6} className="fill-fg-faint text-[11px]">
          {tick(axis.from)}
        </text>
        <text x={M.left + innerW} y={H - 6} textAnchor="end" className="fill-fg-faint text-[11px]">
          {tick(axis.to)}
        </text>
        <text x={M.left - 4} y={M.top + 10} textAnchor="end" className="fill-fg-faint text-[11px]">
          {tick(yHi)}
        </text>
        <text x={M.left - 4} y={M.top + innerH} textAnchor="end" className="fill-fg-faint text-[11px]">
          {tick(yLo)}
        </text>
        {ordered.map((s) => (
          <path
            key={s.kind}
            d={path(s.y)}
            fill="none"
            strokeWidth={s.kind === "answer" ? 2 : 2.5}
            strokeDasharray={s.kind === "target" ? "6 4" : undefined}
            className={s.kind === "answer" ? "stroke-accent" : "stroke-fg-muted"}
            data-curve={s.kind}
          />
        ))}
      </svg>
      <figcaption className={cx(caption, "flex flex-wrap gap-3")}>
        {ordered.map((s) => (
          <span key={s.kind} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cx("inline-block h-0.5 w-4", s.kind === "answer" ? "bg-accent" : "border-t-2 border-dashed border-fg-muted")} />
            {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
