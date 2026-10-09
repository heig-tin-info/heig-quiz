import { useEffect, useRef, useState, type RefObject } from "react";
import { prefersReducedMotion } from "@quiz/ui";

/** The step a scene shows when the reader asked for no motion: its end state. */
export const STILL = 1_000;

/**
 * Whether the element is on screen. `once` keeps it true after the first
 * sighting (a reveal); otherwise it follows the element in and out, so a
 * scene scrolled away stops ticking.
 */
export function useInView<T extends Element>(once = false): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry?.isIntersecting ?? false;
        if (once && !visible) return;
        setInView(visible);
        if (once && visible) observer.disconnect();
      },
      { threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [once]);
  return [ref, inView];
}

/**
 * A counter that advances every `period` ms while `running`, and wraps after
 * `length` steps so a scene loops. Under reduced motion it is `STILL` at
 * once: every scene draws its end state from it.
 */
export function useStep(period: number, length: number, running: boolean): number {
  const [still] = useState(prefersReducedMotion);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (still || !running) return;
    const id = window.setInterval(() => setStep((s) => (s + 1) % length), period);
    return () => window.clearInterval(id);
  }, [still, running, period, length]);
  return still ? STILL : step;
}

/** A section that fades and rises in when it first reaches the screen. */
export function useReveal<T extends Element>(): [RefObject<T | null>, string] {
  const [ref, seen] = useInView<T>(true);
  return [ref, seen ? "reveal is-in" : "reveal"];
}
