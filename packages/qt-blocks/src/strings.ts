/**
 * The English defaults of every string the `blocks` surfaces render
 * (docs/spec/04 §4.17, ADR-103 §9).
 *
 * A component takes a partial override through its `strings` prop
 * (`StringOverrides` in `@quiz/core/client`), so `apps/web` passes the French
 * entries of its own `i18n/` (N-I18N-01) and this package never imports the
 * app. A parameterised sentence is a `{var}` template for `fmt`; a key ending
 * in `.one` is the singular of its sibling (`plural`).
 *
 * Five dictionaries reach the host: the editor's (`qt.blocks.e.*`), the
 * player's (`qt.blocks.p.*`), the review's (`qt.blocks.r.*`), the grading
 * table's (`qt.blocks.g.*`) and the CANVAS's (`qt.blocks.c.*`): the words of
 * the world itself — the block labels, the run's verdicts, the warehouse —
 * which the three surfaces all draw, Blockly's palette included.
 */

/**
 * The world's words. The block labels are interface strings (ADR-103 §9):
 * the bundle turns `{n}`, `{dir}`, `{sensor}` and `{where}` into Blockly's
 * fields, wherever the translation puts them. `blocklyLocale` names the
 * dictionary of Blockly's own interface (its context menu, its keyboard
 * announcements), which ships inside the package.
 */
export const blocksCanvasStrings = {
  blocklyLocale: "en",
  start: "when the robot starts",
  forward: "move forward",
  turn: "turn {dir}",
  turnLeft: "left",
  turnRight: "right",
  repeat: "repeat {n} times",
  repeatUntilDock: "repeat until the dock",
  ifSensor: "if {sensor} {where}",
  else: "else",
  sensorFree: "free",
  sensorBlocked: "blocked",
  whereFront: "ahead",
  whereLeft: "on the left",
  whereRight: "on the right",
  groupMovement: "Movement",
  groupControl: "Control",
  groupSensors: "Sensors",
  kindForward: "Move forward",
  kindTurn: "Turn",
  kindRepeat: "Repeat n times",
  kindRepeatUntilDock: "Repeat until the dock",
  kindIfSensor: "If a sensor reads",
  workspace: "Program",
  loading: "Loading the block editor…",
  unavailable: "The block editor did not load: the program is shown as text, read-only.",
  emptyProgram: "No block under “when the robot starts” yet.",
  codeEmpty: "// no block yet",
  map: "Plan of the warehouse",
  dock: "DOCK",
  reasonDock: "Dock reached",
  reasonCollision: "Collision",
  reasonBattery: "Battery empty",
  reasonLoop: "Endless loop",
  reasonShort: "Stopped short",
  moves: "{n} moves",
  "moves.one": "1 move",
  colCase: "Case",
  colWarehouse: "Warehouse",
  colResult: "Result",
  colVerdict: "Verdict",
  notRun: "Not run",
  hidden: "Hidden",
} as const;
export type BlocksCanvasStringKey = keyof typeof blocksCanvasStrings;
export type BlocksCanvasStrings = Readonly<Record<BlocksCanvasStringKey, string>>;

export const blocksEditorStrings = {
  questionSection: "Question",
  prompt: "Statement",
  toolbox: "Blocks",
  toolboxHint: "The blocks the student's palette offers. The starter and the reference may only use these.",
  starter: "Starter program",
  starterHint: "Preloaded in the student's workspace. Leave it empty to start from nothing.",
  reference: "Reference solution",
  referenceHint:
    "The key: it must reach the dock in every warehouse, hidden ones included, before the question can be published. It grades nothing.",
  checkReference: "Check the reference",
  referenceEmpty: "Assemble the reference first.",
  referenceAllPass: "The reference reaches the dock in every warehouse.",
  referenceFails: "The reference misses {n} warehouses.",
  "referenceFails.one": "The reference misses 1 warehouse.",
  cases: "Warehouses",
  casesHint:
    "Each warehouse is a test case: the program must bring the robot to the dock. A hidden warehouse is graded but never shown, exactly like a hidden test case.",
  case: "Warehouse {n}",
  caseName: "Name",
  caseNameAria: "Name {n}",
  points: "Points",
  pointsAria: "Points {n}",
  battery: "Battery",
  batteryAria: "Battery {n}",
  hidden: "Hidden",
  hiddenAria: "Hidden {n}",
  addCase: "Add a warehouse",
  removeCase: "Remove the warehouse {name}",
  totalPoints: "{n} points in total",
  "totalPoints.one": "1 point in total",
  width: "Width",
  height: "Height",
  tool: "Tool",
  toolRack: "Racks",
  toolStart: "Start",
  toolDock: "Dock",
  toolHint: "Racks: a click adds or removes one. Start: a click places the robot, a click on it turns it. Dock: a click moves the dock.",
  cell: "Column {x}, row {y}: {what}",
  cellFloor: "floor",
  cellRack: "rack",
  cellStart: "start, facing {heading}",
  cellDock: "dock",
  headingNorth: "up",
  headingEast: "right",
  headingSouth: "down",
  headingWest: "left",
  scoring: "Scoring",
  allOrNothing: "All or nothing",
  allOrNothingHint: "The points only when the robot reaches the dock in every warehouse.",
} as const;
export type BlocksEditorStringKey = keyof typeof blocksEditorStrings;
export type BlocksEditorStrings = Readonly<Record<BlocksEditorStringKey, string>>;

export const blocksPlayerStrings = {
  instruction: "Drag blocks from the palette under “when the robot starts”.",
  view: "View",
  viewBlocks: "Blocks",
  viewCode: "Code",
  codeHint: "The JavaScript your blocks stand for. It is shown, never run.",
  blockCount: "{n} blocks",
  "blockCount.one": "1 block",
  tooLarge: "This program is too large to be saved: at most {nodes} blocks, nested at most {depth} deep.",
  simulation: "Simulation",
  simulationHint: "The program must reach the dock in each warehouse. The hidden ones are tested at grading.",
  testAll: "Test on every warehouse",
  runHere: "Run here",
  step: "Step",
  reset: "Reset",
  caseTitle: "Case {n} · {name}",
  battery: "Battery",
  passed: "{passed} / {total} warehouses",
  hiddenFoot: "{count} hidden warehouses, worth {points} points in total, are tested at grading only.",
  "hiddenFoot.one": "1 hidden warehouse, worth {points} points, is tested at grading only.",
  noVisible: "Every warehouse is hidden: your program is tested at grading only.",
  allOrNothing: "All or nothing",
} as const;
export type BlocksPlayerStringKey = keyof typeof blocksPlayerStrings;
export type BlocksPlayerStrings = Readonly<Record<BlocksPlayerStringKey, string>>;

export const blocksReviewStrings = {
  score: "{points} / {max} points",
  program: "Program",
  noAnswer: "No answer",
  reference: "Reference solution",
  cases: "Warehouses",
  hiddenNote: "A hidden warehouse shows its verdict only.",
  allOrNothing: "All or nothing",
} as const;
export type BlocksReviewStringKey = keyof typeof blocksReviewStrings;
export type BlocksReviewStrings = Readonly<Record<BlocksReviewStringKey, string>>;

export const blocksGradingStrings = {
  program: "Program",
  warehouses: "{passed}/{total} docks",
  "warehouses.one": "{passed}/1 dock",
  more: "{n} more lines",
  "more.one": "1 more line",
  expand: "Show the whole program",
  collapse: "Fold the program",
} as const;
export type BlocksGradingStringKey = keyof typeof blocksGradingStrings;
export type BlocksGradingStrings = Readonly<Record<BlocksGradingStringKey, string>>;
