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
 *
 * Two charts share the geometry below: a transient's waveforms against time,
 * and an AC sweep's Bode plot — magnitude on top, phase underneath, on one
 * logarithmic frequency axis (ADR-040). `Plot` picks by the series' kind.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";

import { formatValue } from "../library.js";
import type { AcSeries, SeriesSet, TranSeries } from "../schema.js";

import { resolveStrings } from "@quiz/core/client";
import { CANVAS_STRINGS, type CanvasStrings } from "./canvasStrings.js";
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
  /** The student's series: waveforms (`t` in seconds) or a Bode plot. `null` is the empty state. */
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
 * The deepest a Bode magnitude axis goes under its own top. An output wired
 * to nothing reads −300 dB, and an axis stretched down to it would flatten
 * the curve that matters into one line.
 */
const MAG_SPAN_DB = 120;
/** The phase panel's height, as a share of the magnitude panel's. */
const PHASE_SHARE = 0.8;

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
 * Frequency ticks: every decade, and 2 and 5 × each decade when the sweep
 * spans two decades or fewer — a one-decade axis with two ticks is no axis.
 */
export function logTicks(min: number, max: number): number[] {
  if (!(min > 0) || !(max > min)) return [min];
  const lo = Math.floor(Math.log10(min) + 1e-9);
  const hi = Math.ceil(Math.log10(max) - 1e-9);
  const mantissas = hi - lo <= 2 ? [1, 2, 5] : [1];
  const out: number[] = [];
  for (let k = lo; k <= hi; k += 1) {
    for (const m of mantissas) {
      const v = Number((m * 10 ** k).toPrecision(12));
      if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) out.push(v);
    }
  }
  return out.length > 0 ? out : [min, max];
}

