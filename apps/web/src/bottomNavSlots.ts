import { CalendarRange, Dumbbell, Library, School, Trophy, UserRound, Vote } from "lucide-react";

import type { Dict } from "./i18n";
import { bottomSlotOf, type BottomSlotId, type Route, type StudentSlotId, type TeacherSlotId } from "./router";
import type { IconType } from "./ui";

/**
 * The bottom navigation bar on a phone: its two sets of slots, the student's
 * (#191) and the teacher's (#449), when it is drawn and which slot is lit.
 * The rules are in DESIGN.md, "The bottom bar (phone)"; `BottomNav.tsx`
 * draws them.
 */

export type { BottomSlotId };

/**
 * A slot leads to a page: every one of them is a route. Its icon and its
 * label, the page's own name, are the bar's and those of the student's
 * sidebar rows that mirror it (`sidebarSlots`).
 */
export interface BottomSlot<Id extends BottomSlotId = BottomSlotId> {
  id: Id;
  route: Route;
  icon: IconType;
  label: keyof Dict;
}

/** The student's, in the order they are drawn; Drill (#317) in the middle. */
export const STUDENT_SLOTS: readonly BottomSlot<StudentSlotId>[] = [
  { id: "activities", route: { view: "home" }, icon: CalendarRange, label: "nav.activities" },
  { id: "courses", route: { view: "studentCourses" }, icon: School, label: "nav.courses" },
  { id: "drill", route: { view: "drill" }, icon: Dumbbell, label: "nav.drill" },
  { id: "grades", route: { view: "studentGrades" }, icon: Trophy, label: "bnav.grades" },
  { id: "profile", route: { view: "settings" }, icon: UserRound, label: "bnav.profile" },
];

/**
 * The teacher's (#449), mirroring the teacher sidebar with its icons: the
 * day's activities, the courses (the home), the poll launcher in the middle
 * (a navigation slot, never "New poll": the launcher's own primary is the
 * screen's one accent fill), the "right now" classrooms, the profile.
 * Pools are reached from a course; Administration from the profile.
 */
export const TEACHER_SLOTS: readonly BottomSlot<TeacherSlotId>[] = [
  { id: "activities", route: { view: "activities" }, icon: CalendarRange, label: "nav.activities" },
  { id: "courses", route: { view: "home" }, icon: Library, label: "nav.courses" },
  { id: "polls", route: { view: "polls" }, icon: Vote, label: "poll.nav" },
  { id: "classrooms", route: { view: "classrooms" }, icon: School, label: "classrooms.title" },
  { id: "profile", route: { view: "settings" }, icon: UserRound, label: "bnav.profile" },
];

/**
 * The slots drawn. The teacher's five always; the student's Drill only for a
 * student with at least one classroom whose drill is on (ADR-041 §6) — a slot
 * leading to "your teacher has not turned this on" is a slot for nothing.
 */
export function visibleSlots(teacherUi: boolean, drill: boolean): readonly BottomSlot[] {
  if (teacherUi) return TEACHER_SLOTS;
  return drill ? STUDENT_SLOTS : STUDENT_SLOTS.filter((s) => s.id !== "drill");
}

/**
 * The rows of the student's desktop sidebar (`Shell`'s `Nav`): the bar's
 * slots in the bar's order, minus Profile, which is the account menu's at the
 * foot of the sidebar (D07, 2026-10-01). The lit row is the bar's: the route
 * table's `bottomSlot` (`bottomSlotOf`). The teacher's sidebar keeps its own
 * rows (its trees, Pools, Administration).
 */
export function sidebarSlots(drill: boolean): readonly BottomSlot[] {
  return visibleSlots(false, drill).filter((s) => s.id !== "profile");
}

/**
 * The home's name and icon, as the first row of the sidebar shows them: a
 * teacher's Courses, a student's Activities (their first slot). The palette
 * and the placeholder pages name the home this way too.
 */
export function homeLook(teacherUi: boolean): Pick<BottomSlot, "icon" | "label"> {
  return visibleSlots(teacherUi, false).find((s) => s.route.view === "home")!;
}

/** The bar is drawn on the views the route table gives a slot in the UI on screen. */
export function bottomNavShown(route: Route, teacherUi: boolean): boolean {
  return bottomSlotOf(route, teacherUi) !== null;
}
