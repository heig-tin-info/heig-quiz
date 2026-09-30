/**
 * `@quiz/qt-diagram/client` — the browser half of the `diagram` type
 * ("Diagram" / « Diagramme », docs/spec/04 §4.14).
 *
 * The three components are behind `React.lazy`, as the plan requires of every
 * registered type: the pool list, the dashboard and the student shell import
 * the registry, not the editors, so the diagram engine is fetched only with
 * the type.
 */
import { lazy } from "react";
import type { QuestionTypeClient } from "@quiz/core/client";
import { typeIcon } from "@quiz/ui";

import { diagramGrading } from "./grading.js";
import { isDiagramAnswered, startingScene } from "./schema.js";
import type { DiagramAnswer, DiagramConfig, DiagramDetails, DiagramSolution, DiagramStudent } from "./schema.js";

type DiagramClient = QuestionTypeClient<DiagramConfig, DiagramAnswer, DiagramStudent, DiagramSolution, DiagramDetails>;

/** Two boxes, the first with a compartment, joined by an elbowed line: a diagram. */
const DiagramIcon = typeIcon(<path d="M3 3.5h7.5v7H3zM3 6.5h7.5M13.5 13.5H21v7h-7.5zM6.75 10.5v6.5h6.75" />, "size-4");

export const diagramClient: DiagramClient = {
  id: "diagram",
  labelKey: "qt.diagram.label",
  hintKey: "qt.diagram.hint",
  Icon: DiagramIcon,

  Editor: lazy(async () => ({ default: (await import("./Editor.js")).DiagramQuestionEditor })),
  Player: lazy(async () => ({ default: (await import("./Player.js")).DiagramPlayer })),
  Review: lazy(async () => ({ default: (await import("./Review.js")).DiagramReview })),

  /** The answer starts as a copy of the starter (docs/04 §4.14). */
  emptyAnswer: (student) => ({ scene: startingScene(student.starter) }),
  isAnswered: isDiagramAnswered,
  grading: diagramGrading,
};

/* The surfaces stay out of the values exported here, or the `lazy` above is undone (see qt-mcq). */
export { diagramEditorStrings, diagramGradingStrings, diagramPlayerStrings, diagramReviewStrings } from "./strings.js";
export { emptyDiagramDraft } from "./schema.js";
export type { DiagramAnswer, DiagramConfig, DiagramDetails, DiagramSolution, DiagramStudent } from "./schema.js";
