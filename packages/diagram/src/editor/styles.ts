/**
 * The class lists of the diagram surfaces, in one place: semantic tokens only
 * (they swap under `html.dark` by themselves, DESIGN.md). The drawing is
 * monochrome ink on paper, hairlines, and ONE accent use: what is selected,
 * or the tool that is armed — the character of the circuit canvas.
 */
import { cx } from "@quiz/ui";

export { cx };

export const frame = "overflow-hidden rounded-card border border-line bg-surface";
export const toolbar = "flex flex-wrap items-center gap-1 border-b border-line bg-surface-2 px-2 py-1.5";
export const separator = "mx-1 h-5 w-px shrink-0 bg-line";

const ICON_BASE =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-field text-fg-muted transition-[background-color,color] duration-150 hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40";

/** A square tool or action button; the armed tool is the surface's accent. */
export const iconButton = (active = false): string =>
  cx(ICON_BASE, active && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent");

/** A wider tool button, for the link notations drawn as a line. */
export const lineButton = (active = false): string => cx(iconButton(active), "w-11");

export const drawingArea = "relative block w-full touch-none select-none bg-surface outline-none";

/* the grid */
export const gridMinor = "fill-none stroke-line";
export const gridMajor = "fill-none stroke-line-strong";

/* ink: a node or a line takes the current colour, selection turns it to the accent */
export const inkNormal = "text-fg";
export const inkSelected = "text-accent";
export const cardFill = "fill-surface";
export const headFill = "fill-surface-2";
export const outline = "fill-none stroke-current stroke-[1.5]";
export const thin = "fill-none stroke-current stroke-[1.1]";
export const shapeInk = "fill-surface stroke-current stroke-[1.5]";
export const strokeInk = "fill-none stroke-current stroke-[1.6] [stroke-linecap:round] [stroke-linejoin:round]";
export const dotInk = "fill-current";
export const line = "fill-none stroke-current stroke-[1.6] [stroke-linejoin:round]";
export const lineSelected = "stroke-[2.2]";
export const dashed = "[stroke-dasharray:7_5]";
export const lineHit = "fill-none stroke-transparent stroke-[12] cursor-pointer";
export const headInk = "stroke-current stroke-[1.6] [stroke-linejoin:round] [stroke-linecap:round]";

export const nameText = "fill-current text-[13.5px] font-semibold select-none";
export const stereoText = "fill-fg-muted text-[12px] select-none";
export const memberText = "fill-current font-mono text-[12px] select-none";
export const labelText = "fill-current text-[13px] font-medium select-none";
export const lineLabel = "fill-current text-[12px] italic font-medium select-none [paint-order:stroke] stroke-surface stroke-[4] [stroke-linejoin:round]";
export const lineLabelMono = "fill-current font-mono text-[11.5px] select-none [paint-order:stroke] stroke-surface stroke-[4] [stroke-linejoin:round]";

/* what the pointer is doing */
export const selectedHalo = "fill-accent-soft stroke-accent stroke-[1] [stroke-dasharray:3_3]";
export const hoverFrame = "fill-none stroke-accent stroke-[2]";
export const draftLine = "fill-none stroke-accent stroke-[1.6] [stroke-linecap:round] [stroke-linejoin:round]";
export const handle = "fill-surface stroke-accent stroke-[1.6] cursor-move";
export const marquee = "fill-accent-soft stroke-accent stroke-[1] [stroke-dasharray:4_3]";

/* the inspector and the text pane */
export const inspector =
  "absolute top-3 right-3 z-10 flex max-h-[calc(100%-1.5rem)] w-72 flex-col gap-2 overflow-y-auto rounded-card border border-line bg-surface-2 p-3 text-[12.5px]";
export const field = "grid grid-cols-[84px_1fr] items-center gap-2 text-fg-muted";
export const input =
  "w-full rounded-field border border-line bg-surface px-2 py-1 font-mono text-[12.5px] text-fg focus-visible:outline-2 focus-visible:outline-accent";
export const textarea = cx(input, "resize-y leading-relaxed [white-space:pre] overflow-x-auto");
export const checkRow = "flex items-center gap-2 text-fg";
export const tip = "text-[11.5px] text-fg-muted";
export const codeArea =
  "block h-full min-h-60 w-full resize-none bg-surface p-4 font-mono text-[13px] leading-relaxed text-fg outline-none [tab-size:2] [font-variant-ligatures:none]";
export const statusLine = "flex items-center gap-3 border-t border-line bg-surface-2 px-3 py-1 text-[12px] text-fg-muted";
export const statusBad = "text-danger";
