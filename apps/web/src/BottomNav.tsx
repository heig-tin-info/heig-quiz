import type { MouseEvent } from "react";

import { visibleSlots, type BottomSlot } from "./bottomNavSlots";
import type { DrillAvailability } from "./drill/api";
import { AvailableDot } from "./drill/AvailableDot";
import { useT } from "./i18n";
import { bottomSlotOf, routeToPath, type Route } from "./router";
import { cx, isPlainClick } from "./ui";

/**
 * The bottom bar on a phone: DESIGN.md, "The bottom bar (phone)". One bar,
 * two sets of slots: the student's (#191) and the teacher's (#449).
 * `drill`: for the student, whether the Drill slot is drawn, and whether
 * today's drill is available (its badge, #317).
 */
export function BottomNav({
  route,
  navigate,
  teacherUi,
  drill,
}: {
  route: Route;
  navigate: (r: Route) => void;
  teacherUi: boolean;
  drill: DrillAvailability;
}) {
  const t = useT();
  const active = bottomSlotOf(route, teacherUi);

  const go = (slot: BottomSlot) => (e: MouseEvent<HTMLAnchorElement>) => {
    // A modified click is the browser's: a new tab gets the real address.
    if (!isPlainClick(e)) return;
    e.preventDefault();
    navigate(slot.route);
  };

  return (
    <>
      <div aria-hidden className="h-[calc(var(--bottom-nav-h)+var(--fab-h))]" />
      <nav
        data-bottom-dock=""
        aria-label={t("bnav.label")}
        className="pointer-events-none fixed inset-x-0 bottom-0 z-20 px-4 pb-(--bottom-nav-gap) lg:hidden"
      >
        <ul className="pointer-events-auto mx-auto flex h-14 max-w-sm items-center rounded-full border border-line bg-surface/85 px-1.5 shadow-popover backdrop-blur-xl">
          {visibleSlots(teacherUi, drill.shown).map((slot) => {
            const { icon: Icon, label } = slot;
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
