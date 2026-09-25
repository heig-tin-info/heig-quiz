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
import { isCircuitAnswered } from "./schema.js";

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

  isAnswered: (answer) => answer !== null && isCircuitAnswered(answer),

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
 * The component table and the engineering-notation pair: `summarize` above
 * already puts `library.js` in this module's graph, so naming them here costs
 * the bundle nothing.
 *
 * `extractNets` and `parseSimulation` are NOT re-exported, and neither are the
 * `schema.js` builders. A static `export … from` of a VALUE is an edge, and
 * this module is reached from every page through `@quiz/registry/client`: the
 * four lines that used to sit here dragged `netlist.ts`, `grade.ts`,
 * `spice.ts` and `schema.ts` — the whole grading path, and zod with it — into
 * the initial chunk of a quiz that may hold no circuit at all (N-PERF-05).
 * The lazy `Player` imports both functions directly; a host that grades reads
 * them from `@quiz/qt-circuit/server`, which is where ADR-019 §3 puts the
 * netlist anyway.
 */
export type { NetlistIssue } from "./netlist.js";
export type { SimulationResult } from "./grade.js";
export { COMPONENT_KINDS, LIBRARY, formatValue, parseValue, valueIssue } from "./library.js";
export type { ComponentKind, ComponentSpec, PortId } from "./library.js";
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
export type { CircuitSimulateOutcome } from "./Player.js";
export {
  CANVAS_STRINGS,
  EDITOR_STRINGS,
  KIND_LABELS,
  PLAYER_STRINGS,
  REVIEW_STRINGS,
  type CanvasStrings,
  type CircuitEditorStrings,
  type CircuitPlayerStrings,
  type CircuitReviewStrings,
  type KindLabels,
} from "./strings.js";
