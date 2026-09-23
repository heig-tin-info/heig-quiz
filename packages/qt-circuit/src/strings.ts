/**
 * UI strings of the `circuit` surfaces, English by default.
 *
 * A package cannot reach `apps/web`'s `t()` (invariant 1: a `qt-*` package
 * never imports the app), so every component takes a `strings` prop that the
 * host fills from its own dictionary — which is where the French entries live
 * (N-I18N-01). The defaults below exist so a component is usable, and
 * testable, alone.
 *
 * A parameterised sentence is a TEMPLATE filled by `fmt` from
 * `@quiz/core/client` (`"Stimulus {n}"`), never a function: the host's `t()`
 * uses the same `{var}` syntax, so it translates these entries key by key
 * like any other. A count-dependent sentence has a `<key>.one` sibling, used
 * for 1.
 *
 * Four dictionaries reach the host: the editor's (`qt.circuit.e.*`), the
 * player's (`qt.circuit.p.*`), the review's (`qt.circuit.r.*`) and the
 * canvas's (`qt.circuit.c.*`, owned by `./canvas`). The component KINDS are a
 * fifth, keyed by `ComponentKind` rather than by sentence, because the same
 * twelve words label a palette chip, a symbol and a diagnostic.
 */
import { COMPONENT_KINDS, LIBRARY, type ComponentKind } from "./library.js";

/*
 * The canvas ships its own English dictionary; it travels through here so a
 * host wires ONE import per surface and `questionTypes.test.tsx` walks one
 * list. Nothing is re-worded on the way.
 */
export { CANVAS_STRINGS } from "./canvas/index.js";
export type { CanvasStrings } from "./canvas/index.js";

// ---------------------------------------------------------------------------
// Component kinds
// ---------------------------------------------------------------------------

/**
 * The label of every component kind, in one dictionary the three surfaces
 * share. The defaults are `LIBRARY[kind].label` — the library is where a new
 * kind is declared, so a kind added there cannot be forgotten here.
 */
export type KindLabels = Readonly<Record<ComponentKind, string>>;

export const KIND_LABELS: KindLabels = Object.fromEntries(
  COMPONENT_KINDS.map((kind) => [kind, LIBRARY[kind].label]),
) as KindLabels;

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export interface CircuitEditorStrings {
  questionSection: string;
  prompt: string;

  palette: string;
  paletteHint: string;
  groupPassive: string;
  groupDiodes: string;
  groupTransistors: string;
  groupOpamp: string;
  groupTerminals: string;
  maxComponents: string;
  maxComponentsHint: string;
  paletteEmpty: string;

  supplies: string;
  suppliesHint: string;
  vcc: string;
  vee: string;
  supplyNone: string;

  stimuli: string;
  stimuliHint: string;
  stimulus: string;
  stimulusName: string;
  addStimulus: string;
  removeStimulus: string;
  noStimuli: string;
  totalPoints: string;
  "totalPoints.one": string;

  source: string;
  sourceDc: string;
  sourceSine: string;
  sourcePulse: string;
  sourceStep: string;
  volts: string;
  amplitude: string;
  frequency: string;
  offset: string;
  low: string;
  high: string;
  dutyCycle: string;
  stepFrom: string;
  stepTo: string;
  stepAt: string;
  sourceOhms: string;

  load: string;
  loadOpen: string;
  loadResistor: string;
  loadCapacitor: string;
  loadOhms: string;
  loadFarads: string;

  analysis: string;
  stopMs: string;
  skipMs: string;
  samples: string;
  hidden: string;
  points: string;

  reference: string;
  referenceHint: string;
  tryReference: string;
  trying: string;
  tryUnavailable: string;
  tryFailed: string;
  tryNeedsReference: string;
  tryNeedsStimulus: string;
  tryDone: string;
  "tryDone.one": string;

  grading: string;
  modeManual: string;
  modeSimulation: string;
  modeLlm: string;
  modeManualHint: string;
  modeSimulationHint: string;
  modeLlmHint: string;
  tolerance: string;
  toleranceHint: string;
  rubric: string;
  rubricHint: string;
  showExpected: string;
  showExpectedHint: string;

  advanced: string;
  commonGround: string;
  commonGroundHint: string;
  simulationsPerMinute: string;
  simulationsPerMinuteHint: string;
}

