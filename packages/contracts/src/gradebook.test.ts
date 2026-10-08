import { describe, expect, it } from "vitest";

import {
  GradebookColumnParams,
  GradebookColumnPatch,
  GradebookMarkPut,
  GradebookSettingsPatch,
  GradebookStudent,
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

  it("addresses a column by its activity, an evaluation or a project", () => {
    expect(GradebookColumnParams.safeParse({ id: uuid, kind: "evaluation", activityId: uuid }).success).toBe(true);
    expect(GradebookColumnParams.safeParse({ id: uuid, kind: "poll", activityId: uuid }).success).toBe(false);
    expect(GradebookSettingsPatch.safeParse({ meanPublished: true }).success).toBe(true);
    expect(GradebookSettingsPatch.safeParse({}).success).toBe(false);
  });
});

describe("the student's gradebook", () => {
  it("has no mean unless it is given, and null when it is published without a grade", () => {
    const base = { classroomId: uuid, columns: [], cells: {} };
    expect("mean" in GradebookStudent.parse(base)).toBe(false);
    expect(GradebookStudent.parse({ ...base, mean: null }).mean).toBeNull();
    expect(GradebookStudent.parse({ ...base, mean: 4.5 }).mean).toBe(4.5);
  });
});