/** Phase ticks at a multiple of 15° a reader knows by heart: 45°, 90°, 180°. */
export function phaseTicks(min: number, max: number): number[] {
  const span = max - min;
  const step = [15, 30, 45, 90, 180, 360].find((s) => span / s <= 6) ?? 720;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
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

/** The container's width, followed as it changes. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const wrapper = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
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
  return [wrapper, width];
}

/** One axis: where its ticks are, where a value lands, and how a tick reads. */
interface AxisSpec {
  ticks: readonly number[];
  at: (v: number) => number;
  label: (v: number) => string;
}

/** The inner rectangle of one chart panel, in pixels of its SVG. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The grid, the tick labels, the two axis lines and the two axis titles of
 * one panel. The x labels and title are optional: the magnitude panel of a
 * Bode plot shares the phase panel's frequency axis and does not repeat it.
 */
function Axes({
  box,
  x,
  y,
  yTitle,
  xTitle,
}: {
  box: Box;
  x: AxisSpec;
  y: AxisSpec;
  yTitle: string;
  /** The x title and the baseline it sits on; absent, the x ticks are unlabelled. */
  xTitle?: { text: string; baseline: number } | undefined;
}): JSX.Element {
  const bottom = box.top + box.height;
  return (
    <>
      {/* Horizontal rules first: everything else is drawn over them. */}
      {y.ticks.map((v) => (
        <g key={`y${v}`}>
          <line className="stroke-line" x1={box.left} x2={box.left + box.width} y1={y.at(v)} y2={y.at(v)} />
          <text className={plotTick} x={box.left - 6} y={y.at(v)} dy="0.32em" textAnchor="end">
            {y.label(v)}
          </text>
        </g>
      ))}
      {x.ticks.map((v) => (
        <g key={`x${v}`}>
          <line className="stroke-line" x1={x.at(v)} x2={x.at(v)} y1={box.top} y2={bottom} />
          {xTitle === undefined ? null : (
            <text className={plotTick} x={x.at(v)} y={bottom + 14} textAnchor="middle">
              {x.label(v)}
            </text>
          )}
        </g>
      ))}
      <line className={plotAxis} x1={box.left} x2={box.left + box.width} y1={bottom} y2={bottom} />
      <line className={plotAxis} x1={box.left} x2={box.left} y1={box.top} y2={bottom} />
      {xTitle === undefined ? null : (
        <text className={plotAxisTitle} x={box.left + box.width} y={xTitle.baseline} textAnchor="end">
          {xTitle.text}
        </text>
      )}
      <text className={plotAxisTitle} x={box.left - 6} y={box.top - 3} textAnchor="end">
        {yTitle}
      </text>
    </>
  );
}

/** The frame, its title and the "nothing yet" line, before any simulation. */
function EmptyPlot({
  wrapper,
  title,
  height,
  className,
  text,
}: {
  wrapper: RefObject<HTMLDivElement | null>;
  title: string | undefined;
  height: number;
  className: string | undefined;
  text: string;
}): JSX.Element {
  return (
    <div ref={wrapper} className={cx(plotFrame, className)}>
      {title === undefined ? null : <span className={plotTitle}>{title}</span>}
      <div className={cx(plotEmpty, title === undefined ? "" : "mt-2")} style={{ height }}>
        {text}
      </div>
    </div>
  );
}

/**
 * The shell every chart shares: the frame the width is measured on, a header
 * line, the SVG at real pixels with its accessible name, and the legend.
 */
function PlotFrame({
  wrapper,
  className,
  header,
  width,
  height,
  label,
  legend,
  children,
}: {
  wrapper: RefObject<HTMLDivElement | null>;
  className: string | undefined;
  header: ReactNode;
  width: number;
  height: number;
  label: string;
  legend: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div ref={wrapper} className={cx(plotFrame, className)}>
      {header}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        className="block max-w-full"
      >
        {children}
      </svg>
      {legend}
    </div>
  );
}

/** The legend entries every chart has: the student's output, and the reference's when overlaid. */
function OutputLegend({
  s,
  expected,
  lead,
  trail,
}: {
  s: CanvasStrings;
  expected: boolean;
  /** Entries before the output's and after the reference's: the transient's input and current. */
  lead?: ReactNode;
  trail?: ReactNode;
}): JSX.Element {
  return (
    <div className={cx(plotLegend, "mt-1")}>
      {lead}
      <span className={plotLegendItem}>
        <Swatch className="stroke-accent" />
        {s.seriesVout}
      </span>
      {expected ? (
        <span className={plotLegendItem}>
          <Swatch className="stroke-info" dash={DASH_EXPECTED} />
          {s.seriesExpected}
        </span>
      ) : null}
      {trail}
    </div>
  );
}

export function Plot(props: PlotProps): JSX.Element {
  const { series, expected } = props;
  if (series !== null && series.kind === "ac") {
    return <BodePlot {...props} series={series} expected={expected?.kind === "ac" ? expected : null} />;
  }
  return (
    <TransientPlot
      {...props}
      series={series}
      expected={expected != null && expected.kind !== "ac" ? expected : null}
    />
  );
}

function TransientPlot({
  series,
  expected,
  strings,
  height = 240,
  className,
  title,
}: PlotProps & { series: TranSeries | null; expected: TranSeries | null }): JSX.Element {
  const s = resolveStrings(CANVAS_STRINGS, strings);
  const [wrapper, width] = useWidth();
  const [showCurrent, setShowCurrent] = useState(false);

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
    return <EmptyPlot wrapper={wrapper} title={title} height={height} className={className} text={s.plotEmpty} />;
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
    <PlotFrame
      wrapper={wrapper}
      className={className}
      width={width}
      height={height}
      label={title ?? s.seriesVout}
      header={
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
      }
      legend={
        <OutputLegend
          s={s}
          expected={expected !== null}
          lead={
            <span className={plotLegendItem}>
              <Swatch className="stroke-fg-muted" />
              {s.seriesVin}
            </span>
          }
          trail={
            showCurrent ? (
              <span className={plotLegendItem}>
                <Swatch className="stroke-warning" dash={DASH_CURRENT} />
                {s.seriesIout}
              </span>
            ) : null
          }
        />
      }
    >
      <Axes
        box={{ left: MARGIN.left, top: MARGIN.top, width: innerW, height: innerH }}
        x={{ ticks: xTicks, at: px, label: (v) => formatTick(v, xStep) }}
        y={{ ticks: yTicks, at: py, label: (v) => formatTick(v, yStep) }}
        yTitle={s.plotVoltage}
        xTitle={{ text: s.plotTime, baseline: height - 4 }}
      />
      {/* The current has its own scale, so it gets its own axis line and its
          own tick marks: a label floating beside somebody else's grid line
          is a number the reader has to guess the height of. */}
      {showCurrent ? (
        <>
          {iTicks.map((v) => (
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
          ))}
          <line
            className={plotAxis}
            x1={MARGIN.left + innerW}
            x2={MARGIN.left + innerW}
            y1={MARGIN.top}
            y2={MARGIN.top + innerH}
          />
          <text
            className={plotAxisTitle}
            x={MARGIN.left + innerW + 8}
            y={MARGIN.top - 3}
            textAnchor="start"
          >
            {s.plotCurrent}
          </text>
        </>
      ) : null}

      {chart.expectedMs !== null && expected !== null ? (
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
    </PlotFrame>
  );
}

/**
 * The Bode plot of an AC sweep: magnitude in dB on top, phase in degrees
 * underneath, one logarithmic frequency axis for both — labelled once, under
 * the phase, where a reader's eye ends up. Only `v(out)` is drawn: the input
 * is the unit source, flat at 0 dB and 0°, and a line that says nothing.
 */
function BodePlot({
  series,
  expected,
  strings,
  height = 240,
  className,
  title,
}: PlotProps & { series: AcSeries; expected: AcSeries | null }): JSX.Element {
  const s = resolveStrings(CANVAS_STRINGS, strings);
  const [wrapper, width] = useWidth();

  const chart = useMemo(() => {
    const fs = [...series.f, ...(expected ? expected.f : [])].filter((f) => f > 0);
    const fMin = fs.length > 0 ? Math.min(...fs) : 1;
    const fMax = fs.length > 0 ? Math.max(...fs) : 10;
    const top = domainOf([series.magDb, ...(expected ? [expected.magDb] : [])]);
    const magnitude: Domain = { min: Math.max(top.min, top.max - MAG_SPAN_DB), max: top.max };
    const phase = domainOf([series.phaseDeg, ...(expected ? [expected.phaseDeg] : [])]);
    return { fMin, fMax: fMax > fMin ? fMax : fMin * 10, magnitude, phase };
  }, [expected, series]);

  const innerW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const phaseHeight = Math.round(height * PHASE_SHARE);
  const total = height + phaseHeight;
  const magBox: Box = { left: MARGIN.left, top: MARGIN.top, width: innerW, height: Math.max(40, height - MARGIN.top - 8) };
  const phaseTop = height + MARGIN.top;
  const phaseBox: Box = {
    left: MARGIN.left,
    top: phaseTop,
    width: innerW,
    height: Math.max(30, total - phaseTop - MARGIN.bottom),
  };

  const lMin = Math.log10(chart.fMin);
  const lMax = Math.log10(chart.fMax);
  const px = (f: number): number => MARGIN.left + ((Math.log10(f) - lMin) / (lMax - lMin)) * innerW;
  const scale = (box: Box, d: Domain) => (v: number): number => {
    const clamped = Math.min(d.max, Math.max(d.min, v));
    return box.top + box.height - ((clamped - d.min) / (d.max - d.min)) * box.height;
  };
  const pm = scale(magBox, chart.magnitude);
  const pp = scale(phaseBox, chart.phase);

  const fTicks = logTicks(chart.fMin, chart.fMax);
  const mTicks = niceTicks(chart.magnitude.min, chart.magnitude.max, 5);
  const pTicks = phaseTicks(chart.phase.min, chart.phase.max);
  const mStep = (mTicks[1] ?? chart.magnitude.max) - (mTicks[0] ?? chart.magnitude.min);
  const x: AxisSpec = { ticks: fTicks, at: px, label: formatValue };

  // Two panels, each with the reference (dashed, under) and the student's output.
  const panels = [
    { key: "", y: (d: AcSeries) => d.magDb, at: pm },
    { key: "-phase", y: (d: AcSeries) => d.phaseDeg, at: pp },
  ];
  const curves: { name: string; data: AcSeries; ink: string; dash?: string }[] = [
    ...(expected === null
      ? []
      : [{ name: "expected", data: expected, ink: "stroke-info stroke-[1.6]", dash: DASH_EXPECTED }]),
    { name: "vout", data: series, ink: "stroke-accent stroke-[1.8]" },
  ];

  return (
    <PlotFrame
      wrapper={wrapper}
      className={className}
      width={width}
      height={total}
      label={title ?? s.bodeLabel}
      header={title === undefined ? null : <span className={cx(plotTitle, "mb-1 block")}>{title}</span>}
      legend={<OutputLegend s={s} expected={expected !== null} />}
    >
      <Axes
        box={magBox}
        x={x}
        y={{ ticks: mTicks, at: pm, label: (v) => formatTick(v, mStep) }}
        yTitle={s.plotMagnitude}
      />
      <Axes
        box={phaseBox}
        x={x}
        y={{ ticks: pTicks, at: pp, label: (v) => String(v) }}
        yTitle={s.plotPhase}
        xTitle={{ text: s.plotFrequency, baseline: total - 4 }}
      />
      {panels.flatMap((panel) =>
        curves.map((curve) => (
          <path
            key={`${curve.name}${panel.key}`}
            data-series={`${curve.name}${panel.key}`}
            className={cx("fill-none", curve.ink)}
            {...(curve.dash === undefined ? {} : { strokeDasharray: curve.dash })}
            d={polyline(curve.data.f, panel.y(curve.data), px, panel.at)}
          />
        )),
      )}
    </PlotFrame>
  );
}