export const EDITOR_STRINGS: CircuitEditorStrings = {
  questionSection: "Question",
  prompt: "Statement",

  palette: "Palette",
  paletteHint: "What the student may place inside the box. Press a component to offer it.",
  groupPassive: "Passive",
  groupDiodes: "Diodes",
  groupTransistors: "Transistors",
  groupOpamp: "Op-amp",
  groupTerminals: "Terminals",
  maxComponents: "Component budget",
  maxComponentsHint: "How many parts the student may place. Grounds and supply rails do not count.",
  paletteEmpty: "Offer at least one component.",

  supplies: "Supplies",
  suppliesHint: "The rails the palette offers. Leave a field empty to hide its symbol.",
  vcc: "VCC (V)",
  vee: "VEE (V)",
  supplyNone: "none",

  stimuli: "Stimuli",
  stimuliHint:
    "What drives the input and what hangs on the output. A hidden stimulus is graded but never shown, exactly like a hidden test case.",
  stimulus: "Stimulus {n}",
  stimulusName: "Name",
  addStimulus: "Add a stimulus",
  removeStimulus: "Remove the stimulus {name}",
  noStimuli: "No stimulus yet. Without one the circuit can only be graded by hand.",
  totalPoints: "{n} points in total",
  "totalPoints.one": "1 point in total",

  source: "Source",
  sourceDc: "DC",
  sourceSine: "Sine",
  sourcePulse: "Pulse",
  sourceStep: "Step",
  volts: "Volts",
  amplitude: "Amplitude (V)",
  frequency: "Frequency (Hz)",
  offset: "Offset (V)",
  low: "Low (V)",
  high: "High (V)",
  dutyCycle: "Duty cycle",
  stepFrom: "From (V)",
  stepTo: "To (V)",
  stepAt: "At (ms)",
  sourceOhms: "Series resistance (Ω)",

  load: "Load",
  loadOpen: "Open",
  loadResistor: "Resistor",
  loadCapacitor: "Capacitor",
  loadOhms: "Load (Ω)",
  loadFarads: "Load (F)",

  analysis: "Transient",
  stopMs: "Stop (ms)",
  skipMs: "Skip (ms)",
  samples: "Samples",
  hidden: "Hidden",
  points: "Points",

  reference: "Reference circuit",
  referenceHint:
    "Your own answer, inside the same box. It is what a simulated grade compares against, and a student never sees it — in any view.",
  tryReference: "Simulate the reference",
  trying: "Simulating…",
  tryUnavailable: "The runner is unavailable, so the reference cannot be simulated right now.",
  tryFailed: "The reference circuit could not be simulated. Check its wiring and its values.",
  tryNeedsReference: "Draw the reference circuit first.",
  tryNeedsStimulus: "Add a stimulus first: there is nothing to simulate the circuit with.",
  tryDone: "{n} stimuli simulated.",
  "tryDone.one": "1 stimulus simulated.",

  grading: "Grading",
  modeManual: "You",
  modeSimulation: "Simulation",
  modeLlm: "Assistant",
  modeManualHint: "You look at the circuit and give the marks yourself.",
  modeSimulationHint:
    "Every stimulus is simulated on both circuits and the output waveforms are compared.",
  modeLlmHint: "The circuit and the criteria go to the assistant. Not available yet.",
  tolerance: "Tolerance",
  toleranceHint:
    "A stimulus passes when the distance to the reference output stays under this share of its swing.",
  rubric: "Criteria",
  rubricHint: "What you are looking for, in your own words.",
  showExpected: "Show the expected waveform",
  showExpectedHint: "Overlays the reference output on the student's plot, for the visible stimuli.",

  advanced: "Advanced options",
  commonGround: "in− and out− are the ground",
  commonGroundHint:
    "Off, they become two free nets the student has to wire, and a ground symbol names node 0.",
  simulationsPerMinute: "Simulations per minute",
  simulationsPerMinuteHint: "The budget of the student's Simulate button.",
};

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface CircuitPlayerStrings {
  schematic: string;
  components: string;
  complete: string;

  /** The netlist diagnostics, one sentence per `NetlistIssue.code`. */
  issueFloatingPin: string;
  issueUnconnectedPort: string;
  issueDanglingWire: string;
  issueNoGround: string;
  issueMissingValue: string;
  issueInvalidValue: string;
  issueValueOutOfRange: string;
  issueDuplicateName: string;
  issueTooManyComponents: string;
  issueKindNotAllowed: string;

  stimuli: string;
  noStimuli: string;
  hiddenStimuli: string;
  "hiddenStimuli.one": string;
  srcDc: string;
  srcSine: string;
  srcPulse: string;
  srcStep: string;
  loadOpen: string;
  loadResistor: string;
  loadCapacitor: string;
  window: string;

  simulate: string;
  simulating: string;
  simulateHint: string;
  simulateUnavailable: string;
  simulateRateLimited: string;
  simulateFailed: string;
  simulateNothing: string;

  plot: string;
  noSeries: string;
}

