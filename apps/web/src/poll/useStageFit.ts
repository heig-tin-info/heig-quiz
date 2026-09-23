import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { FIT_PROBES, fitScale, layoutWidthFor, nextProbe } from "./fit";

/**
 * The middle band, scaled so the whole of it is on the wall.
 *
 * A projection may not scroll: a bar below the fold is a bar nobody in the
 * room will ever see, and a scrollbar on a beamer is a bug the teacher
 * discovers in front of forty people. `questionScale()` steps the title down
 * by the length of the prompt, but the bars are what usually overflow — eight
 * choices of two lines each clear a 1280 × 720 projector on their own. So the
 * band is measured and, when it is too tall, drawn through one
 * `transform: scale()`; `fitScale()` holds the arithmetic and says why a
 * transform rather than a font size.
 *
 * `ready` is whether the band exists yet: the screen renders a skeleton and an
 * error state before it, and the observer has nothing to watch until then.
 */
export function useStageFit(ready: boolean) {
  const area = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  /** `width` is the LAYOUT width in pixels, `null` meaning the area's own. */
  const [fit, setFit] = useState<{ scale: number; width: number | null; height: number | null }>({
    scale: 1,
    width: null,
    height: null,
  });

  const measure = useCallback(() => {
    const box = area.current;
    const block = content.current;
    if (box === null || block === null) return;
    const commit = (next: { scale: number; width: number | null; height: number | null }) => {
      // The probes above leave the block wherever the last measurement put it;
      // this is what puts it back where the render says it belongs, so the DOM
      // is right even when the state below turns out to be unchanged.
      block.style.width = next.width === null ? "" : `${next.width}px`;
      block.style.transform = next.scale < 1 ? `scale(${next.scale})` : "";
      setFit((prev) =>
        prev.scale === next.scale && prev.width === next.width && prev.height === next.height
          ? prev
          : next,
      );
    };

    // A phone is not a beamer. Below `sm` the stage is an ordinary page whose
    // middle band GROWS with its content, so a scale taken from it would chase
    // its own result down to nothing; there the page simply scrolls.
    const beamer =
      typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches;
    const availW = box.clientWidth;
    const availH = box.clientHeight;
    if (!beamer || availW <= 0 || availH <= 0) {
      commit({ scale: 1, width: null, height: null });
      return;
    }

    /*
     * The search. Every candidate is MEASURED rather than predicted, because
     * the height of a block is not a smooth function of its width: it steps
     * down each time a label stops wrapping. `offsetWidth`/`offsetHeight` are
     * layout sizes that a transform does not touch, which is what keeps the
     * measurement independent of the scale it produces.
     */
    block.style.transform = "none";
    // No inline width: the block falls back to `w-full`, which is the area's
    // own width — the layout the screen was designed at, and the only honest
    // starting point. (Without that class it would fall back to `max-content`,
    // and the search would start from a line length nobody has ever seen.)
    block.style.width = "";
    const natural = fitScale(block.offsetWidth, block.offsetHeight, availW, availH);
    if (natural >= 1) {
      commit({ scale: 1, width: null, height: null });
      return;
    }

    /*
     * `lo` is the largest scale whose layout has been MEASURED and does fit;
     * `hi` the smallest one known not to. The first candidate is the un-widened
     * fit, which cannot fail — the same block drawn on the same wall, only
     * laid out wider, is never taller — so the search always has an answer and
     * the worst case is exactly what a plain scale would have given.
     */
    let lo = natural;
    let hi = 1;
    let slack = 0;
    let best: { scale: number; width: number; height: number } | null = null;
    for (let probe = 0; probe < FIT_PROBES; probe += 1) {
      const candidate = probe === 0 ? natural : nextProbe(lo, hi, slack);
      if (probe > 0 && (candidate <= lo || candidate >= hi)) break;
      const width = layoutWidthFor(availW, candidate);
      block.style.width = `${width}px`;
      const drawn = block.offsetHeight * candidate;
      if (drawn <= availH) {
        lo = candidate;
        slack = availH / Math.max(1, drawn);
        best = { scale: candidate, width, height: Math.round(drawn) };
      } else {
        hi = candidate;
        slack = 0;
      }
    }
    commit(best ?? { scale: natural, width: layoutWidthFor(availW, natural), height: null });
  }, []);

  // After every commit: a new question, a reveal, one more tally frame — each
  // changes the height of the block, and each arrives through a render.
  useLayoutEffect(measure);

  useEffect(() => {
    const box = area.current;
    const block = content.current;
    if (typeof ResizeObserver !== "function" || box === null || block === null) return undefined;
    // Two boxes, one observer: the area moves when the projector does (full
    // screen, a resized window, a rotated display), the block when a web font
    // finally lands or a long label rewraps. The observer converges: `measure`
    // is a function of the area and of the text, so the layout it writes back
    // is the one it just measured, and the next notification changes nothing.
    const observer = new ResizeObserver(() => measure());
    observer.observe(box);
    observer.observe(block);
    return () => observer.disconnect();
  }, [measure, ready]);

  useEffect(() => {
    const onChange = () => measure();
    window.addEventListener("resize", onChange);
    // Leaving full screen through the browser's own chrome resizes nothing
    // the observer above can see until the next frame; this is that frame.
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      document.removeEventListener("fullscreenchange", onChange);
    };
  }, [measure]);

  return { area, content, scale: fit.scale, width: fit.width, height: fit.height };
}
