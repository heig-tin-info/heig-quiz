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

/** The anchor of the student home's Grades section (until M5-04), written once for both sides. */
export const HOME_SECTION = { grades: "past" } as const;

/** In the order they are drawn; Drill (#317) in the middle. */
export const BOTTOM_SLOTS: readonly BottomSlot[] = [
  { id: "activities", route: { view: "home" } },
  { id: "courses", route: { view: "studentCourses" } },
  { id: "drill", route: { view: "drill" } },
  { id: "grades", route: { view: "home" }, anchor: HOME_SECTION.grades },
  { id: "profile", route: { view: "settings" } },
];

/**
 * The slots drawn: Drill only for a student with at least one classroom
 * whose drill is on (ADR-041 §6) — a slot leading to "your teacher has not
 * turned this on" is a slot for nothing.
 */
export function visibleSlots(drill: boolean): readonly BottomSlot[] {
  return drill ? BOTTOM_SLOTS : BOTTOM_SLOTS.filter((s) => s.id !== "drill");
}

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
