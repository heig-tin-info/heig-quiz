/**
 * `@quiz/qt-circuit/client` — the browser half of the `circuit` question type.
 *
 * The three surfaces are `React.lazy`, so the canvas (its symbol table, its
 * router, its plot) stays out of the initial bundle (N-PERF-05). The icon is
 * inline SVG rather than a `lucide-react` import: a package must not drag a
 * second icon set into the app's bundle to draw one glyph.
 */
import { lazy } from "react";

import type { QuestionTypeClient } from "@quiz/core/client";

import { LIBRARY } from "./library.js";
import type {
  CircuitAnswer,
  CircuitConfig,
  CircuitDetails,
  CircuitSolution,
  CircuitStudent,
} from "./schema.js";

/**
 * The two-port box with one part inside it: what the student is asked to
 * fill, drawn at 24 px. Not a resistor alone — every other type's icon says
 * what the ANSWER is, and here the answer is the box, not the component.
 */
function CircuitIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* The box, its four ports, and ONE part inside it. The part is a plain
          rectangle rather than a zigzag: at 16 px a resistor's teeth are
          noise, and what the glyph has to say is "a box you fill". */}
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <path d="M1 8h4M1 16h4M19 8h4M19 16h4" />
      <path d="M8 12h1.5M14.5 12H16" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    </svg>
  );
}

export const circuitClient: QuestionTypeClient<
  CircuitConfig,
  CircuitAnswer,
  CircuitStudent,
  CircuitSolution,
  CircuitDetails
> = {
  id: "circuit",
  labelKey: "qt.circuit.label",
  hintKey: "qt.circuit.hint",
  Icon: CircuitIcon,

  Editor: lazy(() => import("./Editor.js")),
  Player: lazy(() => import("./Player.js")),
  Review: lazy(() => import("./Review.js")),

  /** An empty box. Nothing is seeded: the student draws everything. */
  emptyAnswer() {
    return { schematic: { components: [], wires: [] } };
  },

  isAnswered(answer) {
    if (answer === null) return false;
    return answer.schematic.components.length > 0 || answer.schematic.wires.length > 0;
  },

  /**
   * The budget, which is the one number a teacher scanning the dashboard can
   * read without opening the drawing: a box with nine of ten parts and a box
   * with none are two different situations.
   */
  summarize(answer, student) {
    if (answer === null) return "—";
    const counted = answer.schematic.components.filter((c) => !LIBRARY[c.kind].terminal).length;
    if (counted === 0 && answer.schematic.wires.length === 0) return "—";
    return `${counted}/${student.palette.maxComponents}`;
  },
};

export { CircuitIcon };

/*
 * The PURE things a host may need, and nothing else: the netlist extractor
 * behind the player's diagnostics strip, the parser behind its plots, the
 * component table and the engineering-notation pair. They are plain
 * functions, so they cost the bundle nothing and stay out of the lazy chunks.
 */
export { extractNets } from "./netlist.js";
export type { NetlistIssue } from "./netlist.js";
export { parseSimulation } from "./grade.js";
export type { SimulationResult } from "./grade.js";
export { COMPONENT_KINDS, LIBRARY, formatValue, parseValue, valueIssue } from "./library.js";
export type { ComponentKind, ComponentSpec, PortId } from "./library.js";
export { emptyCircuitConfig, emptyStimulus, EMPTY_SCHEMATIC } from "./schema.js";
export type {
  Analysis,
  CircuitAnswer,
  CircuitConfig,
  CircuitDetails,
  CircuitSolution,
  CircuitStudent,
  Load,
  Schematic,
  SeriesSet,
  Source,
  Stimulus,
  StimulusDetail,
  StudentStimulus,
} from "./schema.js";

/*
 * The three surfaces are deliberately NOT re-exported here: a static
 * `export ... from "./Editor.js"` would pull them (and the whole canvas) back
 * into whatever imports this module, undoing the `lazy` above. A host that
 * genuinely needs one imports the file directly.
 */
export type { CircuitEditorProps, CircuitTryOutcome } from "./Editor.js";
export type { CircuitPlayerProps, CircuitSimulateOutcome } from "./Player.js";
export type { CircuitReviewProps } from "./Review.js";
export {
  CANVAS_STRINGS,
  EDITOR_STRINGS,
  KIND_LABELS,
  PLAYER_STRINGS,
  REVIEW_STRINGS,
  withStrings,
  type CanvasStrings,
  type CircuitEditorStrings,
  type CircuitPlayerStrings,
  type CircuitReviewStrings,
  type KindLabels,
} from "./strings.js";
