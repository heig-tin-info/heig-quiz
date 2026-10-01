/**
 * Which names the `[[…]]` of a draft's texts hold, WITHOUT the evaluator
 * (ADR-056 §3; addendum of 2026-10-01). This module imports no mathjs, so the
 * editor asks it, in the browser, which variables the texts declare by use
 * (`referencedNames`) and which names they mention at all (`namesMentioned`,
 * `identifiersIn`). The precise reading of an expression (`namesReadBy`)
 * needs mathjs and stays on the server.
 */
import { isVariableName, referenceSpans } from "../parameterNames.js";

/** Every string of a JSON value, in document order. */
function* stringsOf(json: unknown): Generator<string> {
  if (typeof json === "string") yield json;
  else if (Array.isArray(json)) for (const item of json) yield* stringsOf(item);
  else if (json !== null && typeof json === "object") for (const item of Object.values(json)) yield* stringsOf(item);
}

/**
 * The expression of every CLOSED `[[…]]` of every string of `content`, after
 * `prepare`, walked by `referenceSpans` like the interpolation: `\[[…]]` is
 * text, and an unclosed `[[` ends the text's references.
 */
function* closedReferences(content: unknown, prepare: (text: string) => string): Generator<string> {
  for (const raw of stringsOf(content)) {
    if (!raw.includes("[[")) continue;
    const text = prepare(raw);
    for (const span of referenceSpans(text)) {
      if (span.closed && !span.escaped) yield text.slice(span.from + 2, span.to - 2);
    }
  }
}

/**
 * The variable names a draft's texts declare by use: every closed `[[name]]`
 * — a bare name, spaces around it allowed — in any string of `content` (a
 * configuration, an explanation, an array of them), whose name
 * {@link isVariableName} accepts. In order of first appearance, each once.
 * `[[h*w]]` declares nothing, an unclosed `[[hei` nothing either, and
 * `\[[h]]` is text. `prepare` lets the caller blank what is not prose — the
 * editor removes markdown code with its own markdown lexer. The editor adds
 * a row for each name it does not have yet (ADR-056, addendum of 2026-10-01).
 */
export function referencedNames(content: unknown, prepare: (text: string) => string = (text) => text): string[] {
  const names = new Set<string>();
  for (const expr of closedReferences(content, prepare)) {
    const name = expr.trim();
    if (isVariableName(name)) names.add(name);
  }
  return [...names];
}

/** An identifier that does not continue a number, a name or a member (`1e5`, `a.b`). */
const IDENTIFIER = /(?<![\w.])[A-Za-z_]\w*/g;
/** A quoted string of an expression: its words are text, not names. */
const QUOTED = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;

/**
 * Every identifier an expression mentions, read lexically: function names
 * and constants included, quoted strings skipped. A superset of what the
 * expression reads, without parsing it — enough to say whether a variable
 * is mentioned anywhere, which is all the editor asks.
 */
export function identifiersIn(expr: string): Set<string> {
  return new Set(expr.replace(QUOTED, " ").match(IDENTIFIER) ?? []);
}

/**
 * Every identifier the closed `[[…]]` of `content` mention, code included
 * (a reference in code IS written in, ADR-056 §3): whether a variable is
 * used by the texts. Lexical, as {@link identifiersIn}.
 */
export function namesMentioned(content: unknown): Set<string> {
  const names = new Set<string>();
  for (const expr of closedReferences(content, (text) => text)) {
    for (const name of identifiersIn(expr)) names.add(name);
  }
  return names;
}
