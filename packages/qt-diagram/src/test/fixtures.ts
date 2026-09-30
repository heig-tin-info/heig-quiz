/** Test fixtures for the `diagram` suites (excluded from the build). */
import type { GradeContext, RunnerService } from "@quiz/core/server";
import type { Scene } from "@quiz/diagram/server";

import { DiagramConfigSchema, type DiagramConfig } from "../schema.js";

const noRunner: RunnerService = {
  run() {
    throw new Error("the diagram type must never call the runner");
  },
  health() {
    return Promise.resolve({ ok: false, languages: [], queued: 0, avgMs: null });
  },
};

export function gradeContext(itemPoints: number): GradeContext {
  return {
    seed: 7,
    itemId: "item-1",
    attemptId: "attempt-1",
    itemPoints,
    now: new Date("2026-09-30T10:00:00Z"),
    runner: noRunner,
  };
}

/**
 * The key: two classes and an inheritance. Every value here is one the
 * STARTER does not hold, ids included, so a search of the student's view for
 * any of them proves the reference stayed home.
 */
export const REFERENCE: Scene = {
  nodes: [
    { id: "r3fk9aa1", t: "class", x: 0, y: 0, name: "SecretFigureRef", body: ["# secretOrigin : Point", "---", "+ secretArea() : double"] },
    { id: "r3fk9bb2", t: "class", x: 0, y: 200, name: "SecretCircleRef", body: ["- secretRadius : double"] },
  ],
  links: [{ id: "r3fk9cc3", type: "inh", a: "r3fk9bb2", b: "r3fk9aa1", name: "secretLinkName" }],
};

/** What the student starts from: one class of their own, under ids of its own. */
export const STARTER: Scene = {
  nodes: [{ id: "st4rt001", t: "class", x: 40, y: 40, name: "Shape" }],
  links: [],
};

export const RUBRIC = "RUBRIC-SECRET: inheritance from the abstract class";

/** The values only the grader may read: none of them may reach a student. */
export const SECRET_VALUES = [
  "SecretFigureRef",
  "SecretCircleRef",
  "secretOrigin",
  "secretArea",
  "secretRadius",
  "secretLinkName",
  "r3fk9aa1",
  "r3fk9bb2",
  "r3fk9cc3",
  RUBRIC,
] as const;

export function config(over: Partial<DiagramConfig> = {}): DiagramConfig {
  return DiagramConfigSchema.parse({
    configVersion: 1,
    prompt: "Draw the class diagram of the figures.",
    kind: "class",
    reference: REFERENCE,
    starter: STARTER,
    rubric: RUBRIC,
    ...over,
  });
}
