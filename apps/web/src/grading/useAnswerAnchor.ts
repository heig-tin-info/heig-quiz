import { useLayoutEffect, useRef, useState } from "react";

import { useMinWidth } from "../ui";

/** The phone's sticky top bar (`h-14` in `Shell`) plus a little air. */
const PHONE_BAR = 64;

/**
 * Keeping the answer in one place (#102). From `lg` the step header sticks
 * to the top of the window; its measured height is what the list column and
 * the detail's own header stick under (`--grading-sticky`).
 *
 * Another answer opened: its top goes right under whatever sticks at the top
 * of the window (the step header from `lg`, the phone's top bar below),
 * wherever the teacher had scrolled to in the previous one — the next step's
 * first answer included. The answer the panel opens on is not a move, and
 * does not scroll.
 *
 * `remeasure` is whatever may change the header's height without resizing
 * it in a way the observer sees first (the number of steps).
 */
export function useAnswerAnchor(selected: string | null, remeasure: unknown) {
  const wide = useMinWidth(1024);
  const stickyRef = useRef<HTMLDivElement>(null);
  const answersRef = useRef<HTMLElement>(null);
  const [stickyHeight, setStickyHeight] = useState(0);

  useLayoutEffect(() => {
    const el = stickyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setStickyHeight(wide ? el.offsetHeight : 0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [wide, remeasure]);

  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = selected;
    const el = answersRef.current;
    if (!el || was === null || selected === null || was === selected) return;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return; // no layout (a test): nothing to align
    const target = wide ? stickyHeight : PHONE_BAR;
    if (Math.abs(rect.top - target) > 1) window.scrollBy({ top: rect.top - target });
  }, [selected, wide, stickyHeight]);

  return { stickyRef, answersRef, stickyHeight };
}
