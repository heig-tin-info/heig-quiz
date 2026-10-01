/**
 * `[[expr]]` in the texts of a parameterized question (ADR-056 §3, §4).
 * Internal: `../parameters.ts` is the entry point.
 *
 * Every text field of the configuration and the explanation may hold
 * `[[h]]` or `[[sqrt(2*h/g)]]`; one pass replaces each by its value. `\[[`
 * writes a literal `[[` (the backslash goes). Inside the brackets, `[`/`]`
 * nest and quoted strings are skipped, so `[[max([a, b])]]` closes where a
 * reader expects. The caller scans only a parameterized question: a static
 * one keeps its `[[1,2],[3,4]]` as text.
 *
 * Inline expressions read the drawn values, never draw: the random functions
 * are refused there. A bare variable (`[[g]]`) is written with its row's
 * format, any other expression with the empty format.
 *
 * A JSON value is compiled once into a `Template` (every `[[…]]` parsed and
 * checked against the names in scope), then rendered with each set of values:
 * validation renders the same template 200 times.
 */
import { at, checkNames, checkValue, collect, compile, fail, run, type Compiled, type Issue } from "./evaluator.js";
import { formatValue } from "./format.js";

export type Values = Record<string, number | string>;

interface Reference {
  /** Offset of the opening `[[`. */
  offset: number;
  /** Offset just past the closing `]]`, or the text's length when unclosed. */
  end: number;
  expr: string;
  closed: boolean;
}

type Token = { text: string } | { ref: Reference };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let literal = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("\\[[", i)) {
      literal += "[[";
      i += 3;
    } else if (text.startsWith("[[", i)) {
      if (literal) tokens.push({ text: literal });
      literal = "";
      const ref = scanReference(text, i);
      tokens.push({ ref });
      i = ref.end;
    } else {
      literal += text[i];
      i += 1;
    }
  }
  if (literal) tokens.push({ text: literal });
  return tokens;
}

function scanReference(text: string, offset: number): Reference {
  let depth = 0;
  let quote = "";
  for (let j = offset + 2; j < text.length; j++) {
    const c = text[j]!;
    if (quote) {
      if (c === "\\") j += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth += 1;
    else if (c === "]" && depth > 0) depth -= 1;
    else if (c === "]" && text[j + 1] === "]") {
      return { offset, end: j + 2, expr: text.slice(offset + 2, j), closed: true };
    }
  }
  return { offset, end: text.length, expr: text.slice(offset + 2), closed: false };
}

/**
 * Calls `visit` on every string of a JSON value with its JSON-pointer path,
 * and returns a copy where each string is replaced by what `visit` returns.
 * Numbers, booleans and null are kept; the input is never mutated.
 */
function mapStrings<T>(json: T, visit: (text: string, path: string) => string, path = ""): T {
  if (typeof json === "string") return visit(json, path) as T;
  if (Array.isArray(json)) return json.map((item, i) => mapStrings(item, visit, `${path}/${i}`)) as T;
  if (json !== null && typeof json === "object") {
    // `fromEntries` defines own properties: a `__proto__` key stays a key.
    return Object.fromEntries(
      Object.entries(json).map(([key, item]) => [key, mapStrings(item, visit, `${path}/${key}`)]),
    ) as T;
  }
  return json;
}

/** A text piece: literal, or a checked expression and the format it is written with. */
type Piece = string | { compiled: Compiled; format: string; offset: number };

export interface Template<T> {
  /** Every unclosed, invalid or out-of-scope `[[…]]`, with its path and offset. */
  issues: Issue[];
  /** The JSON with every `[[…]]` replaced; throws a positioned `ParameterError`. */
  render(values: Values): T;
}

/** Compiles every `[[…]]` of a JSON value against the variables' formats (by name). */
export function compileTemplate<T>(json: T, formats: Record<string, string>): Template<T> {
  const known = new Set(Object.keys(formats));
  const issues: Issue[] = [];
  const texts = new Map<string, Piece[]>();
  mapStrings(json, (text, path) => {
    const pieces: Piece[] = tokenize(text).map((token) => {
      if ("text" in token) return token.text;
      const { ref } = token;
      const compiled = collect(issues, { path, offset: ref.offset }, () => {
        if (!ref.closed) fail("unterminated", "[[ without its ]]");
        const c = compile(ref.expr);
        checkNames(c, known, false);
        return c;
      });
      const name = ref.expr.trim();
      return compiled ? { compiled, format: Object.hasOwn(formats, name) ? formats[name]! : "", offset: ref.offset } : "";
    });
    texts.set(path, pieces);
    return text;
  });
  return {
    issues,
    render(values) {
      const scope = new Map<string, unknown>(Object.entries(values));
      return mapStrings(json, (_, path) =>
        texts
          .get(path)!
          .map((piece) =>
            typeof piece === "string"
              ? piece
              : at({ path, offset: piece.offset }, () => formatValue(checkValue(run(piece.compiled, scope)), piece.format)),
          )
          .join(""),
      );
    },
  };
}
