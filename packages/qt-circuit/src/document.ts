/**
 * The `circuit` question as blocks of a printed or exported document
 * (ADR-121 §2, ADR-125, ADR-126).
 *
 * The statement and the paper frame are drawn from the student view only:
 * the prompt, the parts the student may place, the supplies, the ground, the
 * visible stimuli and the count and worth of the hidden ones — never their
 * content. The frame is a squared `free` zone, one ruling line per editor
 * grid line, under the empty box and its four ports, drawn from the library's
 * constants alone (ADR-126 §4, §6). The key is the reference schematic as a
 * figure; a student's answer is their own schematic, drawn the same way.
 */
import { labelled, list, markdown, number, table, type Block, type Labels } from "@quiz/docexport";

import { CIRCUIT_LIBRARY } from "./canvas/circuitLibrary.js";
import { canvasZone, drawnAnswer, paletteBlock, schematicBlock } from "./canvas/paper.js";
import { formatValue, offeredKinds } from "./library.js";
import {
  biasOf,
  EMPTY_SCHEMATIC,
  type CircuitAnswer,
  type CircuitConfig,
  type CircuitSolution,
  type CircuitStudent,
  type StudentStimulus,
} from "./schema.js";

const hz = (value: number) => `${formatValue(value)}Hz`;

/** What drives the box, as the player words it: `Sine 1 V, 1kHz`. */
function sourceText(stimulus: StudentStimulus, l: Labels): string {
  const { source, analysis } = stimulus;
  const text = (() => {
    if (analysis.kind === "ac") return `${l.circuitBias} ${formatValue(biasOf(source))} V`;
    switch (source.kind) {
      case "dc":
        return `${l.circuitDc} ${formatValue(source.volts)} V`;
      case "sine":
        return `${l.circuitSine} ${formatValue(source.amplitude)} V, ${hz(source.frequencyHz)}${source.offset === 0 ? "" : `, + ${formatValue(source.offset)} V`}`;
      case "pulse":
        return `${l.circuitPulse} ${formatValue(source.low)} → ${formatValue(source.high)} V, ${hz(source.frequencyHz)}`;
      case "step":
        return `${l.circuitStep} ${formatValue(source.from)} → ${formatValue(source.to)} V, ${formatValue(source.atMs)} ms`;
    }
  })();
  return stimulus.sourceOhms > 0 ? `${text}, Rs = ${formatValue(stimulus.sourceOhms)} Ω` : text;
}

function loadText(stimulus: StudentStimulus, l: Labels): string {
  const { load } = stimulus;
  switch (load.kind) {
    case "open":
      return l.circuitOpen;
    case "resistor":
      return `${formatValue(load.ohms)} Ω`;
    case "capacitor":
      return `${formatValue(load.farads)}F`;
  }
}

function analysisText(stimulus: StudentStimulus): string {
  const { analysis } = stimulus;
  return analysis.kind === "ac" ? `Bode ${hz(analysis.fStartHz)} → ${hz(analysis.fStopHz)}` : `${formatValue(analysis.stopMs)} ms`;
}

/** The prompt, what the student may place and how the box is powered, then how it is tested. */
export function circuitStatementDoc(student: CircuitStudent, labels: Labels): Block[] {
  const kinds = offeredKinds(student.palette, student.supplies);
  const supplies = [
    ...(student.supplies.vcc === null ? [] : [`VCC = ${formatValue(student.supplies.vcc)} V`]),
    ...(student.supplies.vee === null ? [] : [`VEE = ${formatValue(student.supplies.vee)} V`]),
  ];
  const facts = [
    labelled(labels, labels.circuitParts, kinds.join(", ")),
    labelled(labels, labels.circuitMaxParts, String(student.palette.maxComponents)),
    ...(supplies.length === 0 ? [] : [labelled(labels, labels.circuitSupplies, supplies.join(", "))]),
    student.commonGround ? labels.circuitCommonGround : labels.circuitSeparateGround,
  ];
  const stimuli = student.visibleStimuli;
  return [
    markdown(student.prompt),
    list(facts),
    paletteBlock(
      kinds.map((kind) => ({ kind, code: kind })),
      CIRCUIT_LIBRARY,
      labels.circuitParts,
    ),
    ...(stimuli.length === 0
      ? []
      : [
          markdown(`**${labels.circuitStimuli}**`),
          table(
            [labels.name, labels.circuitSource, labels.circuitLoad, labels.circuitAnalysis, labels.points],
            stimuli.map((s) => [s.name, sourceText(s, labels), loadText(s, labels), analysisText(s), number(s.points)]),
          ),
        ]),
    ...(student.hiddenCount === 0
      ? []
      : [
          markdown(
            labelled(labels, labels.circuitHidden, `${student.hiddenCount} (${number(student.hiddenPoints)} ${labels.pointsShort})`),
          ),
        ]),
  ];
}

/** The empty box and its four ports, under a squared frame of the box's size and a cell's margin. */
export function circuitAnswerZone(_student: CircuitStudent): Block[] {
  return [canvasZone(EMPTY_SCHEMATIC, CIRCUIT_LIBRARY)];
}

/** The reference schematic, drawn; nothing when the question has none. */
export function circuitSolutionDoc(solution: CircuitSolution, _student: CircuitStudent, labels: Labels): Block[] {
  return solution.reference === null ? [] : [schematicBlock(solution.reference, CIRCUIT_LIBRARY, labels)];
}

/** An answer's schematic, drawn as the student left it, worded by `labels`. */
const answerBlock = ({ schematic }: CircuitAnswer, labels: Labels): Block =>
  drawnAnswer(schematic, CIRCUIT_LIBRARY, labels, schematic.components.length === 0 && schematic.wires.length === 0);

/** The student's own schematic. The simulation's breakdown is read in Quiz. */
export function circuitStudentAnswerDoc(_student: CircuitStudent, answer: CircuitAnswer, _details: unknown, labels: Labels): Block[] {
  return [answerBlock(answer, labels)];
}

/** The staff's reading: the schematic as drawn. */
export function circuitAnswerDoc(_config: CircuitConfig, answer: CircuitAnswer, _details: unknown, labels: Labels): Block[] {
  return [answerBlock(answer, labels)];
}
