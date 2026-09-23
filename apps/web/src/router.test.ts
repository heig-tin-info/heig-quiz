import { describe, expect, it } from "vitest";

import {
  evaluationInView,
  parsePath,
  ROUTE_VIEWS,
  ROUTES,
  routeToPath,
  sectionOf,
  type Route,
  type RouteOf,
} from "./router";

describe("routeToPath / parsePath", () => {
  const routes: Route[] = [
    { view: "home" },
    { view: "settings" },
    { view: "admin" },
    { view: "classroom", id: "c-1" },
    { view: "pools" },
    { view: "pool", id: "p-1" },
    { view: "poolCategories", id: "p-1" },
    { view: "question", id: "q-1" },
    { view: "questionPreview", id: "q-1" },
    // WP9: student player
    { view: "attempt", evaluationId: "e-1" },
    // WP10 replaced WP9's `/results/:id` with the one feedback route.
    { view: "feedback", attemptId: "a-1" },
    { view: "devUi" },
  ];

  it("round-trips every route", () => {
    for (const r of routes) {
      expect(parsePath(routeToPath(r))).toEqual(r);
    }
  });

  it("falls back to home on unknown or partial paths", () => {
    expect(parsePath("/")).toEqual({ view: "home" });
    expect(parsePath("/nope")).toEqual({ view: "home" });
    expect(parsePath("/classrooms")).toEqual({ view: "home" });
  });

  it("parses the pool routes, and /pools alone is the list", () => {
    expect(parsePath("/pools")).toEqual({ view: "pools" });
    expect(parsePath("/pools/p-1")).toEqual({ view: "pool", id: "p-1" });
    expect(parsePath("/pools/p-1/categories")).toEqual({ view: "poolCategories", id: "p-1" });
    expect(sectionOf({ view: "poolCategories", id: "p-1" })).toBe("pools");
    expect(parsePath("/questions/q-1")).toEqual({ view: "question", id: "q-1" });
    // The editor tab lives in the query string, not in the path.
    expect(parsePath("/questions/q-1/edit")).toEqual({ view: "question", id: "q-1" });
    expect(parsePath("/questions")).toEqual({ view: "home" });
    // The one tail that is a page of its own: the student preview the editor
    // opens in a new tab (docs/spec/08 §8.2).
    expect(parsePath("/questions/q-1/preview")).toEqual({
      view: "questionPreview",
      id: "q-1",
    });
    expect(routeToPath({ view: "questionPreview", id: "q-1" })).toBe("/questions/q-1/preview");
  });

  it("parses the development gallery; App.tsx is what refuses it in production", () => {
    expect(parsePath("/dev/ui")).toEqual({ view: "devUi" });
    expect(parsePath("/dev")).toEqual({ view: "home" });
  });

  // WP9: student player — WP10 owns the results half (one route, below).
  it("parses the two student paths", () => {
    expect(parsePath("/take/e-1")).toEqual({ view: "attempt", evaluationId: "e-1" });
    expect(parsePath("/attempts/a-1/feedback")).toEqual({ view: "feedback", attemptId: "a-1" });
    expect(routeToPath({ view: "attempt", evaluationId: "e-1" })).toBe("/take/e-1");
    expect(routeToPath({ view: "feedback", attemptId: "a-1" })).toBe("/attempts/a-1/feedback");
  });

  // WP9: student player
  it("falls back to home when a student path has no id", () => {
    expect(parsePath("/take")).toEqual({ view: "home" });
    expect(parsePath("/attempts")).toEqual({ view: "home" });
    // WP9's own `/results/:id` is gone: one feedback page, one route.
    expect(parsePath("/results/a-1")).toEqual({ view: "home" });
  });

  it("ignores anything past the classroom id", () => {
    expect(parsePath("/classrooms/c-1/whatever")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/classrooms/c-1/")).toEqual({ view: "classroom", id: "c-1" });
  });

  // WP8: evaluation + dashboard
  it("parses the configuration screen and the live dashboard", () => {
    expect(parsePath("/evaluations/e-1")).toEqual({ view: "evaluation", id: "e-1" });
    expect(parsePath("/evaluations/e-1/live")).toEqual({ view: "live", id: "e-1" });
  });

  it("round-trips both evaluation routes", () => {
    for (const r of [
      { view: "evaluation", id: "e-1" },
      { view: "live", id: "e-1" },
    ] as const) {
      expect(parsePath(routeToPath(r))).toEqual(r);
    }
  });

  it("falls back to the configuration screen for an unknown sub-path", () => {
    expect(parsePath("/evaluations/e-1/nope")).toEqual({ view: "evaluation", id: "e-1" });
    expect(parsePath("/evaluations")).toEqual({ view: "home" });
  });
});

describe("ROUTES", () => {
  // One sample per member of the union. The mapped type makes this object
  // itself exhaustive: a view added to `Route` and not here fails to compile,
  // exactly as a view missing from `ROUTES` does.
  const sample: { [V in Route["view"]]: RouteOf<V> } = {
    home: { view: "home" },
    settings: { view: "settings" },
    admin: { view: "admin" },
    classroom: { view: "classroom", id: "c-1" },
    pools: { view: "pools" },
    poolCategories: { view: "poolCategories", id: "p-1" },
    pool: { view: "pool", id: "p-1" },
    polls: { view: "polls" },
    question: { view: "question", id: "q-1" },
    questionPreview: { view: "questionPreview", id: "q-1" },
    attempt: { view: "attempt", evaluationId: "e-1" },
    join: { view: "join", code: "ABC123" },
    feedback: { view: "feedback", attemptId: "a-1" },
    live: { view: "live", id: "e-1" },
    poll: { view: "poll", id: "e-1" },
    grading: { view: "grading", evaluationId: "e-1" },
    results: { view: "results", evaluationId: "e-1" },
    evaluation: { view: "evaluation", id: "e-1" },
    devUi: { view: "devUi" },
  };

  it("has exactly one entry per member of the Route union", () => {
    expect([...ROUTE_VIEWS].sort()).toEqual(Object.keys(sample).sort());
    for (const view of ROUTE_VIEWS) expect(ROUTES[view]).toBeDefined();
  });

  it("round-trips a sample of every view, the table's order included", () => {
    for (const r of Object.values(sample)) {
      expect(parsePath(routeToPath(r))).toEqual(r);
    }
  });

  it("marks the five views a student has a screen for, and only them", () => {
    expect(ROUTE_VIEWS.filter((v) => ROUTES[v].studentSafe).sort()).toEqual([
      "attempt",
      "feedback",
      "home",
      "join",
      "settings",
    ]);
  });

  it("lights the sidebar section of each view, and none for the others", () => {
    const lit = Object.fromEntries(
      Object.values(sample).map((r) => [r.view, sectionOf(r)] as const),
    );
    expect(lit).toMatchObject({
      home: "home",
      pools: "pools",
      pool: "pools",
      question: "pools",
      polls: "polls",
      poll: "polls",
      admin: "admin",
    });
    const unlit = ROUTE_VIEWS.filter((v) => lit[v] === null).sort();
    expect(unlit).toEqual(
      [
        "attempt",
        "classroom",
        "devUi",
        "evaluation",
        "feedback",
        "grading",
        "join",
        "live",
        "questionPreview",
        "results",
        "settings",
      ].sort(),
    );
  });

  it("names the evaluation of its four linked teacher screens, and of nothing else", () => {
    const withEvaluation = Object.values(sample)
      .filter((r) => evaluationInView(r) !== null)
      .map((r) => [r.view, evaluationInView(r)]);
    expect(withEvaluation).toEqual([
      ["live", "e-1"],
      ["grading", "e-1"],
      ["results", "e-1"],
      ["evaluation", "e-1"],
    ]);
  });
});
