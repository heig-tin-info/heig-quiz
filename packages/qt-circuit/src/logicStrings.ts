/**
 * UI strings of the `logic` surfaces, English by default; the host fills the
 * French from its dictionary (N-I18N-01), as for `circuit` (`strings.ts`).
 *
 * Six dictionaries reach the host: the editor's (`qt.logic.e.*`), the
 * player's (`qt.logic.p.*`), the review's (`qt.logic.r.*`), the debrief
 * key's (`qt.logic.k.*`), the grading column's (`qt.logic.g.*`) and the
 * kinds' (`qt.logic.kind.*`), which the canvas reads through its `kind`
 * function. The canvas's own words are `circuit`'s (`qt.circuit.c.*`).
 */
import { fmt } from "@quiz/core/client";

import { LOGIC_PARTS } from "./logicLibrary.js";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const LOGIC_KIND_STRINGS = {
  AND: "AND",
  OR: "OR",
  NAND: "NAND",
  NOR: "NOR",
  XOR: "XOR",
  XNOR: "XNOR",
  NOT: "NOT",
  BUF: "Buffer",
  SR: "SR latch",
  DLATCH: "D latch",
  DFF: "D flip-flop",
  JKFF: "JK flip-flop",
  TFF: "T flip-flop",
  /** A variadic gate on the canvas: its family and its fan-in. */
  gate: "{gate}, {n} inputs",
  LOW: "Constant 0",
  HIGH: "Constant 1",
  IN: "Input",
  OUT: "Output",
};

export type LogicKindStrings = typeof LOGIC_KIND_STRINGS;

/** The canvas's word for a kind: `AND, 3 inputs`, `NOT`, `Input`. */
export function logicKindLabel(kind: string, s: LogicKindStrings): string {
  const spec = LOGIC_PARTS.part(kind);
  if (spec.family === null) return s[kind as "LOW" | "HIGH" | "IN" | "OUT"];
  return spec.width > 1 ? fmt(s.gate, { gate: s[spec.family], n: spec.width }) : s[spec.family];
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export const LOGIC_EDITOR_STRINGS = {
  questionSection: "Question",
  prompt: "Statement",

  mode: "Specification",
  modeCombinational: "Combinational",
  modeSequential: "Sequential",

  symbols: "Symbols",
  symbolsIec: "IEC 60617",
  symbolsAnsi: "ANSI",

  inputs: "Inputs",
  inputsHint: "A letter, then letters, digits or _, 6 characters at most.",
  input: "Input {n}",
  addInput: "Add an input",
  removeInput: "Remove input {name}",

  outputs: "Outputs",
  outputsHint: "AND: * or &. OR: + or |. NOT: ~ before or ' after. XOR: ^. Constants 0 and 1.",
  outputName: "Output {n}",
  expression: "Expression of {name}",
  addOutput: "Add an output",
  removeOutput: "Remove output {name}",
  expressionInvalid: "Unreadable from character {n}.",
  expressionUnreadable: "Unreadable expression.",
  unknownIdentifier: "Unknown input at character {n}.",

  vectors: "Test vectors",
  vectorsHint:
    "First line: every input and output. Then one step per line. Input: 0, 1 or C for a clock pulse. Output: 0, 1 or X for don't care. Flip-flops start at 0.",
  vectorEmpty: "Write the header, then at least one step that checks an output.",
  vectorTooLong: "Too long: at most {rows} steps.",
  vectorHeader: "Line {line}: name every input and output once.",
  vectorColumns: "Line {line}: one value per column.",
  vectorValue: "Line {line}: inputs take 0, 1 or C, outputs 0, 1 or X.",

  palette: "Gates",
  paletteHint: "The gates and flip-flops students may place. Constants 0 and 1 are always offered.",
  paletteEmpty: "Allow at least one gate.",
  maxGates: "Gate limit",
  maxGatesHint: "Empty: up to {max} gates.",

  scoring: "Scoring",
  scoringHint: "Every input combination is simulated. The points follow the share of rows with every output right.",
  scoringHintSequential:
    "The steps run in order on the student's circuit. The points follow the share of steps with every checked output right.",
};

export type LogicEditorStrings = typeof LOGIC_EDITOR_STRINGS;

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export const LOGIC_PLAYER_STRINGS = {
  schematic: "Your circuit",
  expand: "Expand",
  expandHint: "Expand the circuit to draw.",
  expanded: "The circuit is open over the page.",
  gates: "{n} / {max} gates",
  "gates.one": "1 / {max} gate",

  mode: "Mode",
  draw: "Draw",
  play: "Play",
  playHint: "Switch an input to see what your circuit computes.",
  inputs: "Inputs",
  outputs: "Outputs",
  /** One input's toggle: its name and its level. */
  toggle: "{name} = {value}",
  /** Back to the initial state: inputs and flip-flops at 0. */
  reset: "Reset",
};

export type LogicPlayerStrings = typeof LOGIC_PLAYER_STRINGS;

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export const LOGIC_REVIEW_STRINGS = {
  score: "{points} / {max} points",
  yourCircuit: "The circuit",
  noAnswer: "Not answered.",
  rightRows: "Right rows: {right} / {total}",
  output: "Output",
  rate: "Right",
  percent: "{percent} %",
  expressions: "Expected expressions",
  vectors: "Test vectors",
  failing: "Failing rows",
  failingFirst: "The first {n} failing rows.",
  expectedOf: "{name} expected",
  reasonPortsMismatch: "The inputs and outputs differ from the question's. The teacher grades this answer.",
  reasonPaletteViolation: "The circuit uses gates the question does not allow. The teacher grades this answer.",
};

export type LogicReviewStrings = typeof LOGIC_REVIEW_STRINGS;

/** The debrief's answer key (ADR-109): the expressions, or their hidden block. */
export const LOGIC_KEY_STRINGS = {
  expressions: "Expected expressions",
  hidden: "Expected expressions, hidden until the answers are revealed",
  vectors: "Test vectors",
  vectorsHidden: "Test vectors, hidden until the answers are revealed",
};

export type LogicKeyStrings = typeof LOGIC_KEY_STRINGS;

/** The grading table's one column (ADR-044): what the circuit holds and how many rows it got right. */
export const LOGIC_GRADING_STRINGS = {
  schematic: "Circuit",
  gates: "{n} gates",
  "gates.one": "1 gate",
  wires: "{n} wires",
  "wires.one": "1 wire",
  rows: "{right}/{total} rows",
};

export type LogicGradingStrings = typeof LOGIC_GRADING_STRINGS;
