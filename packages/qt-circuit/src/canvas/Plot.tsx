/**
 * The waveform plot: an inline SVG line chart, drawn by hand.
 *
 * No chart library — the package's dependencies are `@quiz/core`,
 * `@quiz/domain`, `react` and `zod`, and a student waiting on a simulation
 * should not be waiting on 300 kB of plotting engine as well. Three or four
 * polylines on two axes is a hundred lines of geometry.
 *
 * It is drawn at REAL pixels, not scaled through a `viewBox`: a chart squeezed
 * into a phone column by `preserveAspectRatio` takes its tick labels down with
 * it, and a 6 px number is not a number. The width comes from a
 * `ResizeObserver`, with a sane default so the server and jsdom still render.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import type { SeriesSet } from "../schema.js";

import { CANVAS_STRINGS, withStrings, type CanvasStrings } from "./canvasStrings.js";
import {
  cx,
  plotAxis,
  plotAxisTitle,
  plotEmpty,
  plotFrame,
  plotLegend,
  plotLegendItem,
  plotTick,
  plotTitle,
  plotToggle,
} from "./canvasStyles.js";

export interface PlotProps {
  /** The student's waveforms; `t` in seconds. `null` is the empty state. */
  series: SeriesSet | null;
  /** The reference's output, drawn dashed over the student's. */
  expected?: SeriesSet | null | undefined;
  strings?: Partial<CanvasStrings> | undefined;
  height?: number | undefined;
  className?: string | undefined;
  title?: string | undefined;
}

const MARGIN = { top: 14, right: 14, bottom: 32, left: 46 };
/** Room for the second axis, only when the current is on show. */
const RIGHT_AXIS = 40;
const DEFAULT_WIDTH = 640;

/**
 * Ticks at 1, 2 or 5 × a power of ten — the steps a reader adds up in their
 * head. Exported because it is the one piece of this file worth a unit test.
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const raw = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out.length > 0 ? out : [min, max];
}

/**
 * As many decimals as the step needs, and not one more: a 0.25 V step wants
 * two, a 1 ms step wants none, and `log10` alone gets the first one wrong.
 */
export function formatTick(v: number, step: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e5 || abs < 1e-4) return v.toExponential(1);
  const size = Math.abs(step);
  let decimals = 0;
  while (decimals < 6 && Math.abs(Number(size.toFixed(decimals)) - size) > size * 1e-6) {
    decimals += 1;
  }
  const text = v.toFixed(decimals);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

interface Domain {
  readonly min: number;
  readonly max: number;
}