export const PLAYER_STRINGS: CircuitPlayerStrings = {
  schematic: "Your circuit",
  components: "{n} / {max} components",
  complete: "Everything is connected.",

  issueFloatingPin: "{ref} is not connected.",
  issueUnconnectedPort: "The {ref} port is not connected.",
  issueDanglingWire: "A wire ends in the air ({ref}).",
  issueNoGround: "Nothing is connected to the ground.",
  issueMissingValue: "{ref} has no value.",
  issueInvalidValue: "{ref}: this value cannot be read.",
  issueValueOutOfRange: "{ref}: this value is out of range.",
  issueDuplicateName: "Two components are named {ref}.",
  issueTooManyComponents: "Too many components for this question.",
  issueKindNotAllowed: "{ref} is not in the palette of this question.",

  stimuli: "How your circuit is tested",
  noStimuli: "Your teacher did not publish any stimulus.",
  hiddenStimuli: "{count} hidden stimuli, worth {points} point(s) in total.",
  "hiddenStimuli.one": "1 hidden stimulus, worth {points} point(s).",
  srcDc: "DC {volts} V",
  srcSine: "Sine {amplitude} V @ {frequency}",
  srcPulse: "Pulse {low} → {high} V @ {frequency}",
  srcStep: "Step {from} → {to} V at {atMs} ms",
  loadOpen: "open output",
  loadResistor: "load {value}Ω",
  loadCapacitor: "load {value}F",
  window: "{ms} ms",

  simulate: "Simulate",
  simulating: "Simulating…",
  simulateHint: "Runs the stimuli above. Hidden ones are only run when the question is graded.",
  simulateUnavailable:
    "Simulation is unavailable right now. Your circuit is saved and will still be graded.",
  simulateRateLimited: "Too many simulations in a row. Wait a moment and try again.",
  simulateFailed: "The simulation could not be completed. Your circuit is saved; try again shortly.",
  simulateNothing: "Draw something first: an empty box has nothing to simulate.",

  plot: "Output — {name}",
  noSeries: "This stimulus produced no waveform.",
};

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface CircuitReviewStrings {
  score: string;
  yourCircuit: string;
  reference: string;
  noAnswer: string;
  noReference: string;

  diagnostics: string;
  netSummary: string;
  noIssues: string;
  /*
   * The netlist diagnostics again, worded for someone reading the answer back
   * rather than for the student still drawing it. Duplicated on purpose, as
   * `qt-code` duplicates its verdicts between the player and the review: two
   * audiences, two tenses, and a shared dictionary would have to pick one.
   */
  issueFloatingPin: string;
  issueUnconnectedPort: string;
  issueDanglingWire: string;
  issueNoGround: string;
  issueMissingValue: string;
  issueInvalidValue: string;
  issueValueOutOfRange: string;
  issueDuplicateName: string;
  issueTooManyComponents: string;
  issueKindNotAllowed: string;

  stimuli: string;
  stimulusName: string;
  hiddenStimulus: string;
  points: string;
  verdict: string;
  passed: string;
  failed: string;
  notRun: string;
  error: string;
  errorPercent: string;
  reason: string;
  reasonNotSimulated: string;
  reasonSpiceFailed: string;
  reasonTimeout: string;
  reasonNetlist: string;
  reasonOther: string;
  log: string;

  manualGrade: string;
  llmPending: string;
  runnerUnavailable: string;
  runnerBusy: string;
  runnerError: string;
  runnerNone: string;
}

export const REVIEW_STRINGS: CircuitReviewStrings = {
  score: "{points} / {max} points",
  yourCircuit: "The circuit",
  reference: "Reference circuit",
  noAnswer: "Not answered.",
  noReference: "No reference circuit.",

  diagnostics: "What the netlist read",
  netSummary: "Components: {components} · Nets: {nets}",
  noIssues: "No problem found in the wiring.",
  issueFloatingPin: "{ref} was not connected.",
  issueUnconnectedPort: "The {ref} port was not connected.",
  issueDanglingWire: "A wire ended in the air ({ref}).",
  issueNoGround: "Nothing was connected to the ground.",
  issueMissingValue: "{ref} had no value.",
  issueInvalidValue: "{ref}: this value could not be read.",
  issueValueOutOfRange: "{ref}: this value was out of range.",
  issueDuplicateName: "Two components were named {ref}.",
  issueTooManyComponents: "Too many components for this question.",
  issueKindNotAllowed: "{ref} was not in the palette of this question.",

  stimuli: "Stimuli",
  stimulusName: "Stimulus",
  hiddenStimulus: "#{n}",
  points: "Points",
  verdict: "Verdict",
  passed: "Passed",
  failed: "Failed",
  notRun: "Not run",
  error: "Error",
  errorPercent: "{percent} %",
  reason: "Reason",
  reasonNotSimulated: "Not simulated",
  reasonSpiceFailed: "The simulator refused this circuit",
  reasonTimeout: "The simulation ran out of time",
  reasonNetlist: "The circuit could not be turned into a netlist",
  reasonOther: "Not comparable",
  log: "Simulator output",

  manualGrade: "This circuit is graded by the teacher.",
  llmPending: "This circuit is waiting for the assistant.",
  runnerUnavailable: "The simulator was unavailable; this answer is waiting for a manual grade.",
  runnerBusy: "The simulator was busy; this answer is waiting for a manual grade.",
  runnerError: "The circuit could not be simulated; it is waiting for a manual grade.",
  runnerNone: "This circuit was not simulated.",
};
