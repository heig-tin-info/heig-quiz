/**
 * Blockly, for the `blocks` surfaces (ADR-103 §5, §9, §11).
 *
 * The ONLY module of the repository that imports Blockly. It is reached by
 * one dynamic `import()` in `BlocklyHost.tsx`, so Blockly and its JavaScript
 * generator land in a chunk of their own, fetched only by a screen that
 * shows a `blocks` question; `client.tsx` and `server.ts` never import it.
 *
 * What it owns:
 *  - the six blocks, English ids and fields, labels from the canvas
 *    dictionary (`qt.blocks.c.*`), Blockly's own interface in the same
 *    language (its message files ship in the package);
 *  - a theme per colour scheme (zelos; Movement slate, Control `warning`,
 *    Sensors `info`, the workspace on `surface`, the flyout on `surface-2`,
 *    DESIGN.md "The blocks workspace");
 *  - the conversions between OUR syntax tree and a workspace: the one hat
 *    "when the robot starts", undeletable and unmovable, and the stack under
 *    it; a detached stack is disabled (`disableOrphans`) and never read;
 *  - the JavaScript of the Code tab — shown, never run (the CSP has no
 *    `unsafe-eval`, and the grade is the domain interpreter's).
 *
 * Self-hosted: the media come from our own origin (`/blockly-media/`, copied
 * by `apps/web/scripts/copy-blockly-media.mjs`), and sounds are off.
 * Keyboard navigation is Blockly 13's own, in core.
 */
import * as Blockly from "blockly/core";
import { javascriptGenerator } from "blockly/javascript";
import * as En from "blockly/msg/en";
import * as Fr from "blockly/msg/fr";

import { fmt } from "@quiz/core/client";
import { BLOCK_KINDS, PROGRAM_LIMITS, type BlockKind, type NodePath, type Stmt } from "@quiz/domain/blocks";

import type { BlocksCanvasStrings } from "./strings.js";

/** Where `apps/web` serves Blockly's media (cursors, sprites). */
export const MEDIA_PATH = "/blockly-media/";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** The three groups of blocks: a colour each, a labelled group of the palette each. */
type Group = "movement" | "control" | "sensors";

/** Which group a kind belongs to: its block style and its place in the palette. */
const GROUP_OF: Record<BlockKind, Group> = {
  forward: "movement",
  turn: "movement",
  repeat: "control",
  repeat_until_dock: "control",
  if_sensor: "sensors",
};

/** The palette's groups, in order, with the canvas word that labels each. */
const GROUPS: readonly [Group, "groupMovement" | "groupControl" | "groupSensors"][] = [
  ["movement", "groupMovement"],
  ["control", "groupControl"],
  ["sensors", "groupSensors"],
];

/**
 * The block hues and the hat's, per scheme: Blockly parses a block colour
 * itself, so these are values (DESIGN.md, "The blocks workspace", lists them
 * with their reasons). Everything else of the theme is the app's own tokens,
 * read from the page ({@link token}).
 */
export const BLOCK_COLOURS: Record<"light" | "dark", Record<Group | "start", string>> = {
  light: { movement: "#55606f", control: "#a35810", sensors: "#1268a0", start: "#726d64" },
  dark: { movement: "#7d8796", control: "#c07a2a", sensors: "#3f8ec4", start: "#6b665e" },
};

