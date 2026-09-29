import { CalendarRange, School, Trophy, UserRound } from "lucide-react";
import { useEffect, useLayoutEffect, useReducer, type MouseEvent } from "react";

import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { routeToPath, type Route } from "../router";
import { cx, type IconType } from "../ui";
import { activeSlot, BOTTOM_SLOTS, type BottomSlot, type BottomSlotId } from "./bottomNavSlots";

const SLOT_LOOK: Record<BottomSlotId, { icon: IconType; label: keyof Dict }> = {
  activities: { icon: CalendarRange, label: "nav.activities" },
  courses: { icon: School, label: "nav.courses" },
  grades: { icon: Trophy, label: "bnav.grades" },
  profile: { icon: UserRound, label: "bnav.profile" },
};

/**
 * The student's bottom navigation bar on a phone (#191, DESIGN.md). It is
 * NAVIGATION, never an action: no slot wears the accent fill, and a screen's
 * one primary button stays the one red thing on it.
 *
 * Fixed to the bottom under `lg` (the frame's own breakpoint: the sidebar
 * above it, the top bar and this bar below), with the iOS home-indicator
 * inset under its row. `--bottom-nav-h` (style.css) is its whole height while
 * it is mounted, which the spacer below and the toast stack read, so neither
 * the end of the page nor a toast ever sits behind it.
 */
export function BottomNav({ route, navigate }: { route: Route; navigate: (r: Route) => void }) {
  const t = useT();
  // The address bar's hash IS the state (`#past`, `#classrooms`); this only
  // re-renders when it changes without a route change.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener("hashchange", rerender);
    return () => window.removeEventListener("hashchange", rerender);
  }, []);
  // Before the first paint, so the spacer never starts at zero.
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-bottom-nav", "");
    return () => document.documentElement.removeAttribute("data-bottom-nav");
  }, []);
  const active = activeSlot(route, window.location.hash);

  const go = (slot: BottomSlot) => (e: MouseEvent<HTMLAnchorElement>) => {
    // A modified click is the browser's: a new tab gets the real address.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(slot.route);
    // The section rides the address, replaced rather than pushed: it is a
    // place on the same page, and Back should leave the page, not scroll it.
    window.history.replaceState(null, "", hrefOf(slot));
    rerender();
    if (slot.anchor) {
      const anchor = slot.anchor;
      // The home may be mounting: its own effect scrolls once it is drawn.
      requestAnimationFrame(() =>
        // Optional call: `scrollIntoView` does not exist under jsdom.
        document.getElementById(anchor)?.scrollIntoView?.({ block: "start" }),
      );
    } else window.scrollTo({ top: 0 });
  };

  return (
    <>
      <div aria-hidden className="h-(--bottom-nav-h) lg:hidden" />
      <nav
        aria-label={t("bnav.label")}
        className="fixed inset-x-0 bottom-0 z-20 h-(--bottom-nav-h) border-t border-line bg-canvas/90 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto flex h-full max-w-140">
          {BOTTOM_SLOTS.map((slot) => {
            const { icon: Icon, label } = SLOT_LOOK[slot.id];
            const current = slot.id === active;
            return (
              <li key={slot.id} className="min-w-0 flex-1">
                <a
                  href={hrefOf(slot)}
                  onClick={go(slot)}
                  aria-current={current ? "page" : undefined}
                  className={cx(
                    "flex h-full flex-col items-center justify-center gap-0.5 text-[11px] leading-tight transition-colors",
                    current ? "font-semibold text-accent" : "font-medium text-fg-muted hover:text-fg",
                  )}
                >
                  <span
                    className={cx(
                      "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                      current ? "bg-accent-soft" : "text-fg-faint",
                    )}
                  >
                    <Icon aria-hidden className="size-5" />
                  </span>
                  <span className="max-w-full truncate px-1">{t(label)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

function hrefOf(slot: BottomSlot): string {
  return routeToPath(slot.route) + (slot.anchor ? `#${slot.anchor}` : "");
}
