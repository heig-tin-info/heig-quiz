import type { Route } from "../router";

/**
 * The student's bottom navigation bar on a phone (#191): which slots it has,
 * where each one leads, when the bar is drawn and which slot is lit. Pure, so
 * the rules are tested without a layout; `BottomNav.tsx` draws them.
 *
 * The student has one page of work, the home, and it already answers the
 * questions the slots ask: "Open now" (Activities), "My classrooms"
 * (Courses) and "Past evaluations", whose results open the feedback page
 * (Grades). So two slots lead to a SECTION of the home — an anchor, not a
 * page of their own — and the fourth is the settings page.
 */

export type BottomSlotId = "activities" | "courses" | "grades" | "profile";

export interface BottomSlot {
  id: BottomSlotId;
  route: Route;
  /** The `id` of the section of the student home the slot scrolls to. */
  anchor?: string;
}

/** The anchors of the student home's sections, written once for both sides. */
export const HOME_SECTION = { courses: "classrooms", grades: "past" } as const;

/**
 * In the order they are drawn. Drill (#317) takes the MIDDLE when it lands,
 * between Courses and Grades: the slots share the width equally, so a fifth
 * one is an entry here and nothing else.
 */
export const BOTTOM_SLOTS: readonly BottomSlot[] = [
  { id: "activities", route: { view: "home" } },
  { id: "courses", route: { view: "home" }, anchor: HOME_SECTION.courses },
  { id: "grades", route: { view: "home" }, anchor: HOME_SECTION.grades },
  { id: "profile", route: { view: "settings" } },
];

/**
 * The views that carry the bar: the pages its slots lead to, and nothing
 * else. An allowlist on purpose: the attempt (lobby and player), the poll
 * join page, a projection, a preview and a SEB-confined page must never get
 * it, nor any screen with a sticky bottom bar of its own, and a view added
 * tomorrow is one of those more often than not.
 */
const BAR_VIEWS: ReadonlySet<Route["view"]> = new Set(["home", "feedback", "settings"]);

/**
 * Whether the frame draws the bar: the student UI only (a student, or a
 * teacher in student view, who is looking at exactly what a student gets).
 * The teacher UI is desktop first and keeps its top bar and drawer. The
 * phone-only part is CSS (`lg:hidden`), the breakpoint of the frame's own
 * sidebar.
 */
export function bottomNavShown(route: Route, teacherUi: boolean): boolean {
  return !teacherUi && BAR_VIEWS.has(route.view);
}

/**
 * The slot lit for `route`, `hash` being the address bar's (`#past`, …). The
 * feedback page is a grade, so Grades stays lit while it is read, as the
 * sidebar's row stays lit on the pages of its section.
 */
export function activeSlot(route: Route, hash: string): BottomSlotId | null {
  switch (route.view) {
    case "settings":
      return "profile";
    case "feedback":
      return "grades";
    case "home":
      return BOTTOM_SLOTS.find((s) => s.anchor !== undefined && `#${s.anchor}` === hash)?.id ?? "activities";
    default:
      return null;
  }
}
