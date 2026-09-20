import { routeToPath, type Route } from "../router";

/**
 * The two teacher destinations of a closed evaluation, as routes and as
 * paths (WP10).
 *
 * It lives here, and holds nothing but `router.ts`, so the evaluation card
 * — which belongs to another work package — can link to the grading panel
 * and to the results without importing a screen, and without the panel's
 * chunk landing in whatever page draws that card.
 */
export interface GradingLinks {
  grading: Route;
  results: Route;
  gradingPath: string;
  resultsPath: string;
  /** `GET …/results.csv`: a real navigation, cookies and all (F-RES-02). */
  csvPath: string;
}

export function gradingLinks(evaluationId: string): GradingLinks {
  const grading: Route = { view: "grading", evaluationId };
  const results: Route = { view: "results", evaluationId };
  return {
    grading,
    results,
    gradingPath: routeToPath(grading),
    resultsPath: routeToPath(results),
    csvPath: `/app/api/evaluations/${evaluationId}/results.csv`,
  };
}

/** The student's own feedback page for one attempt (F-RES-04). */
export function feedbackLink(attemptId: string): { route: Route; path: string } {
  const route: Route = { view: "feedback", attemptId };
  return { route, path: routeToPath(route) };
}
