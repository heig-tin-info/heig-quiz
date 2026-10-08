import { describe, expect, it } from "vitest";

import { AssistContext, type Me } from "@quiz/contracts";

import { ROUTE_VIEWS, type Route } from "../router";
import { assistContext, assistVisible, routeEntities, routePattern } from "./context";

const ID = "0b6f6a52-6c7e-4a0d-9e8e-3a3f1e2b4c5d";
const portal = { kind: "portal" } as Me["session"];

describe("routePattern — the screen, never the entity (ADR-080 §2)", () => {
  it("turns every id into a parameter and keeps the tabs", () => {
    expect(routePattern({ view: "pool", id: ID })).toBe("/pools/:id");
    expect(routePattern({ view: "course", id: ID, tab: "pools" })).toBe("/courses/:id/pools");
    expect(routePattern({ view: "admin", tab: "llm" })).toBe("/admin?tab=llm");
    expect(routePattern({ view: "grading", evaluationId: ID, item: ID })).toBe("/evaluations/:evaluationId/grading");
  });

  it("drops what is not an id: a journal page's path, the editor's origin", () => {
    expect(routePattern({ view: "classroomJournal", id: ID, path: "20-semaine 2/10-tableaux.md" })).toBe(
      "/classrooms/:id/journal",
    );
    expect(routePattern({ view: "question", id: ID, from: ID })).toBe("/questions/:id");
  });

  it("gives every view a pattern the contract accepts", () => {
    for (const view of ROUTE_VIEWS) {
      const route = { view, id: ID, classroomId: ID, evaluationId: ID, attemptId: ID, code: "ABCD" } as unknown as Route;
      const pattern = routePattern(route);
      expect(AssistContext.shape.route.safeParse(pattern).success, `${view}: ${pattern}`).toBe(true);
      expect(pattern).not.toContain(ID);
    }
  });
});

describe("assistContext", () => {
  it("builds a context the server accepts, with the topic of the mounted page's help button", () => {
    expect(AssistContext.parse(assistContext({ view: "pool", id: ID }, "fr"))).toEqual({
      route: "/pools/:id",
      helpTopic: null,
      locale: "fr",
      entities: { pool: ID },
    });
    expect(assistContext({ view: "home" }, "en")).toEqual({ route: "/", helpTopic: null, locale: "en" });
  });
});

describe("routeEntities — a closed list of kinds (ADR-080 P2, item 3)", () => {
  const OTHER = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

  it("names the screen's course, classroom, pool, question, evaluation or template", () => {
    expect(routeEntities({ view: "course", id: ID, tab: "pools" })).toEqual({ course: ID });
    expect(routeEntities({ view: "classroomGrades", id: ID })).toEqual({ classroom: ID });
    expect(routeEntities({ view: "question", id: ID, from: OTHER })).toEqual({ question: ID });
    expect(routeEntities({ view: "grading", evaluationId: ID, item: OTHER })).toEqual({ evaluation: ID });
    expect(routeEntities({ view: "groupSet", classroomId: ID, id: OTHER })).toEqual({ classroom: ID });
    expect(routeEntities({ view: "template", id: ID })).toEqual({ template: ID });
  });

  it("never names an attempt, a project or anything outside the list, and drops what is not a uuid", () => {
    expect(routeEntities({ view: "feedback", attemptId: ID })).toEqual({});
    expect(routeEntities({ view: "project", id: ID })).toEqual({});
    expect(routeEntities({ view: "join", code: "ABCD" })).toEqual({});
    expect(routeEntities({ view: "classroom", id: "r1" })).toEqual({});
  });

  it("gives every view a context the server accepts", () => {
    for (const view of ROUTE_VIEWS) {
      const route = { view, id: ID, classroomId: ID, evaluationId: ID, attemptId: ID, code: "ABCD" } as unknown as Route;
      const context = assistContext(route, "en");
      expect(AssistContext.safeParse(context).success, view).toBe(true);
      expect(JSON.stringify(context.entities ?? {}), view).not.toContain("attempt");
    }
  });
});

describe("assistVisible (ADR-080 §3)", () => {
  const teacher = { role: "teacher", session: portal } as Pick<Me, "role" | "session">;

  it("is the teacher UI's, an administrator's too, on any framed screen, a running evaluation's included", () => {
    expect(assistVisible({ teacherUi: true, me: teacher, view: "pool" })).toBe(true);
    expect(assistVisible({ teacherUi: true, me: teacher, view: "live" })).toBe(true);
    expect(assistVisible({ teacherUi: true, me: { role: "admin" }, view: "admin" })).toBe(true);
  });

  it("is hidden in the student view, for a student and under impersonation", () => {
    expect(assistVisible({ teacherUi: false, me: teacher, view: "home" })).toBe(false);
    expect(assistVisible({ teacherUi: true, me: { role: "student", session: portal }, view: "home" })).toBe(false);
    const acting = { role: "teacher", session: { ...portal!, kind: "impersonation" } } as Pick<Me, "role" | "session">;
    expect(assistVisible({ teacherUi: true, me: acting, view: "home" })).toBe(false);
  });

  it("is hidden on a confined session and on the projected screens", () => {
    for (const kind of ["seb", "kiosk"] as const) {
      const confined = { role: "teacher", session: { ...portal!, kind } } as Pick<Me, "role" | "session">;
      expect(assistVisible({ teacherUi: true, me: confined, view: "home" })).toBe(false);
    }
    for (const view of ["poll", "correction", "attempt", "evaluationPreview"] as const) {
      expect(assistVisible({ teacherUi: true, me: teacher, view })).toBe(false);
    }
  });
});
