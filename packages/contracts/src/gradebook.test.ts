import { describe, expect, it } from "vitest";

import {
  GradebookColumnParams,
  GradebookColumnPatch,
  GradebookComponentCreate,
  GradebookComponentPatch,
  GradebookMarkPut,
  GradebookSettingsPatch,
  GradebookStudent,
  GradebookStudentComponent,
  GradebookTemplateColumnPatch,
} from "./gradebook.js";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("gradebook inputs", () => {
  it("takes a weight as a whole percentage 0 to 100, a flag, a position — and at least one", () => {
    for (const weight of [0, 40, 100]) expect(GradebookColumnPatch.safeParse({ weight }).success).toBe(true);
    expect(GradebookColumnPatch.safeParse({ counts: false, position: null }).success).toBe(true);
    for (const bad of [{}, { weight: -1 }, { weight: 101 }, { weight: 2.5 }, { position: -1 }, { counts: "yes" }]) {
      expect(GradebookColumnPatch.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes an absence, or a score with its maximum, and an explicit override", () => {
    expect(GradebookMarkPut.safeParse({ kind: "absent" }).success).toBe(true);
    expect(GradebookMarkPut.safeParse({ kind: "score", points: 4, max: 10, override: true, comment: " ok " }).success).toBe(true);
    for (const bad of [{ kind: "score", points: 4 }, { kind: "score", points: 4, max: 0 }, { kind: "score", points: -1, max: 10 }, { kind: "late" }]) {
      expect(GradebookMarkPut.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("assigns a column to a component of the mean, or to none (ADR-131)", () => {
    expect(GradebookColumnPatch.safeParse({ componentId: uuid }).success).toBe(true);
    expect(GradebookColumnPatch.parse({ componentId: null })).toEqual({ componentId: null });
    expect(GradebookColumnPatch.safeParse({ componentId: "labo" }).success).toBe(false);
  });

  it("takes a template's weight, flag and component, never a position — and at least one (ADR-131 §15)", () => {
    expect(GradebookTemplateColumnPatch.parse({ weight: 40, counts: true, componentId: uuid })).toEqual({ weight: 40, counts: true, componentId: uuid });
    expect(GradebookTemplateColumnPatch.safeParse({ componentId: null }).success).toBe(true);
    for (const bad of [{}, { position: 2 }, { weight: 40, position: null }, { weight: 101 }]) {
      expect(GradebookTemplateColumnPatch.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes a component's name trimmed, 1 to 40 characters, and its weight 100 % by default (ADR-131)", () => {
    expect(GradebookComponentCreate.parse({ name: "  Labo " })).toEqual({ name: "Labo", weight: 100 });
    expect(GradebookComponentCreate.parse({ name: "x".repeat(40), weight: 0 }).weight).toBe(0);
    for (const bad of [{ name: "   " }, { name: "x".repeat(41) }, { name: "Labo", weight: 101 }, { name: "Labo", weight: 12.5 }, {}]) {
      expect(GradebookComponentCreate.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(GradebookComponentPatch.safeParse({ weight: 50 }).success).toBe(true);
    expect(GradebookComponentPatch.safeParse({ name: "Cours" }).success).toBe(true);
    expect(GradebookComponentPatch.safeParse({}).success).toBe(false);
  });

  it("addresses a column by its activity, an evaluation or a project", () => {
    expect(GradebookColumnParams.safeParse({ id: uuid, kind: "evaluation", activityId: uuid }).success).toBe(true);
    expect(GradebookColumnParams.safeParse({ id: uuid, kind: "poll", activityId: uuid }).success).toBe(false);
    expect(GradebookSettingsPatch.safeParse({ meanPublished: true }).success).toBe(true);
    expect(GradebookSettingsPatch.safeParse({}).success).toBe(false);
  });
});

describe("the student's gradebook", () => {
  it("has no mean unless it is given, and null when it is published without a grade", () => {
    const base = { classroomId: uuid, components: [], columns: [], cells: {} };
    expect("mean" in GradebookStudent.parse(base)).toBe(false);
    expect(GradebookStudent.parse({ ...base, mean: null }).mean).toBeNull();
    expect(GradebookStudent.parse({ ...base, mean: 4.5 }).mean).toBe(4.5);
  });

  it("names a component without its weight nor its mean unless they are given (ADR-131)", () => {
    const component = GradebookStudent.parse({ classroomId: uuid, components: [{ id: uuid, name: "Labo" }], columns: [], cells: {} }).components[0]!;
    expect(Object.keys(component).sort()).toEqual(["id", "name"]);
    expect(Object.keys(GradebookStudentComponent.shape).sort()).toEqual(["id", "mean", "name", "weight"]);
  });
});
