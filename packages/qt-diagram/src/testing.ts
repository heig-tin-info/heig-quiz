/**
 * `@quiz/qt-diagram/testing` — the full configuration of the leak test
 * (invariant 4, docs/spec/05 §5.7). TEST-ONLY: nothing in `apps/*` imports it.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";
import type { Scene } from "@quiz/diagram/server";

import { DiagramConfigSchema, type DiagramConfig } from "./schema.js";

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

export const SECRET_CONFIG: DiagramConfig = DiagramConfigSchema.parse({
  configVersion: 1,
  prompt: "Draw the class diagram of the figures.",
  kind: "class",
  reference: REFERENCE,
  starter: STARTER,
  rubric: RUBRIC,
});

export const diagramLeakFixture: StudentLeakFixture<DiagramConfig> = {
  config: SECRET_CONFIG,
  /* What only `diagram` holds: the reference diagram. */
  forbiddenKeys: ["reference", "rubric"],
  secrets: SECRET_VALUES,
};
