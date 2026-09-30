import { describe, expect, it, vi } from "vitest";

/*
 * The routes of the classroom merge (M1-05, `docs/merge/05-web.md` §5.2) with
 * `CLASSROOM_PAGES` on, as in the browser mock. The flag is read once, when
 * `flags.ts` is evaluated, so the environment is stubbed before the router is
 * imported; router.test.ts covers the same table with the flag off.
 */
vi.stubEnv("VITE_CLASSROOM_PAGES", "1");
const { bottomSlotOf, parsePath, ROUTES, routeToPath } = await import("./router");
type Route = import("./router").Route;

describe("the classroom merge's routes, CLASSROOM_PAGES on", () => {
  it("round-trips each of them", () => {
    const routes: Route[] = [
      { view: "studentCourses" },
      { view: "classroom", id: "c-1" },
      { view: "classroomSettings", id: "c-1" },
      { view: "classroomJournal", id: "c-1" },
      { view: "classroomJournal", id: "c-1", path: "README.md" },
      { view: "classroomJournal", id: "c-1", path: "10-semaine-1/20-pointeurs/README.md" },
      { view: "classroomGrades", id: "c-1" },
      { view: "project", id: "p-1" },
      { view: "projectGroups", id: "p-1" },
    ];
    for (const r of routes) expect(parsePath(routeToPath(r))).toEqual(r);
  });

  it("writes the paths of §5.2", () => {
    expect(routeToPath({ view: "studentCourses" })).toBe("/courses");
    expect(routeToPath({ view: "classroomSettings", id: "c-1" })).toBe("/classrooms/c-1/settings");
    expect(routeToPath({ view: "classroomJournal", id: "c-1" })).toBe("/classrooms/c-1/journal");
    expect(routeToPath({ view: "classroomJournal", id: "c-1", path: "a/b.md" })).toBe(
      "/classrooms/c-1/journal/a/b.md",
    );
    expect(routeToPath({ view: "classroomGrades", id: "c-1" })).toBe("/classrooms/c-1/grades");
    expect(routeToPath({ view: "project", id: "p-1" })).toBe("/projects/p-1");
    expect(routeToPath({ view: "projectGroups", id: "p-1" })).toBe("/projects/p-1/groups");
  });

  it("tells /courses (the student's) from /courses/:id (one course)", () => {
    expect(parsePath("/courses")).toEqual({ view: "studentCourses" });
    expect(parsePath("/courses/")).toEqual({ view: "studentCourses" });
    expect(parsePath("/courses/k-1")).toEqual({ view: "course", id: "k-1" });
  });

  it("encodes a journal path segment by segment, and decodes it back", () => {
    const route: Route = { view: "classroomJournal", id: "c-1", path: "20-semaine 2 été/10-tableaux #1.md" };
    const path = routeToPath(route);
    expect(path).toBe("/classrooms/c-1/journal/20-semaine%202%20%C3%A9t%C3%A9/10-tableaux%20%231.md");
    expect(parsePath(path)).toEqual(route);
  });

  it("reads a nested journal path as the address wrote it, trailing and doubled slashes aside", () => {
    const route = { view: "classroomJournal", id: "c-1", path: "10-semaine-1/README.md" };
    expect(parsePath("/classrooms/c-1/journal/10-semaine-1/README.md")).toEqual(route);
    expect(parsePath("/classrooms/c-1/journal/10-semaine-1/README.md/")).toEqual(route);
    expect(parsePath("/classrooms/c-1/journal//10-semaine-1//README.md")).toEqual(route);
    // The journal's home, with or without its slash.
    expect(parsePath("/classrooms/c-1/journal")).toEqual({ view: "classroomJournal", id: "c-1" });
    expect(parsePath("/classrooms/c-1/journal/")).toEqual({ view: "classroomJournal", id: "c-1" });
  });

  it("keeps a malformed escape as written, for the reader to find no such page", () => {
    expect(parsePath("/classrooms/c-1/journal/%E0%A4%A.md")).toEqual({
      view: "classroomJournal",
      id: "c-1",
      path: "%E0%A4%A.md",
    });
    // An encoded slash is a separator once decoded: the journal's paths never
    // hold one in a name (N-SEC-15), and the API validates what it is sent.
    expect(parsePath("/classrooms/c-1/journal/a%2Fb.md")).toEqual({
      view: "classroomJournal",
      id: "c-1",
      path: "a/b.md",
    });
  });

  it("takes the tabs before the classroom, which keeps any other tail", () => {
    expect(parsePath("/classrooms/c-1/settings/")).toEqual({ view: "classroomSettings", id: "c-1" });
    expect(parsePath("/classrooms/c-1/grades/")).toEqual({ view: "classroomGrades", id: "c-1" });
    expect(parsePath("/classrooms/c-1/whatever")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/classrooms/c-1/")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/projects/p-1/groups/")).toEqual({ view: "projectGroups", id: "p-1" });
    expect(parsePath("/projects/p-1/other")).toEqual({ view: "project", id: "p-1" });
    expect(parsePath("/projects")).toEqual({ view: "home" });
  });

  it("opens the classroom to a student, and keeps the settings and projects the staff's", () => {
    expect(ROUTES.classroom.studentSafe).toBe(true);
    expect(ROUTES.studentCourses.studentSafe).toBe(true);
    expect(ROUTES.classroomJournal.studentSafe).toBe(true);
    expect(ROUTES.classroomGrades.studentSafe).toBe(true);
    expect(ROUTES.classroomSettings.studentSafe).toBe(false);
    expect(ROUTES.project.studentSafe).toBe(false);
    expect(ROUTES.projectGroups.studentSafe).toBe(false);
  });

  it("lights the bottom bar's Courses on the student's classroom pages", () => {
    for (const path of ["/courses", "/classrooms/c-1", "/classrooms/c-1/journal/a.md", "/classrooms/c-1/grades"]) {
      expect(bottomSlotOf(parsePath(path))).toBe("courses");
    }
  });
});
