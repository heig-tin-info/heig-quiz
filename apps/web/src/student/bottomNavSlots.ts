import { bottomSlotOf, type BottomSlotId, type Route } from "../router";

/**
 * The student's bottom navigation bar on a phone (#191): its slots, when it
 * is drawn and which slot is lit. The rules are in DESIGN.md, "The student's
 * bottom bar"; `BottomNav.tsx` draws them.
 */

export type { BottomSlotId };

export interface BottomSlot {
  id: BottomSlotId;
  route: Route;
  /** The `id` of the section of the student home the slot scrolls to. */
  anchor?: string;
}

/** The anchors of the student home's sections, written once for both sides. */
export const HOME_SECTION = { courses: "classrooms", grades: "past" } as const;

/** In the order they are drawn; Drill (#317) goes in the middle. */
export const BOTTOM_SLOTS: readonly BottomSlot[] = [
  { id: "activities", route: { view: "home" } },
  { id: "courses", route: { view: "home" }, anchor: HOME_SECTION.courses },
  { id: "grades", route: { view: "home" }, anchor: HOME_SECTION.grades },
  { id: "profile", route: { view: "settings" } },
];

/** The bar is the student UI's, on the views the route table gives a slot. */
export function bottomNavShown(route: Route, teacherUi: boolean): boolean {
  return !teacherUi && bottomSlotOf(route) !== null;
}

/**
 * The slot lit for `route`: the route table's, except on the home, where the
 * address's `hash` (`#past`, …) names the section a slot scrolled to.
 */
export function activeSlot(route: Route, hash: string): BottomSlotId | null {
  if (route.view === "home") {
    const section = BOTTOM_SLOTS.find((s) => s.anchor !== undefined && `#${s.anchor}` === hash);
    if (section) return section.id;
  }
  return bottomSlotOf(route);
}
