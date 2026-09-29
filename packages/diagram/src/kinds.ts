/**
 * The catalogue of diagram KINDS (docs/spec/04 §4.14, ADR-041 §3).
 *
 * A kind is data: the element types it may hold, the tools of its toolbox
 * (a tool may place a type with a preset), its link types, how its lines are
 * drawn, its text form, and where an element added through the text lands.
 * Adding a kind is an entry here, its codec, its icons and its strings.
 */
import {
  MAX_NODES_STRUCTURED,
  type DiagramNode,
  type LinkType,
  type NodeType,
  type Scene,
} from "./scene.js";

export const DIAGRAM_KINDS = ["class", "usecase", "state", "er", "flow", "automaton", "graph", "free"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/** A toolbox entry that places an element: a type, or a type with a preset. */
export type PlaceTool = NodeType | "accept";

/** What a preset tool places. */
export const TOOL_PRESET: Readonly<Record<"accept", Partial<DiagramNode> & { t: NodeType }>> = {
  accept: { t: "astate", accept: true },
};

export const typeOfTool = (tool: PlaceTool): NodeType => (tool === "accept" ? "astate" : tool);

export type TextForm = "plantuml" | "mermaid" | "dot";

export interface KindSpec {
  /** The element types a scene of this kind may hold. */
  readonly nodes: readonly NodeType[];
  /** The toolbox's placing tools, in order. */
  readonly tools: readonly PlaceTool[];
  readonly links: readonly LinkType[];
  /** What a double click on the empty grid places; `null`, nothing. */
  readonly dbl: PlaceTool | null;
  /** Orthogonal lines routed on the grid, or straight lines between circles. */
  readonly lines: "orthogonal" | "straight";
  readonly text: TextForm | null;
  /** Where an element added through the text lands: in a row, under, or right of its source. */
  readonly place: "row" | "down" | "right";
}

export const KINDS: Readonly<Record<DiagramKind, KindSpec>> = {
  class: {
    nodes: ["class"],
    tools: ["class"],
    links: ["assoc", "nav", "inh", "impl", "dep", "agg", "comp"],
    dbl: "class",
    lines: "orthogonal",
    text: "plantuml",
    place: "row",
  },
  usecase: {
    nodes: ["actor", "usecase", "system"],
    tools: ["actor", "usecase", "system"],
    links: ["assoc", "incl", "ext", "inh"],
    dbl: "usecase",
    lines: "orthogonal",
    text: "plantuml",
    place: "row",
  },
  state: {
    nodes: ["initial", "state", "final"],
    tools: ["initial", "state", "final"],
    links: ["strans"],
    dbl: "state",
    lines: "orthogonal",
    text: "mermaid",
    place: "down",
  },
  er: {
    nodes: ["entity"],
    tools: ["entity"],
    links: ["erel"],
    dbl: "entity",
    lines: "orthogonal",
    text: "mermaid",
    place: "row",
  },
  flow: {
    nodes: ["terminal", "action", "decision"],
    tools: ["terminal", "action", "decision"],
    links: ["flow"],
    dbl: "action",
    lines: "orthogonal",
    text: "mermaid",
    place: "down",
  },
  automaton: {
    nodes: ["astate"],
    tools: ["astate", "accept"],
    links: ["trans"],
    dbl: "astate",
    lines: "straight",
    text: "dot",
    place: "right",
  },
  graph: {
    nodes: ["vertex"],
    tools: ["vertex"],
    links: ["edge", "arc"],
    dbl: "vertex",
    lines: "straight",
    text: "dot",
    place: "down",
  },
  free: {
    nodes: ["stroke", "line", "rect", "square", "circle", "ellipse", "triangle"],
    tools: ["stroke", "line", "rect", "square", "circle", "ellipse", "triangle"],
    links: [],
    dbl: null,
    lines: "orthogonal",
    text: null,
    place: "row",
  },
};

/** How a link type is drawn. */
export interface LinkStyle {
  /** The head at `b`: open arrow, hollow triangle, hollow or filled diamond, filled arrow. */
  readonly head: "open" | "tri" | "dia" | "diaF" | "arrowF" | null;
  readonly dash: boolean;
  /** A fixed label drawn on the line, whatever its name. */
  readonly label?: string;
  /** The label sits where the line leaves `a` (a flowchart's oui / non). */
  readonly labelAtStart?: boolean;
  /** The label is set in the monospace face: symbols and weights. */
  readonly mono?: boolean;
  /** Crow's feet at both ends, from `ma` and `mb`. */
  readonly crow?: boolean;
}

export const LINK_STYLE: Readonly<Record<LinkType, LinkStyle>> = {
  assoc: { head: null, dash: false },
  nav: { head: "open", dash: false },
  inh: { head: "tri", dash: false },
  impl: { head: "tri", dash: true },
  dep: { head: "open", dash: true },
  agg: { head: "dia", dash: false },
  comp: { head: "diaF", dash: false },
  incl: { head: "open", dash: true, label: "«include»" },
  ext: { head: "open", dash: true, label: "«extend»" },
  strans: { head: "open", dash: false },
  erel: { head: null, dash: false, crow: true },
  flow: { head: "arrowF", dash: false, labelAtStart: true },
  trans: { head: "arrowF", dash: false, mono: true },
  edge: { head: null, dash: false, mono: true },
  arc: { head: "arrowF", dash: false, mono: true },
};

/* Families of element types, by what they are drawn as or what they carry. */
export const SHAPES: ReadonlySet<NodeType> = new Set(["rect", "square", "circle", "ellipse", "triangle"]);
export const INK: ReadonlySet<NodeType> = new Set(["stroke", "line"]);
export const CIRCLES: ReadonlySet<NodeType> = new Set(["astate", "vertex"]);
export const FLOW_NODES: ReadonlySet<NodeType> = new Set(["terminal", "action", "decision"]);
/** Types with a body of lines under their name. */
export const BODIED: ReadonlySet<NodeType> = new Set(["class", "entity", "state"]);
/** Types without a name at all. */
export const NAMELESS: ReadonlySet<NodeType> = new Set(["initial", "final", "stroke", "line"]);
/** Types the student sizes with a handle. */
export const RESIZABLE: ReadonlySet<NodeType> = new Set(["system", "rect", "square", "circle", "ellipse", "triangle"]);

/** The size a new shape or system boundary gets. */
export const DEFAULT_SIZE: Readonly<Partial<Record<NodeType, readonly [number, number]>>> = {
  system: [280, 240],
  rect: [100, 60],
  square: [60, 60],
  circle: [60, 60],
  ellipse: [100, 60],
  triangle: [80, 60],
};

/** Why a scene does not fit its kind; empty when it fits. */
export type KindIssue = "diagram.node_type" | "diagram.link_type" | "diagram.too_many_nodes";

/**
 * What a scene holds that its kind does not have: publication refuses such a
 * reference or starter, and `answerMisfit` such an answer.
 */
export function kindIssues(scene: Scene, kind: DiagramKind): KindIssue[] {
  const spec = KINDS[kind];
  const out = new Set<KindIssue>();
  for (const n of scene.nodes) if (!spec.nodes.includes(n.t)) out.add("diagram.node_type");
  for (const l of scene.links) if (!spec.links.includes(l.type)) out.add("diagram.link_type");
  if (kind !== "free" && scene.nodes.length > MAX_NODES_STRUCTURED) out.add("diagram.too_many_nodes");
  return [...out];
}
