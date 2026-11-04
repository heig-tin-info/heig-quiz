/**
 * The `blocks` question as blocks of a printed document (ADR-121 §2,
 * ADR-125, ADR-126 §8).
 *
 * The statement reads the student view only: the visible warehouses drawn
 * with their battery, the hidden ones as a count and their points, the
 * toolbox's words, the starter as pseudo-code. The paper answer is a ruled
 * free frame for a program written by hand, graded by hand (ADR-125 §14):
 * nobody rebuilds it in Blockly. The key renders what the solution object
 * holds: the staff's every warehouse with the reference's trail, a
 * student's (`studentSolution`) the visible ones only. Every fixed word
 * follows `labels.lang`.
 */
import { z } from "zod";

import {
  answerZone,
  code,
  drawing,
  heading,
  labelled,
  markdown,
  noAnswerOr,
  number,
  table,
  type Block,
  type Labels,
} from "@quiz/docexport";
import { BLOCK_KINDS, type BlockKind, type Stmt } from "@quiz/domain/blocks";

import { runCase } from "./grade.js";
import { MAP_CELL_MM, mapFigure } from "./mapFigure.js";
import { pseudoCode } from "./pseudo.js";
import { RunReasonSchema, type BlocksAnswer, type BlocksSolution, type BlocksStudent } from "./schema.js";
import { BLOCKS_PAPER_WORDS, type BlocksPaperWords } from "./strings.js";

const wordsOf = (labels: Labels): BlocksPaperWords => BLOCKS_PAPER_WORDS[labels.lang];

const KIND_WORD = {
  forward: "kindForward",
  turn: "kindTurn",
  repeat: "kindRepeat",
  repeat_until_dock: "kindRepeatUntilDock",
  if_sensor: "kindIfSensor",
} as const satisfies Record<BlockKind, keyof BlocksPaperWords>;

/** A printed map is never taller than this, so two fit a page with their captions. */
const MAP_MAX_HEIGHT_MM = 100;

/** One warehouse: its name, then its map drawn (with a trail on a key), or nothing when the rows do not parse. */
function warehouse(
  labels: Labels,
  w: BlocksPaperWords,
  kase: { name: string; map: readonly string[] },
  caption: string,
  trail?: readonly { x: number; y: number }[],
): Block[] {
  const figure = mapFigure(kase.map, { dockLabel: w.dock, ...(trail === undefined ? {} : { trail }) });
  const width = kase.map[0]?.length ?? 0;
  return [
    heading(4, kase.name),
    markdown(caption),
    ...(figure === null
      ? []
      : [drawing(figure, labelled(labels, w.map, kase.name), {
          widthMm: width * MAP_CELL_MM,
          maxHeightMm: MAP_MAX_HEIGHT_MM,
        })]),
  ];
}

const pointsOf = (labels: Labels, points: number) => `${number(points)} ${labels.pointsShort}`;

/** The statement, the visible warehouses drawn, the hidden ones counted, the toolbox, the starter. */
export function blocksStatementDoc(student: BlocksStudent, labels: Labels): Block[] {
  const w = wordsOf(labels);
  const maps = student.visibleCases.flatMap((c) =>
    warehouse(labels, w, c, `${labelled(labels, w.battery, String(c.battery))} · ${pointsOf(labels, c.points)}`),
  );
  const toolbox = BLOCK_KINDS.filter((kind) => student.toolbox.includes(kind)).map((kind) => w[KIND_WORD[kind]]);
  return [
    markdown(student.prompt),
    ...(maps.length === 0 ? [] : [markdown(labels.blocksMapLegend), ...maps]),
    ...(student.hiddenCount === 0
      ? []
      : [
          markdown(
            labelled(labels, labels.blocksHiddenWarehouses, `${student.hiddenCount} · ${pointsOf(labels, student.hiddenPoints)}`),
          ),
        ]),
    ...(student.allOrNothing ? [markdown(labels.blocksAllOrNothing)] : []),
    markdown(labelled(labels, labels.blocksToolbox, toolbox.join(", "))),
    ...(student.starter.length === 0
      ? []
      : [markdown(labels.blocksStarter), code("text", pseudoCode(student.starter, w))]),
    markdown(labels.blocksAnswerHint),
  ];
}

/** Ruled lines for a program written by hand: its height never comes from the reference (ADR-126 §6). */
const ANSWER_LINES = 12;
const LINE_PITCH_MM = 8;

export function blocksAnswerZone(_student: BlocksStudent): Block[] {
  return [answerZone("free", { heightMm: ANSWER_LINES * LINE_PITCH_MM, pattern: { kind: "lines", pitchMm: LINE_PITCH_MM } })];
}

/** The reference's walk on a warehouse, or none when it cannot run there. */
function trailOn(reference: Stmt[] | null, kase: { map: string[]; battery: number }) {
  if (reference === null) return undefined;
  try {
    return runCase(reference, kase, { events: false }).trail;
  } catch {
    return undefined;
  }
}

/**
 * The reference as pseudo-code, then each warehouse the solution holds with
 * the reference's trail: every one for the staff, the visible ones only in
 * a student's (`studentSolution` dropped the hidden ones before this hook).
 */
export function blocksSolutionDoc(solution: BlocksSolution, _student: BlocksStudent, labels: Labels): Block[] {
  const w = wordsOf(labels);
  const reference = solution.referenceSolution;
  return [
    ...(reference === null || reference.length === 0 ? [] : [code("text", pseudoCode(reference, w))]),
    ...solution.cases.flatMap((c) =>
      warehouse(
        labels,
        w,
        c,
        [labelled(labels, w.battery, String(c.battery)), pointsOf(labels, c.points), ...(c.visible ? [] : [w.hidden])].join(" · "),
        trailOn(reference, c),
      ),
    ),
  ];
}

/** The breakdown a student may read: `studentDetails` already kept a hidden warehouse to its verdict. */
const ReadableDetails = z.object({
  cases: z.array(z.object({ name: z.string(), points: z.number(), ok: z.boolean(), reason: RunReasonSchema })),
});

const REASON_WORD = {
  dock: "reasonDock",
  collision: "reasonCollision",
  battery: "reasonBattery",
  loop: "reasonLoop",
  short: "reasonShort",
} as const satisfies Record<z.infer<typeof RunReasonSchema>, keyof BlocksPaperWords>;

/** The student's own program as pseudo-code, and each warehouse's verdict when the policy shows one. */
export function blocksStudentAnswerDoc(_student: BlocksStudent, answer: BlocksAnswer, details: unknown, labels: Labels): Block[] {
  const w = wordsOf(labels);
  const breakdown = ReadableDetails.safeParse(details);
  return [
    noAnswerOr(labels, answer.program.length === 0, code("text", pseudoCode(answer.program, w))),
    ...(breakdown.success && breakdown.data.cases.length > 0
      ? [
          table(
            [w.colWarehouse, w.colResult, labels.points],
            breakdown.data.cases.map((c) => [c.name, w[REASON_WORD[c.reason]], `${number(c.ok ? c.points : 0)} / ${number(c.points)}`]),
          ),
        ]
      : []),
  ];
}
