import { describe, expect, it } from "vitest";

import { parsePath, routeToPath } from "../router";
import { feedbackLink, gradingLinks } from "./index";

/*
 * The three WP10 destinations, as URLs. They are deep links a teacher pastes
 * in a chat and a student opens from a notification, so the round trip has to
 * hold in both directions.
 */

describe("WP10 routes", () => {
  it("parses the teacher and student paths", () => {
    expect(parsePath("/evaluations/e1/grading")).toEqual({ view: "grading", evaluationId: "e1" });
    expect(parsePath("/evaluations/e1/results")).toEqual({ view: "results", evaluationId: "e1" });
    expect(parsePath("/attempts/a7/feedback")).toEqual({ view: "feedback", attemptId: "a7" });
  });

  it("round-trips every route through its path", () => {
    for (const route of [
      { view: "grading", evaluationId: "e1" } as const,
      { view: "results", evaluationId: "e1" } as const,
      { view: "feedback", attemptId: "a7" } as const,
    ]) {
      expect(parsePath(routeToPath(route))).toEqual(route);
    }
  });

  it("falls back home on an evaluation path with no tail", () => {
    expect(parsePath("/evaluations/e1")).toEqual({ view: "home" });
    expect(parsePath("/attempts/a7")).toEqual({ view: "home" });
  });

  it("hands the evaluation card its two links and the CSV endpoint", () => {
    const links = gradingLinks("e1");
    expect(links.gradingPath).toBe("/evaluations/e1/grading");
    expect(links.resultsPath).toBe("/evaluations/e1/results");
    expect(links.csvPath).toBe("/app/api/evaluations/e1/results.csv");
    expect(feedbackLink("a7").path).toBe("/attempts/a7/feedback");
  });
});
