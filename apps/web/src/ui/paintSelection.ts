import { useEffect, useRef } from "react";

/** One drag across checkboxes: the state it paints and the rows it reached. */
interface Gesture {
  on: boolean;
  origin: string;
  painted: Set<string>;
}

/**
 * Drag across checkboxes to tick (or untick) them all, as in a file manager.
 *
 * The caller wires `start` and `enter` on a wrapper around each checkbox
 * (`Checkbox` spreads its props on the 16 px input; the wrapper covers the
 * whole hit area) and wraps the row's toggle in `change`; a row that must not
 * be painted is simply not wired. The pressed box is painted late, when the
 * pointer reaches a second one: a press without a drag stays a plain click.
 * The browser fires `pointerup` before `click`, so the release drops the
 * record on the next task only: the click that follows, on a row already
 * painted, is swallowed (it would toggle the origin back), and a later Space
 * on that box toggles as usual.
 */
export function usePaintSelection(apply: (id: string, on: boolean) => void) {
  const gesture = useRef<Gesture | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (gesture.current === null) return;
      timer = setTimeout(() => {
        gesture.current = null;
      }, 0);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      clearTimeout(timer);
    };
  }, []);

  return {
    /** onPointerDown of a checkbox: the gesture paints the inverse of the pressed box. Primary button only. */
    start: (id: string, checked: boolean) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      gesture.current = { on: !checked, origin: id, painted: new Set() };
    },
    /** onPointerEnter of a checkbox: while the primary button is held, paint it, and the origin first. */
    enter: (id: string) => (e: React.PointerEvent) => {
      const g = gesture.current;
      if (g === null || (e.buttons & 1) === 0) return;
      for (const each of [g.origin, id]) {
        if (g.painted.has(each)) continue;
        g.painted.add(each);
        apply(each, g.on);
      }
    },
    /** Wraps a row's toggle: a click on a row the gesture already painted is swallowed. */
    change: (id: string, toggle: () => void) => () => {
      if (gesture.current?.painted.has(id)) return;
      toggle();
    },
  };
}

export type PaintSelection = ReturnType<typeof usePaintSelection>;
