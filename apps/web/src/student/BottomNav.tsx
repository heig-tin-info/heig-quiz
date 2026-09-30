import { CalendarRange, Dumbbell, School, Trophy, UserRound } from "lucide-react";
import type { MouseEvent } from "react";

import type { DrillAvailability } from "../drill/api";
import { AvailableDot } from "../drill/AvailableDot";
import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { routeToPath, type Route } from "../router";
import { cx, isPlainClick, type IconType } from "../ui";
import { activeSlot, visibleSlots, type BottomSlot, type BottomSlotId } from "./bottomNavSlots";

const SLOT_LOOK: Record<BottomSlotId, { icon: IconType; label: keyof Dict }> = {
  activities: { icon: CalendarRange, label: "nav.activities" },
  courses: { icon: School, label: "nav.courses" },
  drill: { icon: Dumbbell, label: "bnav.drill" },
  grades: { icon: Trophy, label: "bnav.grades" },
  profile: { icon: UserRound, label: "bnav.profile" },
};

/**
 * The student's bottom bar on a phone: DESIGN.md, "The student's bottom bar" (#191).
 * `drill`: whether the Drill slot is drawn, and whether today's drill is
 * available (its badge, #317).
 */
export function BottomNav({
  route,
  navigate,
  drill,
}: {
  route: Route;
  navigate: (r: Route) => void;
  drill: DrillAvailability;
}) {
  const t = useT();
  const active = activeSlot(route, window.location.hash);

  const go = (slot: BottomSlot) => (e: MouseEvent<HTMLAnchorElement>) => {
    // A modified click is the browser's: a new tab gets the real address.
    if (!isPlainClick(e)) return;
    e.preventDefault();
    // A fresh route: the same slot twice is a new state, so the bar re-reads the hash.
    navigate({ ...slot.route });
    // After the push, and replaced: the section is a place on the page, and
    // Back leaves the page. The home scrolls to it (`StudentHome`).
    window.history.replaceState(null, "", hrefOf(slot));
  };

  return (
    <>
      <div aria-hidden className="h-(--bottom-nav-h)" />
      <nav
        data-bottom-dock=""
        aria-label={t("bnav.label")}
        className="fixed inset-x-0 bottom-0 z-20 h-(--bottom-nav-h) border-t border-line bg-canvas/90 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto flex h-full max-w-140">
          {visibleSlots(drill.shown).map((slot) => {
            const { icon: Icon, label } = SLOT_LOOK[slot.id];
            const current = slot.id === active;
            const badge = slot.id === "drill" && drill.available;
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
                      "relative flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                      current ? "bg-accent-soft" : "text-fg-faint",
                    )}
                  >
                    <Icon aria-hidden className="size-5" />
                    {badge ? (
                      <span className="absolute right-2.5 top-0.5">
                        <AvailableDot />
                      </span>
                    ) : null}
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
