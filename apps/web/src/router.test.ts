import { describe, expect, it } from "vitest";

import {
  bottomSlotOf,
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
  });

  it("parses the teacher's \"right now\" classrooms, `/classrooms` alone (#449)", () => {
    expect(parsePath("/classrooms")).toEqual({ view: "classrooms" });
    expect(parsePath("/classrooms/c-1")).toEqual({ view: "classroom", id: "c-1" });
    expect(ROUTES.classrooms.studentSafe).toBe(false);
  });

  it("parses the student's Courses in every build, since M5-02 (F-ORG-14)", () => {
    expect(parsePath("/courses")).toEqual({ view: "studentCourses" });
    expect(routeToPath({ view: "studentCourses" })).toBe("/courses");
  });

  it("parses the student's Grades in every build (F-ORG-14, F-RES-04)", () => {
    expect(parsePath("/grades")).toEqual({ view: "studentGrades" });
    expect(routeToPath({ view: "studentGrades" })).toBe("/grades");
  });

  it("parses the classroom's Settings in every build, since M2-07 (F-ORG-13)", () => {
    expect(parsePath("/classrooms/c-1/settings")).toEqual({ view: "classroomSettings", id: "c-1" });
  });

  it("parses the classroom's journal in every build, since M4-05 (F-JRN-07)", () => {
    expect(parsePath("/classrooms/c-1/journal")).toEqual({ view: "classroomJournal", id: "c-1" });
    expect(parsePath("/classrooms/c-1/journal/10-semaine-1/a.md")).toEqual({
      view: "classroomJournal",
      id: "c-1",
      path: "10-semaine-1/a.md",
    });
  });

  it("parses the classroom's Grades in every build, since M5-04 (F-GBOOK-01, F-GBOOK-05)", () => {
    expect(routeToPath({ view: "classroomGrades", id: "c-1" })).toBe("/classrooms/c-1/grades");
    expect(parsePath("/classrooms/c-1/grades")).toEqual({ view: "classroomGrades", id: "c-1" });
    // One address, two pages, under the Courses slot.
    expect(ROUTES.classroomGrades.studentSafe).toBe(true);
    expect(ROUTES.classroomGrades.bottomSlot).toEqual({ student: "courses", teacher: "classrooms" });
  });

  it("parses the classroom's Groups and a group set in every build, since M3-16a (ADR-070)", () => {
    expect(routeToPath({ view: "classroomGroups", id: "c-1" })).toBe("/classrooms/c-1/groups");
    expect(parsePath("/classrooms/c-1/groups")).toEqual({ view: "classroomGroups", id: "c-1" });
    expect(parsePath("/classrooms/c-1/groups/")).toEqual({ view: "classroomGroups", id: "c-1" });
    expect(routeToPath({ view: "groupSet", classroomId: "c-1", id: "s-1" })).toBe("/classrooms/c-1/groups/s-1");
    expect(parsePath("/classrooms/c-1/groups/s-1")).toEqual({ view: "groupSet", classroomId: "c-1", id: "s-1" });
    // The way back to a project travels in the query, which `parsePath` never reads.
    expect(routeToPath({ view: "groupSet", classroomId: "c-1", id: "s-1", fromProject: "p-1" })).toBe(
      "/classrooms/c-1/groups/s-1?fromProject=p-1",
    );
    // A set's page is the staff's: a student, or a teacher in the student view, gets the home.
    expect(ROUTES.groupSet.studentSafe).toBe(false);
    // The Groups tab is one address, two pages (F-PROJ-22, M3-17), under the Courses slot.
    expect(ROUTES.classroomGroups.studentSafe).toBe(true);
    expect(ROUTES.classroomGroups.bottomSlot).toEqual({ student: "courses", teacher: "classrooms" });
  });

  it("parses the project page and the new project in every build, since M3-12 (F-PROJ-13)", () => {
    expect(parsePath("/projects/p-1")).toEqual({ view: "project", id: "p-1" });
    expect(parsePath("/classrooms/c-1/projects/new")).toEqual({ view: "projectNew", classroomId: "c-1" });
  });

  it("parses the page of one course, a page of the Courses section (F-ORG-12)", () => {
    expect(routeToPath({ view: "course", id: "k-1" })).toBe("/courses/k-1");
    expect(parsePath("/courses/k-1")).toEqual({ view: "course", id: "k-1" });
    expect(sectionOf({ view: "course", id: "k-1" })).toBe("home");
    // Its tabs are paths of their own; the classrooms are the bare address.
    expect(routeToPath({ view: "course", id: "k-1", tab: "members" })).toBe("/courses/k-1/members");
    expect(parsePath("/courses/k-1/members")).toEqual({ view: "course", id: "k-1", tab: "members" });
    // The former Conditions tab is a section of the settings (F-ORG-16).
    expect(parsePath("/courses/k-1/conditions")).toEqual({ view: "course", id: "k-1", tab: "settings" });
    expect(routeToPath({ view: "course", id: "k-1", tab: "classrooms" })).toBe("/courses/k-1");
    expect(parsePath("/courses/k-1/nope")).toEqual({ view: "course", id: "k-1" });
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

  it("opens the Administration on a tab from a system alert, the page reading it off the query", () => {
    expect(routeToPath({ view: "admin", tab: "system" })).toBe("/admin?tab=system");
    expect(routeToPath({ view: "admin" })).toBe("/admin");
    expect(parsePath("/admin")).toEqual({ view: "admin" });
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
    whatsNew: { view: "whatsNew" },
    admin: { view: "admin" },
    course: { view: "course", id: "k-1" },
    template: { view: "template", id: "t-1" },
    classroom: { view: "classroom", id: "c-1" },
    classrooms: { view: "classrooms" },
    studentCourses: { view: "studentCourses" },
    studentGrades: { view: "studentGrades" },
    classroomSettings: { view: "classroomSettings", id: "c-1" },
    classroomJournal: { view: "classroomJournal", id: "c-1", path: "10-semaine-1/10-pointeurs.md" },
    classroomGrades: { view: "classroomGrades", id: "c-1" },
    project: { view: "project", id: "p-1" },
    classroomGroups: { view: "classroomGroups", id: "c-1" },
    groupSet: { view: "groupSet", classroomId: "c-1", id: "s-1" },
    projectNew: { view: "projectNew", classroomId: "c-1" },
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
    kiosk: { view: "kiosk" },
    sebQuit: { view: "sebQuit" },
    discover: { view: "discover" },
    pair: { view: "pair" },
    feedback: { view: "feedback", attemptId: "a-1" },
    drill: { view: "drill" },
    live: { view: "live", id: "e-1" },
    evaluationPreview: { view: "evaluationPreview", id: "e-1" },
    poll: { view: "poll", id: "e-1" },
    pollModerate: { view: "pollModerate", id: "e-1" },
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
    for (const r of Object.values(sample)) expect(parsePath(routeToPath(r))).toEqual(r);
  });

  it("marks the views a student has a screen for, and only them", () => {
    expect(ROUTE_VIEWS.filter((v) => ROUTES[v].studentSafe).sort()).toEqual([
      "attempt",
      // F-ORG-15: the student's page of the classroom (M5-02).
      "classroom",
      // The merge's student tabs: the Journal (M4-05) and the Grades (M5-04).
      "classroomGrades",
      // F-PROJ-22 (M3-17): the student's Groups tab.
      "classroomGroups",
      "classroomJournal",
      "discover",
      "drill",
      "feedback",
      "home",
      "join",
      "kiosk",
      "oauthConsent",
      "pair",
      // F-PROJ-15 (M3-13): one address, the student's project for a student.
      "project",
      "sebQuit",
      "settings",
      // F-ORG-14: the student's Courses (M5-02) and Grades.
      "studentCourses",
      "studentGrades",
      "teamsLink",
      "teamsTab",
      // ADR-087: the history of What's new, for every account.
      "whatsNew",
    ]);
  });

  it("lets What's new open on the home and the lists only (ADR-087)", () => {
    expect(ROUTE_VIEWS.filter((v) => ROUTES[v].whatsNew).sort()).toEqual(
      ["classroom", "classrooms", "course", "home", "pools", "studentCourses"],
    );
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
      pollModerate: "polls",
      admin: "admin",
      project: "activities",
    });
    const unlit = ROUTE_VIEWS.filter((v) => lit[v] === null).sort();
    expect(unlit).toEqual(
      [
        "attempt",
        "classroom",
        "classroomGrades",
        // The phone's "right now" page (#449): the desktop has the sidebar list.
        "classrooms",
        "classroomGroups",
        "classroomJournal",
        "classroomSettings",
        "correction",
        "devUi",
        // The student's pages: the student sidebar is lit by the bottom
        // bar's slot (`bottomSlotOf`), never by a section.
        "discover",
        "drill",
        "evaluation",
        "evaluationPreview",
        "feedback",
        "grading",
        "groupSet",
        "join",
        "kiosk",
        "live",
        "oauthConsent",
        "pair",
        "projectNew",
        "questionPreview",
        "results",
        "sebQuit",
        "settings",
        "studentCourses",
        "studentGrades",
        "teamsLink",
        "teamsTab",
        "whatsNew",
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

/* The routes of the classroom merge (M1-05, `docs/merge/05-web.md` §5.2). */
describe("the classroom merge's routes", () => {
  it("writes the paths of §5.2 and reads them back", () => {
    const cases: [Route, string][] = [
      [{ view: "studentCourses" }, "/courses"],
      [{ view: "classroom", id: "c-1" }, "/classrooms/c-1"],
      [{ view: "classroomSettings", id: "c-1" }, "/classrooms/c-1/settings"],
      [{ view: "classroomJournal", id: "c-1" }, "/classrooms/c-1/journal"],
      [{ view: "classroomJournal", id: "c-1", path: "README.md" }, "/classrooms/c-1/journal/README.md"],
      [
        { view: "classroomJournal", id: "c-1", path: "10-semaine-1/20-pointeurs/README.md" },
        "/classrooms/c-1/journal/10-semaine-1/20-pointeurs/README.md",
      ],
      [
        { view: "classroomJournal", id: "c-1", path: "20-semaine 2 été/10-tableaux #1.md" },
        "/classrooms/c-1/journal/20-semaine%202%20%C3%A9t%C3%A9/10-tableaux%20%231.md",
      ],
      [{ view: "classroomGrades", id: "c-1" }, "/classrooms/c-1/grades"],
      [{ view: "project", id: "p-1" }, "/projects/p-1"],
      [{ view: "classroomGroups", id: "c-1" }, "/classrooms/c-1/groups"],
      [{ view: "groupSet", classroomId: "c-1", id: "s-1" }, "/classrooms/c-1/groups/s-1"],
      [{ view: "projectNew", classroomId: "c-1" }, "/classrooms/c-1/projects/new"],
    ];
    for (const [route, path] of cases) {
      expect(routeToPath(route)).toBe(path);
      expect(parsePath(path)).toEqual(route);
    }
  });

  it("opens the Settings' connect sheet by its query, which the page itself reads (M3-11)", () => {
    expect(routeToPath({ view: "classroomSettings", id: "c-1", connect: true })).toBe("/classrooms/c-1/settings?connect=1");
  });

  it("tells /courses (the student's) from /courses/:id (one course)", () => {
    expect(parsePath("/courses/")).toEqual({ view: "studentCourses" });
    expect(parsePath("/courses/k-1")).toEqual({ view: "course", id: "k-1" });
  });

  it("reads a nested journal path as the address wrote it, trailing and doubled slashes aside", () => {
    const route = { view: "classroomJournal", id: "c-1", path: "10-semaine-1/README.md" };
    expect(parsePath("/classrooms/c-1/journal/10-semaine-1/README.md/")).toEqual(route);
    expect(parsePath("/classrooms/c-1/journal//10-semaine-1//README.md")).toEqual(route);
    expect(parsePath("/classrooms/c-1/journal/")).toEqual({ view: "classroomJournal", id: "c-1" });
  });

  it("keeps a malformed escape as written, for the reader to find no such page", () => {
    expect(parsePath("/classrooms/c-1/journal/%E0%A4%A.md")).toEqual({
      view: "classroomJournal",
      id: "c-1",
      path: "%E0%A4%A.md",
    });
  });

  it.each([
    ["an escaped slash, never a separator", "a%2Fb.md"],
    ["an escaped slash, lower case", "a%2fb.md"],
    ["an escaped climb with a slash", "..%2F..%2Fsecret.md"],
    ["an escaped climb", "%2E%2E/secret.md"],
    ["a plain climb", "a/../../secret.md"],
    ["a NUL", "a%00.md"],
    ["a double-encoded dot", "%252e%252e/secret.md"],
    ["a path over the cap", `${"x".repeat(401)}.md`],
  ])("lands on the journal's home for %s", (_why, tail) => {
    expect(parsePath(`/classrooms/c-1/journal/${tail}`)).toEqual({ view: "classroomJournal", id: "c-1" });
  });

  it("takes the tabs before the classroom, which keeps any other tail", () => {
    expect(parsePath("/classrooms/c-1/settings/")).toEqual({ view: "classroomSettings", id: "c-1" });
    expect(parsePath("/classrooms/c-1/grades/")).toEqual({ view: "classroomGrades", id: "c-1" });
    expect(parsePath("/classrooms/c-1/whatever")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/classrooms/c-1/groups/")).toEqual({ view: "classroomGroups", id: "c-1" });
    // A project takes no tail (M3-10): anything else, its old groups page included, is home.
    expect(parsePath("/projects/p-1/groups")).toEqual({ view: "home" });
    expect(parsePath("/projects/p-1/other")).toEqual({ view: "home" });
    expect(parsePath("/projects")).toEqual({ view: "home" });
  });

  it("opens the classroom to a student, and lights Courses on the student's classroom pages", () => {
    expect(ROUTES.classroom.studentSafe).toBe(true);
    for (const path of ["/courses", "/classrooms/c-1", "/classrooms/c-1/journal/a.md", "/classrooms/c-1/grades"]) {
      expect(bottomSlotOf(parsePath(path), false)).toBe("courses");
    }
  });
});
