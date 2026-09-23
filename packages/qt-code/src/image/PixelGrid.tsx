/**
 * One image of a `codeimage` question, drawn on a `<canvas>`: a grid of
 * SQUARE cells, `width × height`, up to 128 × 128 — sixteen thousand cells,
 * which is why there is no DOM element per cell.
 *
 * A hairline in the app's `line` colour separates the cells while they are
 * large enough to carry one; below {@link MIN_CELL_FOR_LINES} CSS pixels the
 * lines would eat the picture, so they go. An invalid or missing pixel is
 * hatched on a neutral ground: it is not a colour the program chose.
 *
 * In `diff` mode each cell is the app's success colour where the computed
 * pixel equals the target and its danger colour otherwise — the two
 * semantic tokens, read from the page at draw time, so the grid follows the
 * light and dark themes like the rest of the screen.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { INVALID, pixelColor } from "./pixels.js";
import type { Palette } from "./schema.js";

/** Below this cell size (CSS px) the separating lines are dropped. */
export const MIN_CELL_FOR_LINES = 6;

/** The tallest a grid is drawn, in CSS px: a 3 × 128 strip must not take a whole screen. */
const MAX_HEIGHT_PX = 420;

/** The design tokens the canvas paints with, and their light-theme values as a fallback. */
const TOKENS = {
  line: ["--line", "#e7e4de"],
  lineStrong: ["--line-strong", "#d3cfc7"],
  surface2: ["--surface-2", "#f3f1ed"],
  faint: ["--fg-faint", "#726d64"],
  success: ["--success", "#1f7a4d"],
  danger: ["--danger", "#c2242a"],
} as const;

type Colors = Record<keyof typeof TOKENS, string>;

function readColors(): Colors {
  const style =
    typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const out = {} as Colors;
  for (const [key, [name, fallback]] of Object.entries(TOKENS) as [
    keyof typeof TOKENS,
    readonly [string, string],
  ][]) {
    const value = style?.getPropertyValue(name).trim();
    out[key] = value !== undefined && value !== "" ? value : fallback;
  }
  return out;
}

/** jsdom has no canvas: the grid then renders its frame and its label only. */
function canvasAvailable(): boolean {
  return typeof navigator !== "undefined" && !navigator.userAgent.includes("jsdom");
}

/**
 * A counter bumped whenever the theme class of `<html>` changes, so a grid
 * repaints with the other theme's tokens without a reload.
 */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return version;
}

export interface PixelGridProps {
  width: number;
  height: number;
  palette: Palette;
  /** The image; `null` draws the neutral placeholder with {@link emptyLabel}. */
  pixels: Int16Array | null;
  /** Given, the grid is a DIFF against this target instead of the image itself. */
  diffAgainst?: Int16Array | null | undefined;
  /** The accessible name of the image. */
  label: string;
  /** What the placeholder says. */
  emptyLabel?: string | undefined;
}

export function PixelGrid({
  width,
  height,
  palette,
  pixels,
  diffAgainst,
  label,
  emptyLabel,
}: PixelGridProps): ReactNode {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cssWidth, setCssWidth] = useState(0);
  const theme = useThemeVersion();

  useLayoutEffect(() => {
    const el = frame.current;
    if (el === null) return;
    setCssWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setCssWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = canvas.current;
    if (el === null || cssWidth <= 0 || !canvasAvailable()) return;
    const ctx = el.getContext("2d");
    if (ctx === null) return;
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const cellCss = cssWidth / width;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cellCss * height * dpr));
    el.width = w;
    el.height = h;
    const colors = readColors();
    const gap = cellCss >= MIN_CELL_FOR_LINES ? Math.max(1, Math.round(dpr)) : 0;

    ctx.fillStyle = colors.line;
    ctx.fillRect(0, 0, w, h);

    const hatch = hatchPattern(ctx, colors, dpr);
    const xs = edges(width, w);
    const ys = edges(height, h);
    for (let row = 0; row < height; row += 1) {
      const y0 = ys[row]!;
      const y1 = ys[row + 1]! - (row < height - 1 ? gap : 0);
      for (let col = 0; col < width; col += 1) {
        const x0 = xs[col]!;
        const x1 = xs[col + 1]! - (col < width - 1 ? gap : 0);
        const i = row * width + col;
        ctx.fillStyle = cellFill(i, pixels, diffAgainst, palette, colors, hatch);
        ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      }
    }
  }, [cssWidth, width, height, palette, pixels, diffAgainst, theme]);

  return (
    <div
      className="w-full"
      // Square cells: the frame keeps the image's own ratio, and a tall image
      // is narrowed so that its height stays within reach.
      style={{ maxWidth: `min(100%, ${Math.round((MAX_HEIGHT_PX * width) / height)}px)` }}
    >
      <div
        ref={frame}
        className="relative w-full overflow-hidden rounded-field border border-line-strong bg-surface-2"
        style={{ aspectRatio: `${width} / ${height}` }}
      >
        <canvas
          ref={canvas}
          role="img"
          aria-label={label}
          className="absolute inset-0 block h-full w-full"
          style={{ imageRendering: "pixelated" }}
        />
        {pixels === null ? (
          <p className="absolute inset-0 flex items-center justify-center bg-surface-2/85 p-4 text-center text-[13px] text-fg-muted">
            {emptyLabel}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The device-pixel boundaries of `n` equal cells across `size` pixels. */
function edges(n: number, size: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i += 1) out.push(Math.round((i * size) / n));
  return out;
}

type Fill = string | CanvasPattern;

function cellFill(
  i: number,
  pixels: Int16Array | null,
  diffAgainst: Int16Array | null | undefined,
  palette: Palette,
  colors: Colors,
  hatch: Fill,
): Fill {
  if (pixels === null) return colors.surface2;
  const value = pixels[i] ?? INVALID;
  if (diffAgainst !== undefined && diffAgainst !== null) {
    return value !== INVALID && value === diffAgainst[i] ? colors.success : colors.danger;
  }
  return pixelColor(value, palette) ?? hatch;
}

/** Diagonal stripes on the neutral ground: "no value here", in both themes. */
function hatchPattern(ctx: CanvasRenderingContext2D, colors: Colors, dpr: number): Fill {
  if (typeof document === "undefined") return colors.surface2;
  const size = Math.max(4, Math.round(6 * dpr));
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const t = tile.getContext("2d");
  if (t === null) return colors.surface2;
  t.fillStyle = colors.surface2;
  t.fillRect(0, 0, size, size);
  t.strokeStyle = colors.faint;
  t.lineWidth = Math.max(1, dpr);
  t.beginPath();
  t.moveTo(0, size);
  t.lineTo(size, 0);
  t.stroke();
  return ctx.createPattern(tile, "repeat") ?? colors.surface2;
}
