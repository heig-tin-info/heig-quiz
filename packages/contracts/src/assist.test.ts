import { describe, expect, it } from "vitest";

import { AssistAsk, AssistContext, assistScreenOf } from "./assist.js";

const ok = (route: string) => AssistContext.safeParse({ route, helpTopic: null, locale: "en" }).success;

describe("AssistContext — a route pattern, never an entity (ADR-080 §2)", () => {
  it("accepts literal segments, parameters and a tab", () => {
    expect(ok("/")).toBe(true);
    expect(ok("/pools/:id")).toBe(true);
    expect(ok("/evaluations/:evaluationId/grading")).toBe(true);
    expect(ok("/admin?tab=llm")).toBe(true);
    expect(ok("/courses/:id/pools")).toBe(true);
  });

  it("refuses an id, a name with capitals or digits, a query and a journal path", () => {
    expect(ok("/pools/0b6f6a52-6c7e-4a0d-9e8e-3a3f1e2b4c5d")).toBe(false);
    expect(ok("/classrooms/:id/journal/20-semaine 2")).toBe(false);
    expect(ok("/courses/Dupont")).toBe(false);
    expect(ok("/pools?q=secret")).toBe(false);
    expect(ok("pools")).toBe(false);
  });

  it("takes a help topic slug and the two UI languages only", () => {
    expect(AssistContext.safeParse({ route: "/", helpTopic: "question-editor", locale: "fr" }).success).toBe(true);
    expect(AssistContext.safeParse({ route: "/", helpTopic: "../x", locale: "fr" }).success).toBe(false);
    expect(AssistContext.safeParse({ route: "/", helpTopic: null, locale: "de" }).success).toBe(false);
    expect(AssistContext.safeParse({ route: "/", helpTopic: null, locale: "en", title: "x" }).success).toBe(false);
  });
});

describe("AssistContext's entities — a closed allowlist of kinds (ADR-080 P2, item 3)", () => {
  const id = "0b6f6a52-6c7e-4a0d-9e8e-3a3f1e2b4c5d";
  const withEntities = (entities: unknown) =>
    AssistContext.safeParse({ route: "/classrooms/:id", helpTopic: null, locale: "en", entities }).success;

  it("takes the uuid of a course, classroom, pool, question, evaluation or template", () => {
    for (const kind of ["course", "classroom", "pool", "question", "evaluation", "template"]) {
      expect(withEntities({ [kind]: id }), kind).toBe(true);
    }
    expect(withEntities({})).toBe(true);
  });

  it("refuses a student, a user, an enrollment or an attempt id, and anything that is not a uuid", () => {
    for (const kind of ["student", "user", "enrollment", "attempt", "studentId"]) {
      expect(withEntities({ classroom: id, [kind]: id }), kind).toBe(false);
    }
    expect(withEntities({ classroom: "Dupont" })).toBe(false);
    expect(withEntities({ classroom: "r1" })).toBe(false);
  });

  it("is stored without its ids", () => {
    const context = AssistContext.parse({ route: "/classrooms/:id", helpTopic: "classroom", locale: "fr", entities: { classroom: id } });
    expect(assistScreenOf(context)).toEqual({ route: "/classrooms/:id", helpTopic: "classroom", locale: "fr" });
  });
});

describe("AssistAsk", () => {
  it("trims the question and refuses an empty one", () => {
    const context = { route: "/", helpTopic: null, locale: "en" };
    expect(AssistAsk.parse({ message: "  hi ", context }).message).toBe("hi");
    expect(AssistAsk.safeParse({ message: "   ", context }).success).toBe(false);
  });
});
