/**
 * The editor's view: a pan and a zoom over the canvas, the first view fitted
 * to the content, the wheel zooming around the pointer, and the mapping of a
 * pointer event to canvas units.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { Bounds } from "../geometry.js";
import type { Point } from "../scene.js";

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Viewport {
  view: View;
  /** A pointer event in canvas units, and whether it is over the canvas. */
  toWorld: (e: { clientX: number; clientY: number }) => Point & { inside: boolean };
  /** The view moved by a pan from where it was when the pan began. */
  panFrom: (start: View, dx: number, dy: number) => void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export function useViewport(svgRef: RefObject<SVGSVGElement | null>, content: Bounds | null): Viewport {
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });

  /* the first view: the content fitted, at most at 100 % */
  const fitted = useRef(false);
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (fitted.current || !el || !content) return;
    const box = el.getBoundingClientRect();
    if (box.width === 0) return;
    fitted.current = true;
    const x0 = content.x0 - 40;
    const y0 = content.y0 - 40;
    const w = content.x1 - content.x0 + 80;
    const h = content.y1 - content.y0 + 80;
    const k = Math.min(1, box.width / w, box.height / h);
    setView({ k, x: (box.width - w * k) / 2 - x0 * k, y: (box.height - h * k) / 2 - y0 * k });
  }, [svgRef, content]);

  /* the wheel zooms around the pointer; React's own wheel listener is passive */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: sx - ((sx - v.x) * k) / v.k, y: sy - ((sy - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [svgRef]);

  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0, inside: false };
      return {
        x: (e.clientX - r.left - view.x) / view.k,
        y: (e.clientY - r.top - view.y) / view.k,
        inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom,
      };
    },
    [svgRef, view],
  );
  const panFrom = useCallback((start: View, dx: number, dy: number) => setView({ ...start, x: start.x + dx, y: start.y + dy }), []);

  return { view, toWorld, panFrom };
}
