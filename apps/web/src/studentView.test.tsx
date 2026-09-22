import { afterEach, describe, expect, it } from "vitest";

import { enterStudentView, leaveStudentView, studentViewOn, studentViewReturn } from "./studentView";

/*
 * ADR-018: the student view remembers where it was entered from. The banner
 * used to send everybody to the teacher home, which is the wrong answer for
 * the walk this exists for — a teacher who came from an evaluation wants that
 * evaluation back.
 */

afterEach(() => localStorage.clear());

describe("the student view store", () => {
  it("is off, and returns home, before anything happens", () => {
    expect(studentViewOn()).toBe(false);
    expect(studentViewReturn()).toEqual({ view: "home" });
  });

  it("remembers the page it was entered from, across a reload", () => {
    enterStudentView({ view: "evaluation", id: "e1" });
    expect(studentViewOn()).toBe(true);
    // Storage IS the state, so this is what survives a page reload.
    expect(localStorage.getItem("quiz-view-as")).toBe("student");
    expect(studentViewReturn()).toEqual({ view: "evaluation", id: "e1" });
  });

  it("hands the way back to the caller and forgets it", () => {
    enterStudentView({ view: "live", id: "e1" });
    expect(leaveStudentView()).toEqual({ view: "live", id: "e1" });
    expect(studentViewOn()).toBe(false);
    expect(studentViewReturn()).toEqual({ view: "home" });
  });

  it("falls back to the teacher home when it was entered with no origin", () => {
    localStorage.setItem("quiz-view-as", "student");
    expect(studentViewOn()).toBe(true);
    expect(leaveStudentView()).toEqual({ view: "home" });
  });
});
