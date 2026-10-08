/**
 * The screen's primary action as a floating button on a phone (#450,
 * DESIGN.md › "The floating action button (phone)"): a 56 px `accent` pill
 * at the bottom right, above the bottom bar, holding the action's icon and
 * its label, which folds away to leave the circle once the page scrolls.
 *
 * It is not called by a screen: `PageHeader` renders it in place of its
 * `primary` button under `lg`, so a screen has one primary and one place to
 * declare it.
 *
 * The wrapper reaches the window's bottom edge and is a bottom dock
 * (`data-bottom-dock`): the coach keeps its bubbles above it. `data-fab`
 * sets `--fab-h` (`style.css`), which lifts the toasts and the docked tools
 * above it and lengthens the page's end spacer; while a list's selection bar
 * is up, the FAB steps aside (`style.css`).
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { cx, Z, type IconType } from "./layers";

/** A screen's one primary action, when it creates something (`PageHeader`'s `primary`). */
export type PagePrimary = {
  icon: IconType;
  /** The visible label and, always, the accessible name: "New course". */
  label: string;
  onClick: () => void;
  /** The coach target (`data-coach`), carried by the button and by the FAB. */
  coach?: string;
};

/** Scrolled past this many pixels, the label folds away. */
const COLLAPSE_AFTER = 8;

function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(() => window.scrollY > COLLAPSE_AFTER);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > COLLAPSE_AFTER);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return scrolled;
}

export function Fab({ icon: Icon, label, onClick, coach }: PagePrimary) {
  const collapsed = useScrolled();
  return createPortal(
    <div
      data-fab=""
      data-bottom-dock=""
      className={cx(
        "pointer-events-none fixed right-0 bottom-0 pr-4 pb-[calc(var(--bottom-nav-h)+1rem)] lg:hidden",
        Z.tool,
      )}
    >
      <button
        type="button"
        aria-label={label}
        data-coach={coach}
        data-collapsed={collapsed ? "" : undefined}
        onClick={onClick}
        className="pointer-events-auto inline-flex h-14 min-w-14 items-center justify-center rounded-full bg-accent px-4 text-on-fill shadow-overlay transition-[background-color,transform] duration-120 hover:bg-accent-hover active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        <Icon className="size-6 shrink-0" />
        <span
          aria-hidden
          className={cx(
            "overflow-hidden whitespace-nowrap text-[15px] font-semibold transition-[max-width,opacity,margin] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
            collapsed ? "ml-0 max-w-0 opacity-0" : "ml-2 max-w-64 pr-1 opacity-100",
          )}
        >
          {label}
        </span>
      </button>
    </div>,
    document.body,
  );
}
