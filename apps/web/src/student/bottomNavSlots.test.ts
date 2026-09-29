import { describe, expect, it } from "vitest";

import { parsePath, type Route } from "../router";
import { activeSlot, BOTTOM_SLOTS, bottomNavShown } from "./bottomNavSlots";

/** One route per view, from its path, so the whole table is walked. */
const SAMPLE: Record<string, string> = {
  home: "/",
  settings: "/settings",
  feedback: "/attempts/a1/feedback",
  attempt: "/take/e1",
  join: "/p/ABCD12",
  poll: "/evaluations/e1/poll",
  correction: "/evaluations/e1/correction",
  evaluationPreview: "/evaluations/e1/preview",
  questionPreview: "/questions/q1/preview",
  oauthConsent: "/oauth/authorize/r1",
  teamsLink: "/teams/link",
  teamsTab: "/teams",
};

describe("bottomNavShown (#191)", () => {
  it("draws the bar for the student on the pages its slots lead to", () => {
    for (const path of ["/", "/settings", "/attempts/a1/feedback"]) {
      expect(bottomNavShown(parsePath(path), false)).toBe(true);
    }
  });

  it("never draws it in the teacher UI, whatever the page", () => {
    for (const path of [...Object.values(SAMPLE), "/activities", "/pools", "/classrooms/c1"]) {
      expect(bottomNavShown(parsePath(path), true)).toBe(false);
    }
  });

  it("hides it on the attempt, the poll join page, the projections and the previews", () => {
    for (const view of [
      "attempt",
      "join",
      "poll",
      "correction",
      "evaluationPreview",
      "questionPreview",
      "oauthConsent",
      "teamsLink",
      "teamsTab",
    ]) {
      const route = parsePath(SAMPLE[view]!);
      expect(route.view).toBe(view);
      expect(bottomNavShown(route, false)).toBe(false);
    }
  });
});

describe("activeSlot (#191)", () => {
  const home: Route = { view: "home" };

  it("lights Activities on the home, and the section the address names", () => {
    expect(activeSlot(home, "")).toBe("activities");
    expect(activeSlot(home, "#classrooms")).toBe("courses");
    expect(activeSlot(home, "#past")).toBe("grades");
    expect(activeSlot(home, "#elsewhere")).toBe("activities");
  });

  it("keeps Grades lit on a feedback page and Profile on the settings", () => {
    expect(activeSlot({ view: "feedback", attemptId: "a1" }, "")).toBe("grades");
    expect(activeSlot({ view: "settings" }, "#past")).toBe("profile");
  });

  it("lights nothing on a page the bar does not lead to", () => {
    expect(activeSlot({ view: "attempt", evaluationId: "e1" }, "")).toBeNull();
  });

  it("ships four slots, Drill (#317) to come in the middle", () => {
    expect(BOTTOM_SLOTS.map((s) => s.id)).toEqual(["activities", "courses", "grades", "profile"]);
  });
});
