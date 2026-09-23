/**
 * The class lists of the canvas, in one place.
 *
 * A package cannot import `apps/web/src/ui.tsx`, so the primitives it would
 * have used are reduced to their class lists here, copied from that file (and
 * from the table of `@quiz/ui`, which did the same) so the two stay visually
 * identical. Semantic tokens only — they swap under `html.dark` by
 * themselves, so nothing below carries a `dark:` variant (DESIGN.md).
 *
 * The drawing surface has a character of its own: monochrome ink on paper,
 * hairlines, no shadow in the flow, and ONE accent use — what is selected or
 * the tool that is armed.
 */

import { cx } from "@quiz/ui";

export { cx };

export const frame = "overflow-hidden rounded-card border border-line bg-surface";

export const toolbar =
  "flex flex-wrap items-center gap-1 border-b border-line bg-surface-2 px-2 py-1.5";

export const toolbarGroup = "flex items-center gap-0.5";

export const separator = "mx-1 h-5 w-px shrink-0 bg-line";

/** A 28 px square icon button: the transforms and the history. */
const ICON_BASE =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted transition-[background-color,color] duration-150 hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40";

export const iconButton = (active = false): string =>
  cx(ICON_BASE, active && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent");

/** The two tools, as a pair of pills: the armed one is the surface's accent. */
const TOOL_BASE =
  "inline-flex h-7 shrink-0 select-none items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-[background-color,color] duration-150";

export const toolButton = (active: boolean): string =>
  cx(
    TOOL_BASE,
    active ? "bg-accent-soft text-accent" : "text-fg-muted hover:bg-surface-3 hover:text-fg",
  );

export const paletteColumn =
  "flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface-2 p-2 sm:w-[152px] sm:border-b-0 sm:border-r";

export const paletteHead = "flex items-baseline justify-between gap-2 px-0.5";

export const paletteTitle = "text-[11px] font-semibold tracking-wide text-fg-muted uppercase";

export const paletteCount = "font-mono text-[11px] tabular-nums text-fg-faint";

export const paletteGrid = "flex flex-wrap content-start gap-1 overflow-y-auto";

const TILE_BASE =
  "flex w-16 shrink-0 flex-col items-center gap-0.5 rounded-field border px-1 pt-1 pb-0.5 transition-[background-color,border-color,color] duration-150 disabled:pointer-events-none disabled:opacity-40";

export const paletteTile = (active: boolean): string =>
  cx(
    TILE_BASE,
    active
      ? "border-accent bg-accent-soft text-accent"
      : "border-line bg-surface text-fg hover:border-line-strong hover:bg-surface-2",
  );

export const paletteTileLabel = "font-mono text-[9px] leading-none text-fg-faint";

export const canvasArea = "relative min-w-0 flex-1 bg-canvas";

/* A strip UNDER the canvas, not an overlay on it: a hint printed over the box
   outline and a wire is a hint that reads as part of the drawing. */
export const statusBar =
  "flex items-center gap-2 border-t border-line bg-surface-2 px-2 py-1 text-[11px] text-fg-faint";

export const statusMode =
  "shrink-0 rounded-full bg-surface px-2 py-px text-[11px] font-semibold text-fg-muted ring-1 ring-line";

export const statusHint = "min-w-0 flex-1 truncate";

export const statusCursor = "shrink-0 font-mono tabular-nums";

export const inspector =
  "absolute top-2 right-2 flex w-[196px] flex-col gap-2 rounded-card border border-line bg-surface p-2.5";

export const inspectorTitle = "text-[13px] font-semibold text-fg";

export const fieldLabel = "text-[11px] font-medium text-fg-muted";

export const fieldInput =
  "h-7 w-full rounded-field border border-line-strong bg-surface px-2 font-mono text-[12px] text-fg transition-colors focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60";

export const fieldInputInvalid =
  "h-7 w-full rounded-field border border-danger bg-surface px-2 font-mono text-[12px] text-danger transition-colors focus:outline-none focus:ring-3 focus:ring-danger/20";

export const fieldError = "text-[11px] text-danger";

export const readOnlyValue = "font-mono text-[12px] text-fg-muted";

export const emptyNote = "text-[13px] text-fg-faint";

// --- the drawing itself ----------------------------------------------------

export const boxOutline = "fill-none stroke-line-strong";

export const gridMinor = "fill-none stroke-line";

export const gridMajor = "fill-none stroke-line-strong";

export const wireLine = "fill-none stroke-current stroke-[1.7] [stroke-linejoin:round] [stroke-linecap:round]";

export const wireHit = "fill-none stroke-transparent stroke-[12] cursor-pointer";

export const junctionDot = "fill-current";

export const pinDot = "fill-surface stroke-current stroke-[1.2]";

export const portGlyph = "fill-surface stroke-current stroke-[1.4]";

export const portLabel = "font-mono text-[11px] fill-current select-none";

export const componentLabel = "font-mono text-[11px] fill-current select-none";

export const componentValue = "fill-current opacity-70";

export const hitArea = "fill-transparent cursor-move";

export const selectedHalo = "fill-accent-soft stroke-accent stroke-[1] [stroke-dasharray:3_3]";

export const draftLine =
  "fill-none stroke-accent stroke-[1.7] [stroke-dasharray:6_4] [stroke-linejoin:round]";

export const marquee = "fill-accent-soft stroke-accent stroke-[1] [stroke-dasharray:4_3]";

export const crosshair = "stroke-accent stroke-[1.2]";

// --- the plot --------------------------------------------------------------

export const plotFrame = "rounded-card border border-line bg-surface p-3";

export const plotTitle = "text-[13px] font-semibold text-fg";

export const plotLegend = "flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-muted";

export const plotLegendItem = "inline-flex items-center gap-1.5";

export const plotAxis = "stroke-line-strong";

export const plotTick = "font-mono text-[10px] fill-fg-faint tabular-nums";

export const plotAxisTitle = "font-mono text-[10px] fill-fg-faint";

export const plotEmpty =
  "flex items-center justify-center rounded-field border border-dashed border-line-strong bg-surface-2 text-[13px] text-fg-faint";

const CHIP_BASE =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-[background-color,border-color,color] duration-150";

export const plotToggle = (active: boolean): string =>
  cx(
    CHIP_BASE,
    active
      ? "border-accent bg-accent-soft text-accent"
      : "border-line-strong bg-surface text-fg-muted hover:bg-surface-2",
  );

/** How each kind of symbol piece is painted; see `SymbolShape` in `symbols.ts`. */
export const shapeClass = (paint: "stroke" | "thick" | "hollow" | "solid"): string => {
  switch (paint) {
    case "thick":
      return "fill-none stroke-current stroke-[2.6] [stroke-linecap:butt]";
    case "hollow":
      return "fill-surface stroke-current stroke-[1.7] [stroke-linecap:round] [stroke-linejoin:round]";
    case "solid":
      return "fill-current stroke-current stroke-[1.2] [stroke-linejoin:round]";
    default:
      return "fill-none stroke-current stroke-[1.7] [stroke-linecap:round] [stroke-linejoin:round]";
  }
};

/** The ink a group of drawing is in: the surface is monochrome but for these three. */
export const inkSelected = "text-accent";
export const inkNormal = "text-fg";
export const inkFlagged = "text-danger";
