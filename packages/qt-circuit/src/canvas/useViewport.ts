/**
 * The editor's view: the visible part of the world, the height of the drawing
 * area, and the one mapping from a client point to a world point.
 *
 * The arithmetic lives in `geometry.ts` (`screenToWorld`, `zoomAt`,
 * `clampView`, `fitCanvasHeight`); this hook only holds the state and the two
 * listeners the browser forces on it — a native `wheel`, and a resize
 * observer on the drawing area.
 *
 * Hooks, in order: useState view, useState canvasHeight, useCallback toWorld,
 * useCallback slack, useEffect measure, useEffect wheel.
 */
import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import {
  FIT_VIEW,
  clampView,
  fitCanvasHeight,
  screenToWorld,
  viewScale,
  zoomAt,
  zoomPercent,
  type ViewBox,
} from "./geometry.js";

/** Pixels of slack around a pin, in canvas units at the current zoom. */
const PIN_SLACK = 9;

/** A world point, and whether the client point it came from is over the canvas. */
export interface WorldPoint {
  x: number;
  y: number;
  inside: boolean;
}

/** A press of the middle or right button: the view moves with the pointer. */
export interface PanDrag {
  kind: "pan";
  cx: number;
  cy: number;
  view: ViewBox;
  moved: boolean;
  button: number;
}

export interface Viewport {
  view: ViewBox;
  setView: Dispatch<SetStateAction<ViewBox>>;
  /** The drawing area's height in px: the fitted view's shape, capped by `height`. */
  canvasHeight: number;
  toWorld: (clientX: number, clientY: number) => WorldPoint;
  /** The hit radius around a pin or a waypoint, in world units at this zoom. */
  slack: () => number;
  /** Back to the whole frame. */
  fit: () => void;
  /** 100 % is the whole frame, port anchors included — the floor of zoom-out. */
  zoom: number;
}

export function useViewport(
  svgRef: RefObject<SVGSVGElement | null>,
  canvasRef: RefObject<HTMLDivElement | null>,
  height: number,
): Viewport {
  const [view, setView] = useState<ViewBox>(FIT_VIEW);
  /* The drawing area is as tall as the fitted view is, for the width it was
     given — never taller, or the frame floats in a band of empty canvas. */
  const [canvasHeight, setCanvasHeight] = useState<number>(height);

  const toWorld = useCallback(
    (clientX: number, clientY: number): WorldPoint => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect === undefined) return { x: 0, y: 0, inside: false };
      return {
        ...screenToWorld(rect, view, clientX, clientY),
        inside:
          clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom,
      };
    },
    [svgRef, view],
  );

  const slack = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined) return PIN_SLACK;
    const k = viewScale(rect, view);
    return Math.max(6, PIN_SLACK / k);
  }, [svgRef, view]);

  /* The drawing area takes the SHAPE of the fitted view, so that the frame
     plus its one-cell margin fills it on both axes instead of sitting in a
     letterbox. Only the width is read — the height is what this sets — and a
     `ResizeObserver` is what makes it survive a column that narrows, a
     sidebar that opens and a page that goes full screen. */
  useEffect(() => {
    const el = canvasRef.current;
    if (el === null) return;
    const measure = (): void => {
      setCanvasHeight((current) => {
        const next = fitCanvasHeight(el.clientWidth, height);
        return next === current ? current : next;
      });
    };
    measure();
    /* jsdom has no layout and no observer; the height then stays the cap. */
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    document.addEventListener("fullscreenchange", measure);
    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", measure);
    };
  }, [canvasRef, height]);

  /* Wheel has to be a native listener: React registers `wheel` passively on
     the root, where `preventDefault` is a no-op and the page scrolls away. */
  useEffect(() => {
    const el = svgRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const w = toWorld(e.clientX, e.clientY);
      setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), w.x, w.y));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [svgRef, toWorld]);

  return { view, setView, canvasHeight, toWorld, slack, fit: () => setView(FIT_VIEW), zoom: zoomPercent(view) };
}

/** A pan starts where the button went down, from the view as it is. */
export function panStart(
  e: { clientX: number; clientY: number; button: number },
  view: ViewBox,
): PanDrag {
  return { kind: "pan", cx: e.clientX, cy: e.clientY, view, moved: false, button: e.button };
}

/**
 * The view a pan has reached at this client point. It also marks the pan as
 * MOVED past three canvas units, so that a right click that did not travel
 * still counts as a click (it steps the wire tool back).
 */
export function panned(d: PanDrag, svg: SVGSVGElement | null, clientX: number, clientY: number): ViewBox {
  const rect = svg?.getBoundingClientRect();
  const k = rect === undefined ? 1 : viewScale(rect, d.view);
  const dx = (clientX - d.cx) / k;
  const dy = (clientY - d.cy) / k;
  if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
  return clampView({ ...d.view, x: d.view.x - dx, y: d.view.y - dy });
}
