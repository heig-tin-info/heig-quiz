import { describe, expect, it } from "vitest";

import { parsePath, type Route } from "../router";
import { activeSlot, bottomNavShown, sidebarSlots, visibleSlots } from "./bottomNavSlots";

describe("bottomNavShown (#191)", () => {
  it("draws the bar for the student on the pages its slots lead to", () => {
    for (const path of ["/", "/settings", "/attempts/a1/feedback"]) {
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

describe("activeSlot (#191)", () => {
  const home: Route = { view: "home" };

  it("lights Activities on the home, and the section the address names", () => {
    expect(activeSlot(home, "")).toBe("activities");
    expect(activeSlot(home, "#past")).toBe("grades");
    expect(activeSlot(home, "#elsewhere")).toBe("activities");
    // No longer an anchor of the home (D07): Courses is a page.
    expect(activeSlot(home, "#classrooms")).toBe("activities");
  });

  it("leads Courses to the student's classrooms, and lights it on a classroom's page (D07)", () => {
    for (const path of ["/courses", "/classrooms/c1"]) {
      expect(activeSlot(parsePath(path), "")).toBe("courses");
      expect(bottomNavShown(parsePath(path), false)).toBe(true);
    }
  });

  it("keeps Grades lit on a feedback page and Profile on the settings", () => {
    expect(activeSlot({ view: "feedback", attemptId: "a1" }, "")).toBe("grades");
    expect(activeSlot({ view: "settings" }, "#past")).toBe("profile");
  });

  it("lights nothing on a page the bar does not lead to", () => {
    expect(activeSlot({ view: "attempt", evaluationId: "e1" }, "")).toBeNull();
  });

  it("lights Drill on the drill page (#317)", () => {
    expect(activeSlot(parsePath("/drill"), "")).toBe("drill");
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
});

describe("sidebarSlots (D07, 2026-10-01)", () => {
  it("gives the student's sidebar the bar's slots in its order, minus Profile", () => {
    expect(sidebarSlots(true).map((s) => s.id)).toEqual(["activities", "courses", "drill", "grades"]);
    expect(sidebarSlots(false).map((s) => s.id)).toEqual(["activities", "courses", "grades"]);
  });

  it("leads Grades to the home's Grades section, as the bar does", () => {
    const grades = sidebarSlots(false).find((s) => s.id === "grades");
    expect(grades).toBe(visibleSlots(false).find((s) => s.id === "grades"));
    expect(grades?.anchor).toBe("past");
  });

  it("lights Courses on every page of a classroom a student reads", () => {
    const pages: Route[] = [
      { view: "classroom", id: "c1" },
      { view: "classroomJournal", id: "c1" },
      { view: "classroomGrades", id: "c1" },
    ];
    for (const route of pages) expect(activeSlot(route, "")).toBe("courses");
  });
});
