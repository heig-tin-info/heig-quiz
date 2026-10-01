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
                  href={routeToPath(slot.route)}
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
