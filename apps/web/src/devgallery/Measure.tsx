import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Dev gallery only (issue #552). Wraps one specimen and prints what the
 * browser actually laid out under it ("34 px · pill"), so the before/after
 * comparison is a measurement, not a reading of the class lists.
 */
const CONTROL = "input,select,button,textarea,[role=radiogroup]";

export function Measure({ caption, children }: { caption: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState("");

  useLayoutEffect(() => {
    const root = box.current?.firstElementChild as HTMLElement | null;
    if (!root) return;
    const target = root.matches(CONTROL) ? root : (root.querySelector<HTMLElement>(CONTROL) ?? root);
    const read = () => {
      const h = target.getBoundingClientRect().height;
      const r = parseFloat(getComputedStyle(target).borderTopLeftRadius);
      const shape = r >= h / 2 - 1 ? "pill" : `${Math.round(r)} px radius`;
      setInfo(`${Math.round(h * 2) / 2} px · ${shape}`);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(target);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div ref={box} className="contents">
        {children}
      </div>
      <span className="font-mono text-[11px] text-fg-faint">
        {caption} <span className="text-fg-muted">{info}</span>
      </span>
    </div>
  );
}
