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

  /*
   * The question the grading screen opens on, and the editor's way back to
   * it (ADR-044, addendum), travel in the query string: the path parses to
   * the same screen, the query keeps the rest across a reload.
   */
  it("carries the question of the grading screen, and the editor's way back to it", () => {
    const grading = new URL(
      routeToPath({ view: "grading", evaluationId: "e1", item: "i2" }),
      "http://quiz.test",
    );
    expect(grading.pathname + grading.search).toBe("/evaluations/e1/grading?item=i2");
    expect(parsePath(grading.pathname)).toEqual({ view: "grading", evaluationId: "e1" });

    const editor = new URL(
      routeToPath({ view: "question", id: "q1", fromGrading: "e1", item: "i2" }),
      "http://quiz.test",
    );
    expect(editor.pathname).toBe("/questions/q1");
    expect(editor.searchParams.get("fromGrading")).toBe("e1");
    expect(editor.searchParams.get("item")).toBe("i2");
    expect(parsePath(editor.pathname)).toEqual({ view: "question", id: "q1" });
  });

  /*
   * The tails of `/evaluations/:id/…` are parsed in ONE place (router.ts), and
   * `evaluation` — WP8's configuration screen — is the fallback, so a path
   * with no tail, or an unknown one, lands there rather than on the home.
   */
  it("falls back to the configuration screen, never past the evaluation", () => {
    expect(parsePath("/evaluations/e1")).toEqual({ view: "evaluation", id: "e1" });
    expect(parsePath("/evaluations/e1/nope")).toEqual({ view: "evaluation", id: "e1" });
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
