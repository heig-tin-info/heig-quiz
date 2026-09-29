/**
 * The English defaults of every string the diagram components render.
 *
 * A component takes a partial override through its `strings` prop, so the
 * host passes the French entries of its own dictionary (N-I18N-01) and this
 * package never imports the app. The toolbox shows icons only — the student
 * is expected to know the notation — so the tool names below are ACCESSIBLE
 * names and tooltips of the teacher's surfaces, never visible labels.
 */
import type { DiagramKind, PlaceTool } from "../kinds.js";
import type { LinkType } from "../scene.js";
import type { ParseErrorCode } from "../codecs/parsed.js";

export const diagramStrings = {
  canvas: "Diagram",
  toolbox: "Tools",
  select: "Select",
  undo: "Undo",
  redo: "Redo",
  duplicate: "Duplicate",
  remove: "Delete",
  swap: "Reverse the direction",
  /* the element tools */
  "tool.class": "Class",
  "tool.actor": "Actor",
  "tool.usecase": "Use case",
  "tool.system": "System boundary",
  "tool.initial": "Initial state",
  "tool.state": "State",
  "tool.final": "Final state",
  "tool.entity": "Entity",
  "tool.terminal": "Start or end",
  "tool.action": "Action",
  "tool.decision": "Decision",
  "tool.astate": "State",
  "tool.accept": "Accepting state",
  "tool.vertex": "Vertex",
  "tool.stroke": "Brush",
  "tool.line": "Line",
  "tool.rect": "Rectangle",
  "tool.square": "Square",
  "tool.circle": "Circle",
  "tool.ellipse": "Ellipse",
  "tool.triangle": "Triangle",
  /* the link tools */
  "link.assoc": "Association",
  "link.nav": "Navigable association",
  "link.inh": "Inheritance",
  "link.impl": "Realisation",
  "link.dep": "Dependency",
  "link.agg": "Aggregation",
  "link.comp": "Composition",
  "link.incl": "Include",
  "link.ext": "Extend",
  "link.strans": "Transition",
  "link.erel": "Relationship",
  "link.flow": "Arrow",
  "link.trans": "Transition",
  "link.edge": "Edge",
  "link.arc": "Arc",
  /* the inspector */
  name: "Name",
  stereotype: "Stereotype",
  stereotypeNone: "none",
  abstract: "Abstract",
  "body.class": "Content",
  "body.entity": "Attributes",
  "body.state": "Activities",
  bodyHintClass: "--- draws a separator. {static} underlines, {abstract} sets in italics.",
  bodyHintEntity: "PK underlines the identifier.",
  initial: "Initial",
  accepting: "Accepting",
  label: "Name",
  "label.state": "Label",
  "label.flow": "Label",
  "label.er": "Verb",
  "label.automaton": "Symbols",
  "label.graph": "Weight",
  multiplicity: "Multiplicity at {name}",
  cardinality: "Cardinality at {name}",
  /* the text pane, the teacher's */
  draw: "Diagram",
  code: "Text",
  codeApplied: "Applied to the diagram.",
  codeLive: "Changes apply to the diagram as you type.",
  codeError: "Line {line}: {message}",
  "error.unknown": "cannot read “{text}”",
  "error.arrow": "unknown arrow “{text}”",
  "error.undeclared": "“{text}” is not declared",
  "error.brace": "a closing brace too many",
  "error.unclosed": "“{text}” is not closed",
  "error.dottedLabel": "a dotted arrow needs : <<include>> or : <<extend>>",
  "error.arrowKind": "the arrow “{text}” is not part of this diagram",
  "error.composite": "composite states are not supported",
  "error.attribute": "an attribute is written “type name”, not “{text}”",
  "error.afterArrow": "an arrow needs an element after it",
  "error.directed": "an automaton is directed: -> expected",
  /* the status line */
  hintSelect: "Double-click the grid for an element, drag from a border to link",
  hintSelectFree: "Pick a shape or the brush",
  hintSelected: "Drag to move, double-click to edit",
  hintPlace: "Click to place, Escape to finish",
  hintInk: "Press and drag to draw, Escape to finish",
  hintLink: "Click the source, then the target",
  hintDrawing: "Release or click on the target. Click the grid for an elbow, Escape to cancel",
  empty: "Empty diagram",
  /* the first word of a new element's name */
  "new.class": "Class",
  "new.actor": "Actor",
  "new.usecase": "Case",
  "new.system": "System",
  "new.state": "State",
  "new.entity": "Entity",
  "new.start": "Start",
  "new.end": "End",
  "new.action": "Action",
  "new.decision": "Condition",
} as const;

export type DiagramStrings = { readonly [K in keyof typeof diagramStrings]: string };

export const toolKey = (tool: PlaceTool): keyof DiagramStrings => `tool.${tool}`;
export const linkKey = (type: LinkType): keyof DiagramStrings => `link.${type}`;
export const errorKey = (code: ParseErrorCode): keyof DiagramStrings => `error.${code}`;

/** The name field of a link, by kind: a verb, a label, symbols, a weight. */
export const labelKey = (kind: DiagramKind): keyof DiagramStrings =>
  kind === "state" || kind === "flow" || kind === "er" || kind === "automaton" || kind === "graph" ? `label.${kind}` : "label";
