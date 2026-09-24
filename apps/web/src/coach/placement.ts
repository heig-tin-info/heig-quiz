import type { Placement } from "./catalog";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placed {
  x: number;
  y: number;
  side: Placement;
  /** Where the tail sits along the bubble's edge facing the target, in px. */
  tail: number;
}

/** Between the target's edge and the bubble's: room for the tail and the ring. */
export const GAP = 16;
/** Kept clear at the viewport's edges. */
export const MARGIN = 12;
/** The tail never runs into the rounded corners. */
const TAIL_INSET = 26;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

const ORDER: Record<Placement, Placement[]> = {
  bottom: ["bottom", "top", "right", "left"],
  top: ["top", "bottom", "right", "left"],
  right: ["right", "left", "bottom", "top"],
  left: ["left", "right", "bottom", "top"],
};

/**
 * Where a bubble of `size` goes beside `target`: the preferred side if it
 * fits in the viewport, else the next one that does, else the preferred side
 * anyway (clamped — a bubble half off-screen is worse than one that covers a
 * little of its target). The tail points at the target's centre, whatever
 * clamping moved the bubble.
 */
export function place(
  target: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: Placement = "bottom",
): Placed {
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const fits = (side: Placement) => {
    switch (side) {
      case "bottom":
        return target.top + target.height + GAP + size.height <= viewport.height - MARGIN;
      case "top":
        return target.top - GAP - size.height >= MARGIN;
      case "right":
        return target.left + target.width + GAP + size.width <= viewport.width - MARGIN;
      case "left":
        return target.left - GAP - size.width >= MARGIN;
    }
  };
  const side = ORDER[preferred].find(fits) ?? preferred;

  if (side === "bottom" || side === "top") {
    const x = clamp(cx - size.width / 2, MARGIN, viewport.width - MARGIN - size.width);
    const y =
      side === "bottom" ? target.top + target.height + GAP : target.top - GAP - size.height;
    return { x, y, side, tail: clamp(cx - x, TAIL_INSET, size.width - TAIL_INSET) };
  }
  const y = clamp(cy - size.height / 2, MARGIN, viewport.height - MARGIN - size.height);
  const x = side === "right" ? target.left + target.width + GAP : target.left - GAP - size.width;
  return { x, y, side, tail: clamp(cy - y, TAIL_INSET, size.height - TAIL_INSET) };
}
