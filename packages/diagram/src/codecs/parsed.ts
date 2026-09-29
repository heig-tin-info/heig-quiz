/**
 * What a parser returns: the elements and links a text declares, by
 * identity, without positions. `applyParsed` (`../apply.ts`) turns it into a
 * scene, keeping the positions of the elements that survive by name.
 *
 * A parse error is a CODE and the offending text, never a sentence: the
 * editor renders it through its strings, in the user's language.
 */
import type { LinkType, NodeType } from "../scene.js";

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

/** A quoted token without its quotes. */
export const unquote = (s: string): string => s.replace(/^"(.*)"$/s, "$1").trim();

/** A name that needs no quotes in PlantUML and DOT. */
export const isIdentifier = (s: string): boolean => /^[\p{L}_][\p{L}\w]*$/u.test(s);
