import { describe, expect, it, vi } from "vitest";

/*
 * The routes of the classroom merge (M1-05, `docs/merge/05-web.md` §5.2) with
 * `CLASSROOM_PAGES` on, as in the browser mock. The flag is read once, when
 * `router.ts` is evaluated, so the environment is stubbed before the router
 * is imported; router.test.ts covers the same table with the flag off.
 */
vi.stubEnv("VITE_CLASSROOM_PAGES", "1");
const { bottomSlotOf, parsePath, ROUTES, routeToPath } = await import("./router");
type Route = import("./router").Route;

describe("the classroom merge's routes, CLASSROOM_PAGES on", () => {
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
