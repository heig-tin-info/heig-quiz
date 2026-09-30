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
    { view: "course", id: "k-1" },
    { view: "template", id: "t-1" },
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
    { view: "drill" },
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
    // The student's Courses is a route under `CLASSROOM_PAGES` only
    // (router.classroomPages.test.ts); off, `/courses` is still the home.
    expect(parsePath("/courses")).toEqual({ view: "home" });
  });

  it("parses none of the classroom merge's routes while CLASSROOM_PAGES is off", () => {
    // A production build: every such address reads as it did before them.
    expect(parsePath("/classrooms/c-1/settings")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/classrooms/c-1/journal/a.md")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/classrooms/c-1/grades")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/projects/p-1")).toEqual({ view: "home" });
    expect(parsePath("/projects/p-1/groups")).toEqual({ view: "home" });
    expect(ROUTES.classroom.studentSafe).toBe(false);
  });

  it("parses the page of one course, a page of the Courses section (F-ORG-12)", () => {
    expect(routeToPath({ view: "course", id: "k-1" })).toBe("/courses/k-1");
    expect(parsePath("/courses/k-1")).toEqual({ view: "course", id: "k-1" });
    expect(sectionOf({ view: "course", id: "k-1" })).toBe("home");
  });

  it("parses the editor of one template, a page of its course (F-EVAL-25)", () => {
    expect(routeToPath({ view: "template", id: "t-1" })).toBe("/templates/t-1");
    expect(parsePath("/templates/t-1")).toEqual({ view: "template", id: "t-1" });
    expect(parsePath("/templates")).toEqual({ view: "home" });
    expect(sectionOf({ view: "template", id: "t-1" })).toBe("home");
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
    // The evaluation the editor was opened from travels in the query string
    // (#127): the editor reads it there, the path stays the editor's.
    expect(routeToPath({ view: "question", id: "q-1", from: "e-1" })).toBe("/questions/q-1?from=e-1");
    expect(routeToPath({ view: "question", id: "q-1", fromTemplate: "t-1" })).toBe(
      "/questions/q-1?fromTemplate=t-1",
    );
    expect(parsePath("/questions/q-1")).toEqual({ view: "question", id: "q-1" });
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
      { view: "evaluationPreview", id: "e-1" },
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
    course: { view: "course", id: "k-1" },
    template: { view: "template", id: "t-1" },
    classroom: { view: "classroom", id: "c-1" },
    studentCourses: { view: "studentCourses" },
    classroomSettings: { view: "classroomSettings", id: "c-1" },
    classroomJournal: { view: "classroomJournal", id: "c-1", path: "10-semaine-1/10-pointeurs.md" },
    classroomGrades: { view: "classroomGrades", id: "c-1" },
    project: { view: "project", id: "p-1" },
    projectGroups: { view: "projectGroups", id: "p-1" },
    activities: { view: "activities" },
    pools: { view: "pools" },
    poolCategories: { view: "poolCategories", id: "p-1" },
    pool: { view: "pool", id: "p-1" },
    polls: { view: "polls" },
    question: { view: "question", id: "q-1" },
    questionPreview: { view: "questionPreview", id: "q-1" },
    attempt: { view: "attempt", evaluationId: "e-1" },
    join: { view: "join", code: "ABC123" },
    oauthConsent: { view: "oauthConsent", id: "0190d3c4-0000-7000-8000-000000000001" },
    teamsLink: { view: "teamsLink" },
    teamsTab: { view: "teamsTab" },
    feedback: { view: "feedback", attemptId: "a-1" },
    drill: { view: "drill" },
    live: { view: "live", id: "e-1" },
    evaluationPreview: { view: "evaluationPreview", id: "e-1" },
    poll: { view: "poll", id: "e-1" },
    grading: { view: "grading", evaluationId: "e-1" },
    results: { view: "results", evaluationId: "e-1" },
    correction: { view: "correction", evaluationId: "e-1" },
    evaluation: { view: "evaluation", id: "e-1" },
    devUi: { view: "devUi" },
  };

  it("has exactly one entry per member of the Route union", () => {
    expect([...ROUTE_VIEWS].sort()).toEqual(Object.keys(sample).sort());
    for (const view of ROUTE_VIEWS) expect(ROUTES[view]).toBeDefined();
  });

  it("round-trips a sample of every view, the table's order included", () => {
    // The merge's previews round-trip in router.classroomPages.test.ts, flag on.
    for (const r of Object.values(sample).filter((r) => !ROUTES[r.view].preview)) {
      expect(parsePath(routeToPath(r))).toEqual(r);
    }
  });

  it("marks the views a student has a screen for, and only them", () => {
    expect(ROUTE_VIEWS.filter((v) => ROUTES[v].studentSafe).sort()).toEqual([
      "attempt",
      // The merge's student pages, reachable only under `CLASSROOM_PAGES`.
      "classroomGrades",
      "classroomJournal",
      "drill",
      "feedback",
      "home",
      "join",
      "oauthConsent",
      "settings",
      "studentCourses",
      "teamsLink",
      "teamsTab",
    ]);
  });

  it("lights the sidebar section of each view, and none for the others", () => {
    const lit = Object.fromEntries(
      Object.values(sample).map((r) => [r.view, sectionOf(r)] as const),
    );
    expect(lit).toMatchObject({
      home: "home",
      course: "home",
      template: "home",
      activities: "activities",
      pools: "pools",
      pool: "pools",
      question: "pools",
      polls: "polls",
      poll: "polls",
      admin: "admin",
      drill: "drill",
      studentCourses: "home",
      project: "activities",
      projectGroups: "activities",
    });
    const unlit = ROUTE_VIEWS.filter((v) => lit[v] === null).sort();
    expect(unlit).toEqual(
      [
        "attempt",
        "classroom",
        "classroomGrades",
        "classroomJournal",
        "classroomSettings",
        "correction",
        "devUi",
        "evaluation",
        "evaluationPreview",
        "feedback",
        "grading",
        "join",
        "live",
        "oauthConsent",
        "questionPreview",
        "results",
        "settings",
        "teamsLink",
        "teamsTab",
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
