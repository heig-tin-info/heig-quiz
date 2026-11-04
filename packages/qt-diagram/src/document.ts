/**
 * The `diagram` question as blocks of an exported document (ADR-121 §2,
 * ADR-125, ADR-126).
 *
 * On paper the student draws in a squared frame, the grid of the editor's,
 * with the starting diagram drawn in grey at its top left. The statement and
 * the frame read the student view only, and the frame's height comes from the
 * starter or a default, never from the reference (ADR-126 §6): its size would
 * tell the size of the answer. The key draws the reference, then its text
 * form; the rubric only when the solution passed holds it (the staff's).
 */
import { answerZone, code, drawing, labelled, markdown, type Block, type Labels } from "@quiz/docexport";
import { PX_MM } from "@quiz/docexport/typst";
import { GRID, figure, isEmptyScene, langOf, toText, type DiagramKind, type Scene } from "@quiz/diagram/server";

import type { DiagramAnswer, DiagramConfig, DiagramSolution, DiagramStudent } from "./schema.js";

/** The name of each notation, in the reader's words. */
const NOTATION: Readonly<Record<DiagramKind, (l: Labels) => string>> = {
  class: (l) => l.diagramClass,
  usecase: (l) => l.diagramUsecase,
  state: (l) => l.diagramState,
  er: (l) => l.diagramEr,
  flow: (l) => l.diagramFlow,
  automaton: (l) => l.diagramAutomaton,
  graph: (l) => l.diagramGraph,
  free: (l) => l.diagramFree,
};

/** The figure of a scene that holds something; `null` otherwise. */
const figureOf = (scene: Scene | undefined, kind: DiagramKind) =>
  scene === undefined || isEmptyScene(scene) ? null : figure(scene, kind);

/** The prompt, and the notation the student draws in. */
export function diagramStatementDoc(student: DiagramStudent, labels: Labels): Block[] {
  return [markdown(student.prompt), markdown(labelled(labels, labels.diagramNotation, NOTATION[student.kind](labels)))];
}

/**
 * The frame: a page's worth of room by default, and room under the starter
 * when it is taller than that leaves (ADR-126 §6). Within the renderer's
 * bounds of a free frame.
 */
const FRAME_MM = { default: 160, room: 60, max: 240 } as const;

/**
 * A squared frame on the editor's grid (ADR-126 §3–§4): a cell is a grid
 * step printed at one pixel per unit, so the starter drawn under it at that
 * scale keeps its elements on the printed lines.
 */
export function diagramAnswerZone(student: DiagramStudent): Block[] {
  const starter = figureOf(student.starter, student.kind);
  const starterMm = starter === null ? 0 : starter.viewBox[3] * PX_MM;
  const heightMm = Math.min(FRAME_MM.max, Math.max(FRAME_MM.default, Math.round(starterMm + FRAME_MM.room)));
  return [
    answerZone("free", {
      heightMm,
      ruling: { kind: "grid", pitchMm: GRID * PX_MM },
      ...(starter === null ? {} : { underlay: starter }),
    }),
  ];
}

/** A scene drawn, then in its text form when the kind has one: the Markdown's reading of the figure. */
function drawn(scene: Scene, kind: DiagramKind, alt: string): Block[] {
  const fig = figureOf(scene, kind);
  const text = toText(scene, kind);
  return [...(fig === null ? [] : [drawing(fig, alt)]), ...(text ? [code(langOf(kind) ?? "text", text)] : [])];
}

/**
 * The reference drawn, and its text form; the starting diagram the student
 * was given, when there is one; the rubric when the solution holds it.
 */
export function diagramSolutionDoc(solution: DiagramSolution, student: DiagramStudent, labels: Labels): Block[] {
  const notation = NOTATION[student.kind](labels);
  const starter = figureOf(student.starter, student.kind);
  return [
    ...drawn(solution.reference, student.kind, notation),
    ...(starter === null ? [] : [markdown(`**${labels.diagramStarter}**`), drawing(starter, labels.diagramStarter)]),
    ...(solution.rubric?.trim() ? [markdown("**Rubric**"), markdown(solution.rubric)] : []),
  ];
}

/** The staff's reading of an answer: the drawing and its text form. */
export function diagramAnswerDoc(config: DiagramConfig, answer: DiagramAnswer): Block[] {
  return isEmptyScene(answer.scene) ? [markdown("No answer.")] : drawn(answer.scene, config.kind, "Answer");
}

/** The student's own reading: their drawing. */
export function diagramStudentAnswerDoc(student: DiagramStudent, answer: DiagramAnswer, _details: unknown, labels: Labels): Block[] {
  const fig = figureOf(answer.scene, student.kind);
  return [fig === null ? markdown(labels.noAnswer) : drawing(fig, labels.yourAnswer)];
}