function domainOf(values: ReadonlyArray<readonly number[]>): Domain {
  let min = Infinity;
  let max = -Infinity;
  for (const list of values) {
    for (const v of list) {
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

const polyline = (
  xs: readonly number[],
  ys: readonly number[],
  px: (v: number) => number,
  py: (v: number) => number,
): string => {
  const n = Math.min(xs.length, ys.length);
  let d = "";
  for (let i = 0; i < n; i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    d += `${d === "" ? "M" : "L"}${px(x).toFixed(1)} ${py(y).toFixed(1)}`;
  }
  return d;
};

/**
 * A short line in the series' own ink AND its own dash, so the legend reads
 * without a colour name — and so the reference and the current stay apart for
 * a reader who cannot tell the red from the amber.
 */
function Swatch({ className, dash }: { className: string; dash?: string | undefined }): JSX.Element {
  return (
    <svg width={16} height={8} aria-hidden="true" focusable="false" className="shrink-0">
      <path
        d="M0 4H16"
        className={className}
        strokeWidth={2}
        fill="none"
        {...(dash === undefined ? {} : { strokeDasharray: dash })}
      />
    </svg>
  );
}

/** The one place the four series' dash patterns are decided. */
const DASH_EXPECTED = "5 4";
const DASH_CURRENT = "2 3";

export function Plot({ series, expected, strings, height = 240, className, title }: PlotProps): JSX.Element {
  const s = withStrings(CANVAS_STRINGS, strings);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [showCurrent, setShowCurrent] = useState(false);

  useEffect(() => {
    const el = wrapper.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.max(240, Math.round(w)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const chart = useMemo(() => {
    if (series === null) return null;
    const ms = series.t.map((v) => v * 1000);
    const first = ms[0] ?? 0;
    const last = ms[ms.length - 1] ?? first + 1;
    const x: Domain = last > first ? { min: first, max: last } : { min: first, max: first + 1 };
    const volts = domainOf([series.vin, series.vout, ...(expected ? [expected.vout] : [])]);
    const amps = domainOf([series.iout.map((v) => v * 1000)]);
    return { ms, x, volts, amps, expectedMs: expected ? expected.t.map((v) => v * 1000) : null };
  }, [expected, series]);

  if (series === null || chart === null) {
    return (
      <div ref={wrapper} className={cx(plotFrame, className)}>
        {title === undefined ? null : <span className={plotTitle}>{title}</span>}
        <div className={cx(plotEmpty, title === undefined ? "" : "mt-2")} style={{ height }}>
          {s.plotEmpty}
        </div>
      </div>
    );
  }

  const right = MARGIN.right + (showCurrent ? RIGHT_AXIS : 0);
  const innerW = Math.max(40, width - MARGIN.left - right);
  const innerH = Math.max(40, height - MARGIN.top - MARGIN.bottom);
  const px = (v: number): number => MARGIN.left + ((v - chart.x.min) / (chart.x.max - chart.x.min)) * innerW;
  const py = (v: number): number =>
    MARGIN.top + innerH - ((v - chart.volts.min) / (chart.volts.max - chart.volts.min)) * innerH;
  const pi = (v: number): number =>
    MARGIN.top + innerH - ((v - chart.amps.min) / (chart.amps.max - chart.amps.min)) * innerH;

  const xTicks = niceTicks(chart.x.min, chart.x.max, 6);
  const yTicks = niceTicks(chart.volts.min, chart.volts.max, 5);
  const iTicks = niceTicks(chart.amps.min, chart.amps.max, 5);
  const xStep = (xTicks[1] ?? chart.x.max) - (xTicks[0] ?? chart.x.min);
  const yStep = (yTicks[1] ?? chart.volts.max) - (yTicks[0] ?? chart.volts.min);
  const iStep = (iTicks[1] ?? chart.amps.max) - (iTicks[0] ?? chart.amps.min);

  return (
    <div ref={wrapper} className={cx(plotFrame, className)}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        {title === undefined ? <span /> : <span className={plotTitle}>{title}</span>}
        <button
          type="button"
          className={plotToggle(showCurrent)}
          aria-pressed={showCurrent}
          onClick={() => setShowCurrent((v) => !v)}
        >
          {s.showCurrent}
        </button>
      </div>

      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title ?? s.seriesVout}
        className="block max-w-full"
      >
        {/* Horizontal rules first: everything else is drawn over them. */}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              className="stroke-line"
              x1={MARGIN.left}
              x2={MARGIN.left + innerW}
              y1={py(v)}
              y2={py(v)}
            />
            <text className={plotTick} x={MARGIN.left - 6} y={py(v)} dy="0.32em" textAnchor="end">
              {formatTick(v, yStep)}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <g key={`x${v}`}>
            <line
              className="stroke-line"
              x1={px(v)}
              x2={px(v)}
              y1={MARGIN.top}
              y2={MARGIN.top + innerH}
            />
            <text className={plotTick} x={px(v)} y={MARGIN.top + innerH + 14} textAnchor="middle">
              {formatTick(v, xStep)}
            </text>
          </g>
        ))}
        {/* The current has its own scale, so it gets its own axis line and its
            own tick marks: a label floating beside somebody else's grid line
            is a number the reader has to guess the height of. */}
        {showCurrent
          ? iTicks.map((v) => (
              <g key={`i${v}`}>
                <line
                  className={plotAxis}
                  x1={MARGIN.left + innerW}
                  x2={MARGIN.left + innerW + 4}
                  y1={pi(v)}
                  y2={pi(v)}
                />
                <text
                  className={plotTick}
                  x={MARGIN.left + innerW + 8}
                  y={pi(v)}
                  dy="0.32em"
                  textAnchor="start"
                >
                  {formatTick(v, iStep)}
                </text>
              </g>
            ))
          : null}

        <line
          className={plotAxis}
          x1={MARGIN.left}
          x2={MARGIN.left + innerW}
          y1={MARGIN.top + innerH}
          y2={MARGIN.top + innerH}
        />
        <line
          className={plotAxis}
          x1={MARGIN.left}
          x2={MARGIN.left}
          y1={MARGIN.top}
          y2={MARGIN.top + innerH}
        />
        {showCurrent ? (
          <line
            className={plotAxis}
            x1={MARGIN.left + innerW}
            x2={MARGIN.left + innerW}
            y1={MARGIN.top}
            y2={MARGIN.top + innerH}
          />
        ) : null}

        <text className={plotAxisTitle} x={MARGIN.left + innerW} y={height - 4} textAnchor="end">
          {s.plotTime}
        </text>
        <text className={plotAxisTitle} x={MARGIN.left - 6} y={MARGIN.top - 3} textAnchor="end">
          {s.plotVoltage}
        </text>
        {showCurrent ? (
          <text
            className={plotAxisTitle}
            x={MARGIN.left + innerW + 8}
            y={MARGIN.top - 3}
            textAnchor="start"
          >
            {s.plotCurrent}
          </text>
        ) : null}

        {chart.expectedMs !== null && expected != null ? (
          <path
            data-series="expected"
            className="fill-none stroke-info stroke-[1.6]"
            strokeDasharray={DASH_EXPECTED}
            d={polyline(chart.expectedMs, expected.vout, px, py)}
          />
        ) : null}
        <path
          data-series="vin"
          className="fill-none stroke-fg-muted stroke-[1.4]"
          d={polyline(chart.ms, series.vin, px, py)}
        />
        <path
          data-series="vout"
          className="fill-none stroke-accent stroke-[1.8]"
          d={polyline(chart.ms, series.vout, px, py)}
        />
        {showCurrent ? (
          <path
            data-series="iout"
            className="fill-none stroke-warning stroke-[1.6]"
            strokeDasharray={DASH_CURRENT}
            d={polyline(
              chart.ms,
              series.iout.map((v) => v * 1000),
              px,
              pi,
            )}
          />
        ) : null}
      </svg>

      <div className={cx(plotLegend, "mt-1")}>
        <span className={plotLegendItem}>
          <Swatch className="stroke-fg-muted" />
          {s.seriesVin}
        </span>
        <span className={plotLegendItem}>
          <Swatch className="stroke-accent" />
          {s.seriesVout}
        </span>
        {expected != null ? (
          <span className={plotLegendItem}>
            <Swatch className="stroke-info" dash={DASH_EXPECTED} />
            {s.seriesExpected}
          </span>
        ) : null}
        {showCurrent ? (
          <span className={plotLegendItem}>
            <Swatch className="stroke-warning" dash={DASH_CURRENT} />
            {s.seriesIout}
          </span>
        ) : null}
      </div>
    </div>
  );
}
