import { describe, expect, it } from "vitest";

import { bottomNavShown, homeLook, sidebarSlots, visibleSlots } from "./bottomNavSlots";
import { bottomSlotOf, parsePath, ROUTE_VIEWS, ROUTES, type Route } from "./router";

/**
 * The views with no teacher bar (#449), each for a reason: a new route must
 * either light a slot of the teacher's bar or join this list.
 */
const TEACHER_HIDDEN: readonly Route["view"][] = [
  // The teacher's full-screen working surfaces.
  "live",
  "question",
  "evaluation", // its last step is the launch dock
  "grading",
  // Drawn on the whole screen, outside the frame (App.tsx's FULL_SCREEN).
  "questionPreview",
  "evaluationPreview",
  "poll",
  "correction",
  "attempt",
  "join",
  "oauthConsent",
  "teamsLink",
  "pair",
  // Drawn with no session or no frame at all.
  "teamsTab",
  "kiosk",
  "sebQuit",
  "discover",
  // Student pages a teacher's UI never shows as such, and the dev gallery.
  "drill",
  "feedback",
  "devUi",
];

describe("bottomNavShown (#191)", () => {
  it("draws the bar for the student on the pages its slots lead to", () => {
    for (const path of ["/", "/settings", "/grades", "/attempts/a1/feedback"]) {
      expect(bottomNavShown(parsePath(path), false)).toBe(true);
    }
  });

  it("hides it on a view the route table gives no slot, the attempt first", () => {
    expect(bottomNavShown(parsePath("/take/e1"), false)).toBe(false);
  });
});

describe("the lit slot (#191)", () => {
  it("lights Activities on the home, whatever its address carries", () => {
    expect(bottomSlotOf(parsePath("/"), false)).toBe("activities");
  });

  it("leads Courses to the student's classrooms, and lights it on a classroom's page (D07) and a project's (M3-13)", () => {
    for (const path of ["/courses", "/classrooms/c1", "/classrooms/c1/groups", "/projects/p1"]) {
      expect(bottomSlotOf(parsePath(path), false)).toBe("courses");
      expect(bottomNavShown(parsePath(path), false)).toBe(true);
    }
  });

  it("lights Grades on the Grades page and on a feedback page, Profile on the settings", () => {
    expect(bottomSlotOf(parsePath("/grades"), false)).toBe("grades");
    expect(bottomSlotOf({ view: "feedback", attemptId: "a1" }, false)).toBe("grades");
    expect(bottomSlotOf({ view: "settings" }, false)).toBe("profile");
  });

  it("lights nothing on a page the bar does not lead to", () => {
    expect(bottomSlotOf({ view: "attempt", evaluationId: "e1" }, false)).toBeNull();
  });

  it("lights Drill on the drill page (#317)", () => {
    expect(bottomSlotOf(parsePath("/drill"), false)).toBe("drill");
    expect(bottomNavShown(parsePath("/drill"), false)).toBe(true);
  });
});

describe("the teacher's bar (#449)", () => {
  it("lights each slot on the pages it leads to, and on the pages reached from them", () => {
    const lit: [string, string][] = [
      ["/activities", "activities"],
      ["/projects/p1", "activities"],
      ["/evaluations/e1/results", "activities"],
      ["/", "courses"],
      ["/courses/k1", "courses"],
      ["/templates/t1", "courses"],
      // Pools have no slot of their own: a teacher reaches them from a course.
      ["/pools", "courses"],
      ["/pools/p1", "courses"],
      ["/polls", "polls"],
      ["/evaluations/e1/moderate", "polls"],
      ["/classrooms", "classrooms"],
      ["/classrooms/c1", "classrooms"],
      ["/classrooms/c1/journal", "classrooms"],
      ["/classrooms/c1/settings", "classrooms"],
      ["/settings", "profile"],
      // Administration is a row of the profile on a phone.
      ["/admin", "profile"],
    ];
    for (const [path, slot] of lit) expect([path, bottomSlotOf(parsePath(path), true)]).toEqual([path, slot]);
  });

  it("makes every view choose: lit for the teacher, or on the one list of views without the bar", () => {
    const unlit = ROUTE_VIEWS.filter((view) => !ROUTES[view].bottomSlot?.teacher).sort();
    expect(unlit).toEqual([...TEACHER_HIDDEN].sort());
  });

  it("draws its five slots, Polls in the middle, whatever the drill", () => {
    for (const drill of [true, false]) {
      expect(visibleSlots(true, drill).map((s) => s.id)).toEqual([
        "activities",
        "courses",
        "polls",
        "classrooms",
        "profile",
      ]);
    }
    expect(visibleSlots(true, false).find((s) => s.id === "courses")?.route).toEqual({ view: "home" });
  });

  it("names the home the way each UI's sidebar does", () => {
    expect(homeLook(true).label).toBe("nav.courses");
    expect(homeLook(false).label).toBe("nav.activities");
  });
});

describe("visibleSlots (#317)", () => {
  it("puts Drill in the middle when the student has a classroom with the drill on", () => {
    expect(visibleSlots(false, true).map((s) => s.id)).toEqual([
      "activities",
      "courses",
      "drill",
      "grades",
      "profile",
    ]);
  });

  it("leaves it out otherwise", () => {
    expect(visibleSlots(false, false).map((s) => s.id)).toEqual([
      "activities",
      "courses",
      "grades",
      "profile",
    ]);
  });

  it("leads every slot to a page of its own, Grades to /grades", () => {
    expect(visibleSlots(false, true).find((s) => s.id === "grades")?.route).toEqual({ view: "studentGrades" });
  });
});

describe("sidebarSlots (D07, 2026-10-01)", () => {
  it("gives the student's sidebar the bar's slots in its order, minus Profile", () => {
    expect(sidebarSlots(true).map((s) => s.id)).toEqual(["activities", "courses", "drill", "grades"]);
    expect(sidebarSlots(false).map((s) => s.id)).toEqual(["activities", "courses", "grades"]);
  });
});
