import { describe, expect, it } from "vitest";

import { bottomSlotOf, parsePath } from "../router";
import { bottomNavShown, sidebarSlots, visibleSlots } from "./bottomNavSlots";

describe("bottomNavShown (#191)", () => {
  it("draws the bar for the student on the pages its slots lead to", () => {
    for (const path of ["/", "/settings", "/grades", "/attempts/a1/feedback"]) {
      expect(bottomNavShown(parsePath(path), false)).toBe(true);
    }
  });

  it("never draws it in the teacher UI", () => {
    for (const path of ["/", "/settings", "/activities", "/classrooms/c1"]) {
      expect(bottomNavShown(parsePath(path), true)).toBe(false);
    }
  });

  it("hides it on a view the route table gives no slot, the attempt first", () => {
    expect(bottomNavShown(parsePath("/take/e1"), false)).toBe(false);
  });
});

describe("the lit slot (#191)", () => {
  it("lights Activities on the home, whatever its address carries", () => {
    expect(bottomSlotOf(parsePath("/"))).toBe("activities");
  });

  it("leads Courses to the student's classrooms, and lights it on a classroom's page (D07) and a project's (M3-13)", () => {
    for (const path of ["/courses", "/classrooms/c1", "/projects/p1"]) {
      expect(bottomSlotOf(parsePath(path))).toBe("courses");
      expect(bottomNavShown(parsePath(path), false)).toBe(true);
    }
  });

  it("lights Grades on the Grades page and on a feedback page, Profile on the settings", () => {
    expect(bottomSlotOf(parsePath("/grades"))).toBe("grades");
    expect(bottomSlotOf({ view: "feedback", attemptId: "a1" })).toBe("grades");
    expect(bottomSlotOf({ view: "settings" })).toBe("profile");
  });

  it("lights nothing on a page the bar does not lead to", () => {
    expect(bottomSlotOf({ view: "attempt", evaluationId: "e1" })).toBeNull();
  });

  it("lights Drill on the drill page (#317)", () => {
    expect(bottomSlotOf(parsePath("/drill"))).toBe("drill");
    expect(bottomNavShown(parsePath("/drill"), false)).toBe(true);
  });
});

describe("visibleSlots (#317)", () => {
  it("puts Drill in the middle when the student has a classroom with the drill on", () => {
    expect(visibleSlots(true).map((s) => s.id)).toEqual([
      "activities",
      "courses",
      "drill",
      "grades",
      "profile",
    ]);
  });

  it("leaves it out otherwise", () => {
    expect(visibleSlots(false).map((s) => s.id)).toEqual([
      "activities",
      "courses",
      "grades",
      "profile",
    ]);
  });

  it("leads every slot to a page of its own, Grades to /grades", () => {
    expect(visibleSlots(true).find((s) => s.id === "grades")?.route).toEqual({ view: "studentGrades" });
  });
});

describe("sidebarSlots (D07, 2026-10-01)", () => {
  it("gives the student's sidebar the bar's slots in its order, minus Profile", () => {
    expect(sidebarSlots(true).map((s) => s.id)).toEqual(["activities", "courses", "drill", "grades"]);
    expect(sidebarSlots(false).map((s) => s.id)).toEqual(["activities", "courses", "grades"]);
  });
});
