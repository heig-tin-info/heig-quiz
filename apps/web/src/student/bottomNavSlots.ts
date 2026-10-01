import { bottomSlotOf, type BottomSlotId, type Route } from "../router";

/**
 * The student's bottom navigation bar on a phone (#191): its slots, when it
 * is drawn and which slot is lit. The rules are in DESIGN.md, "The student's
 * bottom bar"; `BottomNav.tsx` draws them.
 */

export type { BottomSlotId };

/** A slot leads to a page: every one of them is a route (Grades too, since `/grades`). */
export interface BottomSlot {
  id: BottomSlotId;
  route: Route;
}

/** In the order they are drawn; Drill (#317) in the middle. */
export const BOTTOM_SLOTS: readonly BottomSlot[] = [
  { id: "activities", route: { view: "home" } },
  { id: "courses", route: { view: "studentCourses" } },
  { id: "drill", route: { view: "drill" } },
  { id: "grades", route: { view: "studentGrades" } },
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

/**
 * The rows of the student's desktop sidebar (`Shell`'s `Nav`): the bar's
 * slots in the bar's order, minus Profile, which is the account menu's at the
 * foot of the sidebar (D07, 2026-10-01). The lit row is the bar's: the route
 * table's `bottomSlot` (`bottomSlotOf`).
 */
export function sidebarSlots(drill: boolean): readonly BottomSlot[] {
  return visibleSlots(drill).filter((s) => s.id !== "profile");
}

/** The bar is the student UI's, on the views the route table gives a slot. */
export function bottomNavShown(route: Route, teacherUi: boolean): boolean {
  return !teacherUi && bottomSlotOf(route) !== null;
}