/** A colour token of the app (`--surface`), as the page resolves it now. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

/** A hex colour scaled toward black (k < 1) or white (k > 1), for a block's shades. */
function shade(hex: string, k: number): string {
  const channel = (i: number) => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k));
  return `#${[1, 3, 5].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

const style = (colour: string, hat = "") => ({
  colourPrimary: colour,
  colourSecondary: shade(colour, 1.25),
  colourTertiary: shade(colour, 0.8),
  hat,
});

function themeFor(dark: boolean): Blockly.Theme {
  const c = dark ? BLOCK_COLOURS.dark : BLOCK_COLOURS.light;
  return Blockly.Theme.defineTheme(dark ? "quiz-blocks-dark" : "quiz-blocks-light", {
    name: dark ? "quiz-blocks-dark" : "quiz-blocks-light",
    base: Blockly.Themes.Classic,
    blockStyles: {
      ...Object.fromEntries(GROUPS.map(([group]) => [`quiz_${group}`, style(c[group])])),
      quiz_start: style(c.start, "cap"),
    },
    categoryStyles: {},
    componentStyles: {
      workspaceBackgroundColour: token("surface"),
      toolboxBackgroundColour: token("surface-2"),
      flyoutBackgroundColour: token("surface-2"),
      flyoutForegroundColour: token("fg"),
      flyoutOpacity: 1,
      scrollbarColour: token("line-strong"),
      scrollbarOpacity: 1,
      insertionMarkerColour: token("fg"),
      insertionMarkerOpacity: 0.3,
    },
    fontStyle: { family: '"Manrope Variable", Manrope, ui-sans-serif, sans-serif', weight: "600", size: 12 },
  });
}

/*
 * What a theme cannot say: the flyout's group labels in the caption style of
 * the app, and the hairline between the flyout and the workspace. CSS
 * variables of the app, so they follow the scheme by themselves.
 */
Blockly.Css.register(`
.quiz-blocks .blocklyFlyoutLabelText {
  fill: var(--fg-muted) !important;
  font: 600 11px "Manrope Variable", Manrope, ui-sans-serif, sans-serif !important;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.quiz-blocks .blocklyFlyout { border-right: 1px solid var(--line); }
.quiz-blocks .blocklyMainBackground { stroke: none !important; }
`);

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** A label of the dictionary with its `{var}` placeholders turned into Blockly's `%n`. */
const label = (text: string, fields: Record<string, number> = {}) =>
  fmt(text.replaceAll("%", "%%"), Object.fromEntries(Object.entries(fields).map(([k, n]) => [k, `%${n}`])));

/** A statement block of `kind`: chained above and below, in its group's style. */
const statement = (kind: BlockKind) => ({
  type: kind,
  previousStatement: null,
  nextStatement: null,
  style: `quiz_${GROUP_OF[kind]}`,
});

/** The six block types, labelled in the reader's language; ids and field values stay English. */
function defineBlocks(c: BlocksCanvasStrings): void {
  const definitions = [
    { type: "start", message0: label(c.start), nextStatement: null, style: "quiz_start" },
    { ...statement("forward"), message0: label(c.forward) },
    {
      ...statement("turn"),
      message0: label(c.turn, { dir: 1 }),
      args0: [
        {
          type: "field_dropdown",
          name: "DIR",
          options: [
            [c.turnLeft, "left"],
            [c.turnRight, "right"],
          ],
        },
      ],
    },
    {
      ...statement("repeat"),
      message0: label(c.repeat, { n: 1 }),
      args0: [{ type: "field_number", name: "TIMES", value: 3, min: 1, max: PROGRAM_LIMITS.repeatMax, precision: 1 }],
      message1: "%1",
      args1: [{ type: "input_statement", name: "DO" }],
    },
    {
      ...statement("repeat_until_dock"),
      message0: label(c.repeatUntilDock),
      message1: "%1",
      args1: [{ type: "input_statement", name: "DO" }],
    },
    {
      ...statement("if_sensor"),
      message0: label(c.ifSensor, { sensor: 1, where: 2 }),
      args0: [
        {
          type: "field_dropdown",
          name: "SENSOR",
          options: [
            [c.sensorFree, "free"],
            [c.sensorBlocked, "blocked"],
          ],
        },
        {
          type: "field_dropdown",
          name: "WHERE",
          options: [
            [c.whereFront, "front"],
            [c.whereLeft, "left"],
            [c.whereRight, "right"],
          ],
        },
      ],
      message1: "%1",
      args1: [{ type: "input_statement", name: "THEN" }],
      message2: `${label(c.else)} %1`,
      args2: [{ type: "input_statement", name: "ELSE" }],
    },
  ];
  // Redefined at every mount, in the language of the page: a definition is a
  // global of Blockly, and the old one goes first or Blockly warns.
  for (const { type } of definitions) delete Blockly.Blocks[type];
  Blockly.common.defineBlocksWithJsonArray(definitions);
}

/** The palette: three labelled groups, holding only what the toolbox offers. */
function flyout(toolbox: readonly BlockKind[], c: BlocksCanvasStrings): Blockly.utils.toolbox.ToolboxDefinition {
  return {
    kind: "flyoutToolbox",
    contents: GROUPS.flatMap(([group, word]) => {
      const offered = BLOCK_KINDS.filter((kind) => GROUP_OF[kind] === group && toolbox.includes(kind));
      return offered.length === 0
        ? []
        : [{ kind: "label", text: c[word] }, ...offered.map((type) => ({ kind: "block", type }))];
    }),
  };
}

// ---------------------------------------------------------------------------
// Our syntax tree <-> a workspace
// ---------------------------------------------------------------------------

type BlockState = Blockly.serialization.blocks.State;

/** A statement as Blockly's serialization of one block (its `next` is set by `chain`). */
function stateOf(stmt: Stmt): BlockState {
  const body = (name: string, statements: Stmt[]) => {
    const block = chain(statements);
    return block === undefined ? {} : { [name]: { block } };
  };
  switch (stmt.kind) {
    case "forward":
      return { type: "forward" };
    case "turn":
      return { type: "turn", fields: { DIR: stmt.dir } };
    case "repeat":
      return { type: "repeat", fields: { TIMES: stmt.times }, inputs: body("DO", stmt.body) };
    case "repeat_until_dock":
      return { type: "repeat_until_dock", inputs: body("DO", stmt.body) };
    case "if_sensor":
      return {
        type: "if_sensor",
        fields: { SENSOR: stmt.sensor, WHERE: stmt.where },
        inputs: { ...body("THEN", stmt.then), ...body("ELSE", stmt.else) },
      };
  }
}

/** A list of statements as one stack: each block's `next` is the following one. */
function chain(program: Stmt[]): BlockState | undefined {
  let next: BlockState | undefined;
  for (let i = program.length - 1; i >= 0; i--) {
    const block = stateOf(program[i]!);
    if (next !== undefined) block.next = { block: next };
    next = block;
  }
  return next;
}

/** The workspace of a program: the hat, laid out canonically, and the stack under it. */
export function workspaceState(program: Stmt[]): object {
  const next = chain(program);
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        { type: "start", x: 24, y: 24, deletable: false, movable: false, ...(next ? { next: { block: next } } : {}) },
      ],
    },
  };
}

/** A whole number of iterations within the limits, whatever the field holds. */
const times = (value: unknown) =>
  Math.min(PROGRAM_LIMITS.repeatMax, Math.max(1, Math.round(Number(value)) || 1));

/** The stack that starts at `block`, as statements. */
function stackOf(block: Blockly.Block | null): Stmt[] {
  const out: Stmt[] = [];
  for (let b = block; b !== null; b = b.getNextBlock()) {
    const stmt = stmtOf(b);
    if (stmt !== null) out.push(stmt);
  }
  return out;
}

function stmtOf(block: Blockly.Block): Stmt | null {
  const body = (name: string) => stackOf(block.getInputTargetBlock(name));
  switch (block.type) {
    case "forward":
      return { kind: "forward" };
    case "turn":
      return { kind: "turn", dir: block.getFieldValue("DIR") === "left" ? "left" : "right" };
    case "repeat":
      return { kind: "repeat", times: times(block.getFieldValue("TIMES")), body: body("DO") };
    case "repeat_until_dock":
      return { kind: "repeat_until_dock", body: body("DO") };
    case "if_sensor":
      return {
        kind: "if_sensor",
        sensor: block.getFieldValue("SENSOR") === "blocked" ? "blocked" : "free",
        where: (["front", "left", "right"] as const).find((w) => w === block.getFieldValue("WHERE")) ?? "front",
        then: body("THEN"),
        else: body("ELSE"),
      };
    default:
      return null;
  }
}

/** The program of a workspace: the stack under its hat; a detached stack is not the program. */
export function programOf(workspace: Blockly.Workspace): Stmt[] {
  const start = workspace.getBlocksByType("start", false)[0];
  return start === undefined ? [] : stackOf(start.getNextBlock());
}

/**
 * The block a run event names (`NodePath` of `@quiz/domain/blocks`): an index
 * into a stack, then into the body of the block found there — after an
 * `if_sensor`, the branch first (0 `THEN`, 1 `ELSE`), then the index in it.
 * `null` for a path the workspace does not hold (it changed under the run).
 */
export function blockAt(workspace: Blockly.Workspace, path: NodePath): Blockly.Block | null {
  let stack = workspace.getBlocksByType("start", false)[0]?.getNextBlock() ?? null;
  let found: Blockly.Block | null = null;
  for (let at = 0; at < path.length; at++) {
    let block = stack;
    for (let i = 0; i < path[at]! && block !== null; i++) block = block.getNextBlock();
    if (block === null) return null;
    found = block;
    if (block.type !== "if_sensor") stack = block.getInputTargetBlock("DO");
    else if (at + 1 < path.length) stack = block.getInputTargetBlock(path[++at] === 0 ? "THEN" : "ELSE");
  }
  return found;
}

// ---------------------------------------------------------------------------
// The Code tab: JavaScript, displayed only
// ---------------------------------------------------------------------------

const generator = javascriptGenerator;
generator.forBlock["start"] = () => "";
generator.forBlock["forward"] = () => "robot.forward();\n";
generator.forBlock["turn"] = (block) => `robot.turn("${block.getFieldValue("DIR") === "left" ? "left" : "right"}");\n`;
generator.forBlock["repeat"] = (block, g) =>
  `for (let i = 0; i < ${times(block.getFieldValue("TIMES"))}; i++) {\n${g.statementToCode(block, "DO")}}\n`;
generator.forBlock["repeat_until_dock"] = (block, g) =>
  `while (!robot.atDock()) {\n${g.statementToCode(block, "DO")}}\n`;
generator.forBlock["if_sensor"] = (block, g) => {
  const where = block.getFieldValue("WHERE") as string;
  const test = `${block.getFieldValue("SENSOR") === "blocked" ? "!" : ""}robot.isFree("${where}")`;
  const otherwise = g.statementToCode(block, "ELSE");
  return `if (${test}) {\n${g.statementToCode(block, "THEN")}}${otherwise ? ` else {\n${otherwise}}` : ""}\n`;
};

/**
 * A program through a workspace without a page and back, with its
 * JavaScript: the conversions a mounted workspace makes, checkable headless
 * (the package's tests run them under Node).
 */
export function roundTrip(program: Stmt[], words: BlocksCanvasStrings): { program: Stmt[]; code: string } {
  return headless(program, words, (workspace) => ({
    program: programOf(workspace),
    code: generator.workspaceToCode(workspace),
  }));
}

/** `read` over a page-less workspace holding `program`, disposed after. */
export function headless<T>(program: Stmt[], words: BlocksCanvasStrings, read: (workspace: Blockly.Workspace) => T): T {
  defineBlocks(words);
  const workspace = new Blockly.Workspace();
  try {
    Blockly.serialization.workspaces.load(workspaceState(program), workspace);
    return read(workspace);
  } finally {
    workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export interface WorkspaceOptions {
  container: HTMLElement;
  program: Stmt[];
  /** The kinds the palette offers; ignored read-only, where there is no palette. */
  toolbox: readonly BlockKind[];
  words: BlocksCanvasStrings;
  dark: boolean;
  /** The page's language (`<html lang>`): Blockly's own interface follows it. */
  lang: string;
  readOnly: boolean;
  /** Every change of the program; never called while a program is loaded. */
  onChange: (program: Stmt[]) => void;
}

export interface MountedWorkspace {
  /** Replaces the program, laid out canonically under the hat. */
  load(program: Stmt[]): void;
  /** Lights the block a run event names; `null` lights none. */
  highlight(path: NodePath | null): void;
  /** The JavaScript of the program, for the Code tab. */
  code(): string;
  resize(): void;
  dispose(): void;
}

/** Injects a workspace into `container`. Throws whatever Blockly throws; the host falls back. */
export function mountWorkspace(options: WorkspaceOptions): MountedWorkspace {
  const { container, words, readOnly } = options;
  Blockly.setLocale((options.lang.startsWith("fr") ? Fr : En) as unknown as Record<string, string>);
  defineBlocks(words);
  container.classList.add("quiz-blocks");
  const workspace = Blockly.inject(container, {
    renderer: "zelos",
    theme: themeFor(options.dark),
    readOnly,
    ...(readOnly ? {} : { toolbox: flyout(options.toolbox.length > 0 ? options.toolbox : BLOCK_KINDS, words) }),
    media: MEDIA_PATH,
    sounds: false,
    trashcan: false,
    comments: false,
    collapse: false,
    disable: false,
    // The hat counts: the program's own cap is `PROGRAM_LIMITS.nodes`.
    maxBlocks: PROGRAM_LIMITS.nodes + 1,
    grid: { spacing: 20, length: 2, colour: token("line"), snap: true },
    // The page scrolls under the wheel; the workspace by its scrollbars and a drag.
    move: { scrollbars: true, drag: true, wheel: false },
    zoom: { startScale: 0.72, controls: false, wheel: false, pinch: true },
  });

  let loading = false;
  const load = (program: Stmt[]) => {
    loading = true;
    Blockly.Events.disable();
    try {
      workspace.clear();
      Blockly.serialization.workspaces.load(workspaceState(program), workspace);
    } finally {
      Blockly.Events.enable();
      loading = false;
    }
  };
  load(options.program);

  workspace.addChangeListener(Blockly.Events.disableOrphans);
  workspace.addChangeListener((event) => {
    if (loading || event.isUiEvent) return;
    options.onChange(programOf(workspace));
  });

  return {
    load,
    highlight(path) {
      const block = path === null ? null : blockAt(workspace, path);
      workspace.highlightBlock(block?.id ?? null);
    },
    code: () => generator.workspaceToCode(workspace),
    resize: () => Blockly.svgResize(workspace),
    dispose: () => workspace.dispose(),
  };
}
