/**
 * English defaults for the `diagram` components; `apps/web` passes its French
 * entries through the `strings` prop (see `StringOverrides` in
 * `@quiz/core/client`). The canvas itself — tools, inspector, text pane —
 * speaks through the engine's own dictionary (`diagramStrings` of
 * `@quiz/diagram/client`), which the host hands over as `canvasStrings`.
 */
import type { DiagramKind } from "@quiz/diagram/server";

export const diagramEditorStrings = {
  prompt: "Statement",
  kind: "Kind of diagram",
  kindHint: "What the student draws: the toolbox holds this kind's elements and nothing else.",
  kindLocked: "The kind is fixed once the question is published: the answers given so far are diagrams of this kind.",
  kindChange: "Change the kind of diagram?",
  kindChangeBody: "The reference and the starter hold elements of the current kind: they will be emptied.",
  kindChangeConfirm: "Change and empty",
  kindChangeCancel: "Cancel",
  "kind.class": "UML class",
  "kind.usecase": "Use case",
  "kind.state": "State machine",
  "kind.er": "Entity-relationship",
  "kind.flow": "Flowchart",
  "kind.automaton": "Finite automaton",
  "kind.graph": "Graph",
  "kind.free": "Free drawing",
  "kindHint.class": "Classes, their members and the links between them.",
  "kindHint.usecase": "Actors, use cases and the system boundary.",
  "kindHint.state": "States and the transitions between them.",
  "kindHint.er": "Entities, their attributes and the cardinalities.",
  "kindHint.flow": "Actions, decisions and the arrows of an algorithm.",
  "kindHint.automaton": "States, initial and accepting, and labelled transitions.",
  "kindHint.graph": "Vertices, and edges or arcs with a weight.",
  "kindHint.free": "Shapes, lines and freehand strokes.",
  reference: "Reference diagram",
  referenceHint:
    "The expected diagram. The grader sees it beside every answer, and students see it when the evaluation shows the expected answer.",
  starter: "Starter diagram",
  starterHint: "Optional: what the student starts from. Without one, the student starts from an empty canvas.",
  starterCopy: "Copy the reference into the starter",
  starterCopyHint: "Then remove what the student must add.",
  starterRemove: "Remove the starter",
  expand: "Expand",
  expanded: "This diagram is open over the page.",
  rubric: "Grading criteria",
  rubricHint:
    "How you will award the points, for yourself or another grader: shown beside every answer in the grading panel. Students never see it.",
  manualGrading:
    "Graded by hand: every drawn answer reaches the grading panel as a proposal of 0 points, to settle.",
} as const;

export type DiagramEditorStringKey = keyof typeof diagramEditorStrings;

export const kindKey = (kind: DiagramKind): DiagramEditorStringKey => `kind.${kind}`;
export const kindHintKey = (kind: DiagramKind): DiagramEditorStringKey => `kindHint.${kind}`;

export const diagramPlayerStrings = {
  label: "Your diagram",
  expand: "Expand",
  expandHint: "Expand the diagram to draw.",
  expanded: "The diagram is open over the page.",
} as const;

export type DiagramPlayerStringKey = keyof typeof diagramPlayerStrings;

export const diagramReviewStrings = {
  answer: "Answer",
  noAnswer: "No answer",
  reference: "Reference diagram",
  text: "Text form",
  textStudent: "Student",
  textReference: "Reference",
  rubric: "Grading criteria",
  noRubric: "No grading criteria.",
  elements: "{n} elements",
  "elements.one": "1 element",
  links: "{n} links",
  "links.one": "1 link",
  kindMismatch: "This answer was drawn for another kind of diagram than this version of the question: grade it by hand.",
  score: "Score",
} as const;

export type DiagramReviewStringKey = keyof typeof diagramReviewStrings;

/** The words of the grading table's one diagram column (ADR-044). */
export const diagramGradingStrings = {
  diagram: "Diagram",
  elements: "{n} elements",
  "elements.one": "1 element",
  links: "{n} links",
  "links.one": "1 link",
} as const;
