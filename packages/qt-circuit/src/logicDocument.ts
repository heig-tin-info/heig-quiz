/**
 * The `logic` question as blocks of a printed or exported document
 * (ADR-121 §2, ADR-125, ADR-126).
 *
 * The statement and the paper frame read the student view only: the prompt,
 * the declared inputs and outputs, the allowed gate families in the
 * question's symbols, the gate budget — never an expression, a vector nor
 * the reference, which `toStudent` does not carry. The frame is squared, the
 * declared terminals drawn grey where the editor starts them
 * (`initialTerminals`). The key is each output's equation, the test vectors
 * as a table, or the reference circuit drawn.
 */
import { parseVectors } from "@quiz/domain/logic";
import { code, labelled, list, markdown, table, type Block, type Labels } from "@quiz/docexport";

import { logicLibrary } from "./canvas/logicLibrary.js";
import { canvasZone, drawnAnswer, paletteBlock, schematicBlock } from "./canvas/paper.js";
import { initialTerminals, LOGIC_KINDS, type GateFamily } from "./logicLibrary.js";
import {
  expressionLatex,
  isLogicAnswered,
  type LogicAnswer,
  type LogicConfig,
  type LogicSolution,
  type LogicStudent,
} from "./logicSchema.js";

/** A family's symbol on the palette: its two-input gate, or the part itself. */
const kindOf = (family: GateFamily): string =>
  (LOGIC_KINDS as readonly string[]).includes(`${family}2`) ? `${family}2` : family;

/** The prompt, the declared signals, the symbols and what the student may place. */
export function logicStatementDoc(student: LogicStudent, labels: Labels): Block[] {
  const families = student.palette.kinds;
  const facts = [
    labelled(labels, labels.logicInputs, student.inputs.join(", ")),
    labelled(labels, labels.logicOutputs, student.outputs.join(", ")),
    labelled(labels, labels.symbols, student.symbols === "ansi" ? "ANSI" : "IEC 60617"),
    labelled(labels, labels.logicGates, families.join(", ")),
    ...(student.palette.maxGates === null ? [] : [labelled(labels, labels.logicMaxGates, String(student.palette.maxGates))]),
  ];
  return [
    markdown(student.prompt),
    list(facts),
    paletteBlock(
      families.map((family) => ({ kind: kindOf(family), code: family })),
      logicLibrary(student.symbols),
      labels.logicGates,
    ),
  ];
}

/** A squared frame, the declared terminals drawn grey where the editor starts them. */
export function logicAnswerZone(student: LogicStudent): Block[] {
  return [canvasZone({ components: initialTerminals(student.inputs, student.outputs), wires: [] }, logicLibrary(student.symbols))];
}

/** The vectors as a table, the header first, or as typed when they no longer parse. */
function vectorsBlock(source: string, student: LogicStudent): Block {
  try {
    const vectors = parseVectors(source, { inputs: student.inputs, outputs: student.outputs });
    return table(
      [...vectors.inputs, ...vectors.outputs],
      vectors.rows.map((row) => [...row.inputs, ...row.outputs].map(String)),
    );
  } catch {
    return code("text", source);
  }
}

/** Each output's equation, the test vectors, or the reference circuit drawn. */
export function logicSolutionDoc(solution: LogicSolution, student: LogicStudent, labels: Labels): Block[] {
  const equations = solution.outputs.map(({ name, expression }) => {
    const latex = expressionLatex(name, expression, student.inputs);
    return latex === null ? code("text", `${name} = ${expression}`) : markdown(`$$${latex}$$`);
  });
  return [
    ...equations,
    ...(solution.vectors === undefined ? [] : [markdown(`**${labels.logicVectors}**`), vectorsBlock(solution.vectors, student)]),
    ...(solution.reference === undefined
      ? []
      : [schematicBlock(solution.reference, logicLibrary(student.symbols), labels)]),
  ];
}

/** An answer's circuit, drawn as the student left it in the question's symbols. */
const answerBlock = (answer: LogicAnswer, symbols: LogicStudent["symbols"], labels: Labels): Block =>
  drawnAnswer(answer.schematic, logicLibrary(symbols), labels, !isLogicAnswered(answer));

/** The student's own circuit. The truth table's breakdown is read in Quiz. */
export function logicStudentAnswerDoc(student: LogicStudent, answer: LogicAnswer, _details: unknown, labels: Labels): Block[] {
  return [answerBlock(answer, student.symbols, labels)];
}

/** The staff's reading: the circuit as drawn. */
export function logicAnswerDoc(config: LogicConfig, answer: LogicAnswer, _details: unknown, labels: Labels): Block[] {
  return [answerBlock(answer, config.symbols, labels)];
}
