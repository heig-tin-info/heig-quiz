import { CalendarRange, Dumbbell, Library, School, Trophy, UserRound } from "lucide-react";
import type { MouseEvent } from "react";

import type { DrillAvailability } from "../drill/api";
import { AvailableDot } from "../drill/AvailableDot";
import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { bottomSlotOf, routeToPath, type Route } from "../router";
import { cx, isPlainClick, type IconType } from "../ui";
import { visibleSlots, type BottomSlot, type BottomSlotId } from "./bottomNavSlots";

/**
 * Each slot's icon and label, for the bar and for the student's sidebar rows
 * that mirror it (`sidebarSlots`): one label, the page's own name.
 */
export const SLOT_LOOK: Record<BottomSlotId, { icon: IconType; label: keyof Dict }> = {
  activities: { icon: CalendarRange, label: "nav.activities" },
  courses: { icon: School, label: "nav.courses" },
  drill: { icon: Dumbbell, label: "nav.drill" },
  grades: { icon: Trophy, label: "bnav.grades" },
  profile: { icon: UserRound, label: "bnav.profile" },
};

/**
 * The home's name and icon, as the first row of the sidebar shows them: a
 * teacher's Courses, a student's Activities (their first slot). The palette
 * and the placeholder pages name the home this way too.
 */
export function homeLook(teacherUi: boolean): { icon: IconType; label: keyof Dict } {
  return teacherUi ? { icon: Library, label: "nav.courses" } : SLOT_LOOK.activities;
}

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
  const active = bottomSlotOf(route);

  const go = (slot: BottomSlot) => (e: MouseEvent<HTMLAnchorElement>) => {
    // A modified click is the browser's: a new tab gets the real address.
    if (!isPlainClick(e)) return;
    e.preventDefault();
    navigate(slot.route);
  };

  return (
    <>
      <div aria-hidden className="h-(--bottom-nav-h)" />
      <nav
        data-bottom-dock=""
        aria-label={t("bnav.label")}
        className="pointer-events-none fixed inset-x-0 bottom-0 z-20 px-4 pb-(--bottom-nav-gap) lg:hidden"
      >
        <ul className="pointer-events-auto mx-auto flex h-14 max-w-sm items-center rounded-full border border-line bg-surface/85 px-1.5 shadow-popover backdrop-blur-xl">
          {visibleSlots(drill.shown).map((slot) => {
            const { icon: Icon, label } = SLOT_LOOK[slot.id];
            const current = slot.id === active;
            const badge = slot.id === "drill" && drill.available;
            return (
              <li key={slot.id} className="flex h-full min-w-0 flex-1 items-center justify-center">
                <a
                  href={routeToPath(slot.route)}
                  onClick={go(slot)}
                  aria-current={current ? "page" : undefined}
                  className={cx(
                    "flex h-11 w-full max-w-16 items-center justify-center rounded-full transition-colors",
                    current ? "bg-accent-soft text-accent" : "text-fg-muted hover:text-fg",
                  )}
                >
                  <span className="relative">
                    <Icon aria-hidden className={cx("size-6", current ? "stroke-[2.25]" : "stroke-[1.75]")} />
                    {badge ? (
                      <span className="absolute -right-1 -top-0.5">
                        <AvailableDot />
                      </span>
                    ) : null}
                  </span>
                  <span className="sr-only">{t(label)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
