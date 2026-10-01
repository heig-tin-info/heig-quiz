/**
 * `[[expr]]` in the texts of a parameterized question (ADR-056 §3, §4).
 *
 * Every text field of the configuration and the explanation may hold
 * `[[h]]` or `[[sqrt(2*h/g)]]`; one pass replaces each by its value. `\[[`
 * writes a literal `[[` (the backslash goes). Inside the brackets, `[`/`]`
 * nest and quoted strings are skipped, so `[[choice([1, 2])]]`-like text and
 * `[[max([a, b])]]` close where a reader expects. The caller scans only a
 * parameterized question: a static one keeps its `[[1,2],[3,4]]` as text.
 *
 * Inline expressions read the drawn values, never draw: the random functions
 * are refused there. A bare variable (`[[g]]`) is written with its row's
 * format when the caller passes the formats, any other expression with the
 * empty format (up to 6 significant figures).
 */
import { checkNames, checkValue, compile, ParameterError, run } from "./evaluator.js";
import { formatValue } from "./format.js";

export type Values = Record<string, number | string>;

export interface Reference {
  /** Offset of the opening `[[`. */
  offset: number;
  /** Offset just past the closing `]]`, or the text's length when unclosed. */
  end: number;
  /** What lies between the brackets. */
  expr: string;
  /** False when no `]]` closes it. */
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

/** Each `[[…]]` of a text, in order, with its position (for validation and the editor). */
export function references(text: string): Reference[] {
  return tokenize(text).flatMap((t) => ("ref" in t ? [t.ref] : []));
}

/**
 * Checks one reference against the names in scope, statically, and returns
 * its compiled form. Throws a `ParameterError` positioned at the `[[`.
 */
export function checkReference(ref: Reference, known: ReadonlySet<string>) {
  try {
    if (!ref.closed) throw new ParameterError({ code: "unterminated", message: "[[ without its ]]" });
    const compiled = compile(ref.expr);
    checkNames(compiled, known, false);
    return compiled;
  } catch (e) {
    const issue = (e as ParameterError).issue;
    throw new ParameterError({ ...issue, offset: ref.offset });
  }
}

/**
 * Replaces every `[[expr]]` of `text` with its formatted value. Throws a
 * `ParameterError` (code and offset) on an unclosed, invalid or failing
 * reference.
 */
export function interpolate(text: string, values: Values, formats: Record<string, string> = {}): string {
  const scope = new Map<string, unknown>(Object.entries(values));
  const known = new Set(scope.keys());
  let out = "";
  for (const token of tokenize(text)) {
    if ("text" in token) {
      out += token.text;
      continue;
    }
    const compiled = checkReference(token.ref, known);
    let value: number | string;
    try {
      value = checkValue(run(compiled, scope));
    } catch (e) {
      throw new ParameterError({ ...(e as ParameterError).issue, offset: token.ref.offset });
    }
    const name = token.ref.expr.trim();
    out += formatValue(value, Object.hasOwn(formats, name) ? formats[name]! : "");
  }
  return out;
}

/**
 * Calls `visit` on every string of a JSON value with its JSON-pointer path,
 * and returns a copy where each string is replaced by what `visit` returns.
 * Numbers, booleans and null are kept; the input is never mutated.
 */
export function mapStrings<T>(json: T, visit: (text: string, path: string) => string, path = ""): T {
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

/** `interpolate` on every string of a JSON value (ADR-056 §4); a new value, the input untouched. */
export function instantiate<T>(json: T, values: Values, formats: Record<string, string> = {}): T {
  return mapStrings(json, (text, path) => {
    try {
      return interpolate(text, values, formats);
    } catch (e) {
      throw new ParameterError({ ...(e as ParameterError).issue, path });
    }
  });
}
