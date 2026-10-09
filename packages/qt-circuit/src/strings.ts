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

export const EDITOR_STRINGS = {
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

  analysisKind: "Analysis",
  analysisTran: "Waveform",
  analysisAc: "Bode plot",
  acHint:
    "A Bode plot linearises the circuit around its DC bias: a saturated op-amp or an unbiased diode gives a meaningless one. A sharp resonance built with non-standard values may also miss the envelope.",
  bias: "Bias (V)",
  analysis: "Transient",
  stopMs: "Stop (ms)",
  skipMs: "Skip (ms)",
  samples: "Samples",
  sweep: "Frequency sweep",
  fStartHz: "From (Hz)",
  fStopHz: "To (Hz)",
  pointsPerDecade: "Points per decade",
  hidden: "Hidden",
  points: "Points",

  reference: "Reference circuit",
  referenceHint:
    "Your own answer, inside the same box: what a simulated grade compares against. Students may receive it when the evaluation shows the expected answer.",
  expand: "Expand",
  expanded: "The circuit is open over the page.",
  tryReference: "Simulate the reference",
  trying: "Simulating…",
  tryUnavailable: "The runner is unavailable, so the reference cannot be simulated right now.",
  tryFailed: "The reference circuit could not be simulated. Check its wiring and its values.",
  tryNeedsReference: "Draw the reference circuit first.",
  tryNeedsStimulus: "Add a stimulus first: there is nothing to simulate the circuit with.",
  tryInvalidDraft: "The question has errors, flagged on this page. Fix them, then simulate.",
  tryDone: "{n} stimuli simulated.",
  "tryDone.one": "1 stimulus simulated.",

  grading: "Grading",
  modeManual: "You",
  modeSimulation: "Simulation",
  modeManualHint: "You look at the circuit and give the marks yourself.",
  modeSimulationHint:
    "Every stimulus is simulated on both circuits and the output waveforms are compared.",
  tolerance: "Tolerance",
  toleranceHint:
    "A stimulus passes when the distance to the reference output stays under this share of its swing.",
  bodeMagDb: "Gain tolerance (dB)",
  bodeFloorDb: "Floor (dB below the peak)",
  bodePhase: "Compare the phase",
  bodePhaseDeg: "Phase tolerance (°)",
  bodeHint:
    "A Bode plot passes when the gain stays within the tolerance of the reference at every frequency, and the phase too when it is compared. Below the floor the output only has to stay low.",
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

export type CircuitEditorStrings = typeof EDITOR_STRINGS;

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export const PLAYER_STRINGS = {
  schematic: "Your circuit",
  expand: "Expand",
  expandHint: "Expand the circuit to draw.",
  expanded: "The circuit is open over the page.",
  components: "{n} / {max} components",
  complete: "Everything is connected.",

  /** The netlist diagnostics, one sentence per `NetlistIssue.code`. */
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
  sweep: "Bode {from} → {to}",
  srcBias: "bias {volts} V",

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

export type CircuitPlayerStrings = typeof PLAYER_STRINGS;

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export const REVIEW_STRINGS = {
  score: "{points} / {max} points",
  yourCircuit: "The circuit",
  reference: "Reference circuit",
  noAnswer: "Not answered.",
  noReference: "No reference circuit.",

  diagnostics: "What the netlist read",
  netSummary: "Components: {components} · Nets: {nets}",
  noIssues: "No problem found in the wiring.",
  /*
   * The netlist diagnostics again, worded for someone reading the answer back
   * rather than for the student still drawing it. Duplicated on purpose, as
   * `qt-code` duplicates its verdicts between the player and the review: two
   * audiences, two tenses, and a shared dictionary would have to pick one.
   */
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
  /** An AC stimulus's error: the worst gap to the reference's Bode plot. */
  envelopeGap: "{db} dB",
  envelopeGapPhase: "{db} dB · {deg}°",
  reason: "Reason",
  reasonNotSimulated: "Not simulated",
  reasonSpiceFailed: "The simulator refused this circuit",
  reasonTimeout: "The simulation ran out of time",
  reasonNetlist: "The circuit could not be turned into a netlist",
  reasonOther: "Not comparable",
  log: "Simulator output",

  manualGrade: "This circuit is graded by the teacher.",
  runnerUnavailable: "The simulator was unavailable; this answer is waiting for a manual grade.",
  runnerBusy: "The simulator was busy; this answer is waiting for a manual grade.",
  runnerError: "The circuit could not be simulated; it is waiting for a manual grade.",
  runnerNone: "This circuit was not simulated.",
};

export type CircuitReviewStrings = typeof REVIEW_STRINGS;

/**
 * The words of the grading table's one circuit column (ADR-044): what the
 * schematic holds, and how its simulation went. The drawing itself stays
 * in the answer panel.
 */
export const GRADING_STRINGS = {
  schematic: "Schematic",
  parts: "{n} parts",
  "parts.one": "1 part",
  wires: "{n} wires",
  "wires.one": "1 wire",
  /** The stimuli passed, out of all of them. */
  stimuli: "{passed}/{total} stimuli",
  "stimuli.one": "{passed}/{total} stimulus",
  /** The chip's tooltip when some failed: `{names}` lists them. */
  failed: "Failed: {names}",
  /** Not simulated, and the netlist read problems in the wiring. */
  issues: "{n} wiring problems",
  "issues.one": "1 wiring problem",
  /** No verdict yet: the simulator owes it. */
  atSimulator: "simulator…",
  notSimulated: "Not simulated",
};

export type CircuitGradingStrings = typeof GRADING_STRINGS;
