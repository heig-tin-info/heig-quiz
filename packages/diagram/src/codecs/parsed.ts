/**
 * What a parser returns: the elements and links a text declares, by
 * identity, without positions. `applyParsed` (`../apply.ts`) turns it into a
 * scene, keeping the positions of the elements that survive by name.
 *
 * A parse error is a CODE and the offending text, never a sentence: the
 * editor renders it through its strings, in the user's language.
 */
import type { DiagramLink, DiagramNode, LinkType, NodeType, Scene } from "../scene.js";

export interface ParsedNode {
  t: NodeType;
  name: string;
  stereo?: string;
  abstract?: boolean;
  body?: string[];
  accept?: boolean;
  initial?: boolean;
  /** The system boundary the element was declared in. */
  sys?: ParsedNode;
}

export interface ParsedLink {
  a: ParsedNode;
  b: ParsedNode;
  type: LinkType;
  ma?: string;
  mb?: string;
  name?: string;
}

export const PARSE_ERRORS = [
  /** A line the grammar does not know. */
  "unknown",
  /** An arrow the grammar does not know. */
  "arrow",
  /** A name used before, or without, being declared. */
  "undeclared",
  /** A closing brace with nothing to close. */
  "brace",
  /** A block left open at the end. */
  "unclosed",
  /** A dotted arrow of a use case diagram without «include» or «extend». */
  "dottedLabel",
  /** An arrow that the diagram's kind does not have. */
  "arrowKind",
  /** A composite state. */
  "composite",
  /** An entity attribute that is not `type name`. */
  "attribute",
  /** An arrow with nothing after it. */
  "afterArrow",
  /** An undirected edge in an automaton. */
  "directed",
] as const;
export type ParseErrorCode = (typeof PARSE_ERRORS)[number];

export interface ParseError {
  /** 1-based. */
  line: number;
  code: ParseErrorCode;
  /** The offending text, a name or an arrow; empty when there is none. */
  text: string;
}

export interface Parsed {
  nodes: ParsedNode[];
  links: ParsedLink[];
  errors: ParseError[];
}

export const emptyParsed = (): Parsed => ({ nodes: [], links: [], errors: [] });

/**
 * The longest line a parser reads. A longer one is refused before any
 * pattern runs on it, so no pattern's cost can grow past it; the patterns
 * themselves are written without nested ambiguity.
 */
export const MAX_LINE = 1_000;

/**
 * The longest text the editor parses: the text of the largest scene the
 * schema allows (50 000 characters of names and bodies) with room for the
 * keywords, quotes and arrows around them. A line is cheap to read; this
 * bounds how many there are.
 */
export const MAX_SOURCE = 200_000;

/** Records a line too long to read; `true` when it was. */
export function tooLong(p: Parsed, raw: string, line: number): boolean {
  if (raw.length <= MAX_LINE) return false;
  p.errors.push({ line, code: "unknown", text: `${raw.slice(0, 40)}…` });
  return true;
}

/** A quoted token without its quotes. */
export const unquote = (s: string): string => s.replace(/^"(.*)"$/s, "$1").trim();

/** A name that needs no quotes in PlantUML and DOT. */
export const isIdentifier = (s: string): boolean => /^[\p{L}_][\p{L}\w]*$/u.test(s);

/** A name, quoted when PlantUML or DOT would not read it bare. */
export const quote = (s: string): string => (isIdentifier(s) ? s : `"${s.replace(/"/g, "'")}"`);

/** The elements a parse declares, by name and by alias. */
export class NodeTable {
  private readonly keys = new Map<string, ParsedNode>();
  constructor(private readonly parsed: Parsed) {}

  get(key: string): ParsedNode | undefined {
    return this.keys.get(key);
  }

  /** Registers an element under its keys; a new one joins the parse. */
  add(node: ParsedNode, ...keys: string[]): ParsedNode {
    if (!this.parsed.nodes.includes(node)) this.parsed.nodes.push(node);
    for (const k of keys) this.keys.set(k, node);
    return node;
  }

  /** The element under `key`, made the first time. */
  obtain(key: string, make: () => ParsedNode): ParsedNode {
    return this.keys.get(key) ?? this.add(make(), key);
  }
}

/** Each link of a scene with its two ends; a link whose end is missing is skipped. */
export function* linkEnds(scene: Scene): Generator<[DiagramLink, DiagramNode, DiagramNode]> {
  const byId = new Map(scene.nodes.map((n) => [n.id, n] as const));
  for (const l of scene.links) {
    const a = byId.get(l.a);
    const b = byId.get(l.b);
    if (a && b) yield [l, a, b];
  }
}
