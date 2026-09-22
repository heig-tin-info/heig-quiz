import { afterEach, describe, expect, it } from "vitest";

import {
  enterStudentView,
  leaveStudentView,
  studentRouteFor,
  studentViewOn,
  studentViewReturn,
} from "./studentView";

/*
 * ADR-018: the student view remembers where it was entered from. The banner
 * used to send everybody to the teacher home, which is the wrong answer for
 * the walk this exists for — a teacher who came from an evaluation wants that
 * evaluation back.
 *
 * Its 2026-09-22 addendum: the view is a property of the WINDOW, so the store
 * is `sessionStorage` and one tab's student view never reaches another.
 */

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("the student view store", () => {
  it("is off, and returns home, before anything happens", () => {
    expect(studentViewOn()).toBe(false);
    expect(studentViewReturn()).toEqual({ view: "home" });
  });

  it("remembers the page it was entered from, across a reload", () => {
    enterStudentView({ view: "evaluation", id: "e1" });
    expect(studentViewOn()).toBe(true);
    // Storage IS the state, so this is what survives a page reload OF THIS TAB.
    expect(sessionStorage.getItem("quiz-view-as")).toBe("student");
    expect(studentViewReturn()).toEqual({ view: "evaluation", id: "e1" });
  });

  it("stays inside its own tab", () => {
    enterStudentView({ view: "live", id: "e1" });
    // Nothing in `localStorage`: the live dashboard open in another tab must
    // not be dragged into the student UI by this one.
    expect(localStorage.getItem("quiz-view-as")).toBeNull();
    expect(localStorage.getItem("quiz-view-as-return")).toBeNull();
  });

  it("hands the way back to the caller and forgets it", () => {
    enterStudentView({ view: "live", id: "e1" });
    expect(leaveStudentView()).toEqual({ view: "live", id: "e1" });
    expect(studentViewOn()).toBe(false);
    expect(studentViewReturn()).toEqual({ view: "home" });
  });

  it("falls back to the teacher home when it was entered with no origin", () => {
    sessionStorage.setItem("quiz-view-as", "student");
    expect(studentViewOn()).toBe(true);
    expect(leaveStudentView()).toEqual({ view: "home" });
  });
});

describe("where the switch lands", () => {
  it("sends the two evaluation screens to that evaluation's own student route", () => {
    expect(studentRouteFor({ view: "evaluation", id: "e1" })).toEqual({
      view: "attempt",
      evaluationId: "e1",
    });
    // The point of the whole change: launched from the live dashboard, the
    // teacher joins the quiz they just started.
    expect(studentRouteFor({ view: "live", id: "e1" })).toEqual({
      view: "attempt",
      evaluationId: "e1",
    });
  });

  it("stays put on a page that is already a student page", () => {
    expect(studentRouteFor({ view: "settings" })).toEqual({ view: "settings" });
    expect(studentRouteFor({ view: "feedback", attemptId: "a1" })).toEqual({
      view: "feedback",
      attemptId: "a1",
    });
  });

  it("lands on the student home from anywhere else", () => {
    // A grading panel and a results table have no student twin that can be
    // named without the reader's own attempt id.
    expect(studentRouteFor({ view: "grading", evaluationId: "e1" })).toEqual({ view: "home" });
    expect(studentRouteFor({ view: "results", evaluationId: "e1" })).toEqual({ view: "home" });
    expect(studentRouteFor({ view: "pool", id: "p1" })).toEqual({ view: "home" });
    expect(studentRouteFor({ view: "classroom", id: "c1" })).toEqual({ view: "home" });
  });
});
