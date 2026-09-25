import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx, menuPosition, useLayer, Z, type MenuPlacement } from "./layers";

/**
 * A small card hung on a trigger: what a disc, a chip or an abbreviation
 * stands for, said in full — a colleague's name and address, the list behind
 * a "+2". It is built from the same two pieces as `Menu` (`menuPosition` for
 * the coordinates, `useLayer` for Escape and the focus) and closes the same
 * way (outside click, page scroll, resize), because a second way of placing a
 * floating panel is a second set of bugs. It is a `dialog` and not a `menu`:
 * what it holds is a card with a name, an address and maybe an action, which
 * arrows do not walk.
 *
 * Two ways in. `click` is the affordance for what a reader goes looking for;
 * `hover` is for what a pointer brushes past, and it is still clickable,
 * since a touch screen has no hover at all. A `Tip` remains the right answer
 * for a bare label — this one is for a card the reader may act in.
 */

/** What the panel is assumed to be worth when deciding to open it upward. */
const PANEL_MAX_HEIGHT = 240;
/**
 * Hover delay, and the grace given when the pointer leaves: the panel hangs
 * 6 px under its trigger, so the pointer travels over a gap on its way in and
 * a panel that closed on the first `mouseleave` could never be reached.
 */
const HOVER_DELAY = 150;

export function Popover({
  trigger,
  label,
  children,
  open: mode = "click",
  align = "end",
  className = "",
}: {
  /** The element the card hangs from; it receives the ARIA state. */
  trigger: ReactElement;
  /** Accessible name of the card (`role="dialog"`). */
  label: string;
  children: ReactNode;
  open?: "click" | "hover";
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  /**
   * Whether the focus was moved into the panel when it opened. Only a
   * KEYBOARD opening traps: a reader who clicked or hovered is still pointing
   * at the page, and pulling their focus into the card would strand it there.
   */
  const [trap, setTrap] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * A pointer is pressing the trigger. The focus a click gives it is not the
   * kind of focus that opens a hover popover: without this, the focus opened
   * the card and the click that caused it closed it again, which is exactly
   * what a touch screen does with no hover to open it first.
   */
  const pressing = useRef(false);
  const panelId = useId();

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) anchor.current?.querySelector<HTMLElement>("button, a")?.focus();
  }, []);

  /** Where the panel goes for the trigger as it is NOW; null without one. */
  const place = useCallback((): MenuPlacement | null => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return null;
    return menuPosition(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      align,
      PANEL_MAX_HEIGHT,
    );
  }, [align]);

  const show = (withTrap: boolean) => {
    const placement = place();
    if (!placement) return;
    setPos(placement);
    setTrap(withTrap);
    setOpen(true);
  };

  useLayer(panel, () => close(true), { trap, enabled: open });

  useEffect(() => () => clearTimer(), []);

  // Outside click, page scroll and resize. The panel is `position: fixed` on
  // measured coordinates, so a scroll that moves the trigger would leave it
  // pointing at nothing — but not every scroll is the reader leaving: acting
  // IN the card can change the page under it (a checkbox that hides part of
  // the page shortens it, the browser clamps the scroll and fires the event).
  // So a scroll follows the trigger while it is on screen, and closes the
  // card only once the trigger has left the window.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      // `window` is not a Node, and `contains` throws on one.
      if (e.target instanceof Node && panel.current?.contains(e.target)) return;
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect || rect.bottom <= 0 || rect.top >= window.innerHeight) {
        close(false);
        return;
      }
      const placement = place();
      if (placement) setPos(placement);
    };
    const onResize = () => close(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close, place]);

  /*
   * `menuPosition` anchors the panel on the trigger and knows nothing of its
   * width, so a right-aligned trigger near the left edge put half the card off
   * screen. Measured once it is laid out and nudged back in, like the menu's
   * own clamp — and computed from `pos`, never from the rectangle, because the
   * opening animation owns `transform` while it plays.
   */
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el || !pos) return;
    const margin = 8;
    const clamp = () => {
      el.style.marginLeft = "";
      const width = el.offsetWidth;
      const left = align === "end" ? pos.left - width : pos.left;
      const shift =
        left < margin
          ? margin - left
          : left + width > window.innerWidth - margin
            ? window.innerWidth - margin - (left + width)
            : 0;
      if (shift) el.style.marginLeft = `${shift}px`;
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, pos, align]);

  const hoverIn = () => {
    if (mode !== "hover" || open) return;
    clearTimer();
    timer.current = setTimeout(() => show(false), HOVER_DELAY);
  };
  const hoverOut = () => {
    // A press the pointer carried away is over: the next focus is a real one.
    pressing.current = false;
    if (mode !== "hover") return;
    clearTimer();
    timer.current = setTimeout(() => close(false), HOVER_DELAY);
  };

  const triggerProps = {
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
    "aria-controls": open ? panelId : undefined,
  };
  const triggerNode = isValidElement<Record<string, unknown>>(trigger)
    ? // Clone so the ARIA state lands on the caller's real button.
      cloneElement(trigger, triggerProps)
    : trigger;

  return (
    <>
      <span
        ref={anchor}
        className="inline-flex"
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
        onMouseDown={() => {
          pressing.current = true;
        }}
        onFocus={() => {
          if (mode === "hover" && !open && !pressing.current) {
            clearTimer();
            show(false);
          }
        }}
        onBlur={(e) => {
          if (mode !== "hover") return;
          if (panel.current?.contains(e.relatedTarget as Node | null)) return;
          hoverOut();
        }}
        onKeyDown={(e) => {
          if (open || (e.key !== "Enter" && e.key !== " ")) return;
          // preventDefault also swallows the click the browser would
          // synthesize, so the toggle below does not close it again.
          e.preventDefault();
          clearTimer();
          show(true);
        }}
        onClick={(e) => {
          e.stopPropagation();
          pressing.current = false;
          clearTimer();
          if (open) close(false);
          else show(false);
        }}
      >
        {triggerNode}
      </span>
      {open && pos
        ? createPortal(
            <div
              ref={panel}
              id={panelId}
              role="dialog"
              aria-label={label}
              tabIndex={-1}
              onMouseEnter={() => {
                if (mode === "hover") clearTimer();
              }}
              onMouseLeave={hoverOut}
              onClick={(e) => e.stopPropagation()}
              className={cx(
                "menu-panel fixed min-w-56 max-w-xs rounded-menu border border-line bg-surface p-3 shadow-popover focus:outline-none",
                Z.popover,
                className,
              )}
              style={
                {
                  top: pos.top,
                  bottom: pos.bottom,
                  left: pos.left,
                  // Not `transform`: `.menu-panel` animates that property on
                  // open and owns it entirely while it plays, so the alignment
                  // offset travels as a custom property the keyframes compose
                  // in (style.css).
                  "--menu-x": align === "end" ? "-100%" : "0",
                  transformOrigin: `${pos.up ? "bottom" : "top"} ${align === "end" ? "right" : "left"}`,
                } as React.CSSProperties
              }
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
