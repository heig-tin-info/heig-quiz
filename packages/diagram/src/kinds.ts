/**
 * The catalogue of diagram KINDS (docs/spec/04 §4.14, ADR-046 §3).
 *
 * A kind is data: the element types it may hold, the tools of its toolbox
 * (a tool may place a type with a preset), its link types, how its lines are
 * drawn, where an element added through the text lands, and its limits. Its
 * text form is its entry in `codecs/index.ts`. Adding a kind is an entry
 * here, its codec, its icons and its strings.
 */
import {
  MAX_NODES,
  MAX_NODES_STRUCTURED,
  type DiagramNode,
  type LinkType,
  type NodeType,
  type Scene,
} from "./scene.js";

export const DIAGRAM_KINDS = ["class", "usecase", "state", "er", "flow", "automaton", "graph", "free"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/** The tools that place a type with a preset: the accepting state is a state. */
export const TOOL_PRESET = {
  accept: { t: "astate", accept: true },
} as const satisfies Record<string, Partial<DiagramNode> & { t: NodeType }>;

/** A toolbox entry that places an element: a type, or a preset. */
export type PlaceTool = NodeType | keyof typeof TOOL_PRESET;

export const typeOfTool = (tool: PlaceTool): NodeType => (tool in TOOL_PRESET ? TOOL_PRESET[tool as keyof typeof TOOL_PRESET].t : (tool as NodeType));

export interface KindSpec {
  /** The toolbox's placing tools, in order; the element types a kind holds are theirs. */
  readonly tools: readonly PlaceTool[];
  readonly links: readonly LinkType[];
  /** What a double click on the empty grid places; `null`, nothing. */
  readonly dbl: PlaceTool | null;
  /** Orthogonal lines routed on the grid, or straight lines between circles. */
  readonly lines: "orthogonal" | "straight";
  /** Where an element added through the text lands: in a row, under, or right of its source. */
  readonly place: "row" | "down" | "right";
  /** What the two ends of a link carry: UML multiplicities, crow's-foot cardinalities, or nothing. */
  readonly ends: "multiplicity" | "cardinality" | null;
  readonly maxNodes: number;
}

const structured = { maxNodes: MAX_NODES_STRUCTURED, ends: null } as const;

export const KINDS: Readonly<Record<DiagramKind, KindSpec>> = {
  class: {
    ...structured,
    tools: ["class"],
    links: ["assoc", "nav", "inh", "impl", "dep", "agg", "comp"],
    dbl: "class",
    lines: "orthogonal",
    place: "row",
    ends: "multiplicity",
  },
  usecase: {
    ...structured,
    tools: ["actor", "usecase", "system"],
    links: ["assoc", "incl", "ext", "inh"],
    dbl: "usecase",
    lines: "orthogonal",
    place: "row",
  },
  state: {
    ...structured,
    tools: ["initial", "state", "final"],
    links: ["strans"],
    dbl: "state",
    lines: "orthogonal",
    place: "down",
  },
  er: {
    ...structured,
    tools: ["entity"],
    links: ["erel"],
    dbl: "entity",
    lines: "orthogonal",
    place: "row",
    ends: "cardinality",
  },
  flow: {
    ...structured,
    tools: ["terminal", "action", "decision"],
    links: ["flow"],
    dbl: "action",
    lines: "orthogonal",
    place: "down",
  },
  automaton: {
    ...structured,
    tools: ["astate", "accept"],
    links: ["trans"],
    dbl: "astate",
    lines: "straight",
    place: "right",
  },
  graph: {
    ...structured,
    tools: ["vertex"],
    links: ["edge", "arc"],
    dbl: "vertex",
    lines: "straight",
    place: "down",
  },
  free: {
    tools: ["stroke", "line", "rect", "square", "circle", "ellipse", "triangle"],
    links: [],
    dbl: null,
    lines: "orthogonal",
    place: "row",
    ends: null,
    maxNodes: MAX_NODES,
  },
};

/** The element types a scene of a kind may hold. */
export const nodesOf = (kind: DiagramKind): ReadonlySet<NodeType> => new Set(KINDS[kind].tools.map(typeOfTool));

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
/** Types that contain others and block no line. */
export const CONTAINERS: ReadonlySet<NodeType> = new Set(["system"]);
/** Types that keep their width equal to their height. */
export const SQUARE: ReadonlySet<NodeType> = new Set(["square", "circle"]);
/** The smallest a resizable type gets. */
export const minSize = (t: NodeType): readonly [number, number] => (t === "system" ? [160, 120] : [20, 20]);

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
  const types = nodesOf(kind);
  const out = new Set<KindIssue>();
  for (const n of scene.nodes) if (!types.has(n.t)) out.add("diagram.node_type");
  for (const l of scene.links) if (!spec.links.includes(l.type)) out.add("diagram.link_type");
  if (scene.nodes.length > spec.maxNodes) out.add("diagram.too_many_nodes");
  return [...out];
}
