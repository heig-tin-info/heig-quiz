/**
 * Boolean expressions, the teacher's specification of a combinational output
 * (issue #459, ADR-123).
 *
 * SYNTAX. An identifier is `[A-Za-z][A-Za-z0-9_]*`, case-sensitive: `AB` is
 * ONE name, there is no implicit AND by juxtaposition (`A B` is an error).
 * Constants are `0` and `1`; parentheses group. Operators, from the tightest
 * to the loosest:
 *
 *     NOT   prefix `!` `~` `¬`, postfix `'`   (postfix binds before prefix: `!A'` is `!(A')`)
 *     AND   `*` `·` `&` `∧`
 *     XOR   `^` `⊕`
 *     OR    `+` `|` `∨`
 *
 * so `A + B * C ^ D` is `A + ((B * C) ^ D)`. Binary operators associate to
 * the left.
 *
 * ERRORS are a `LogicError` with the 0-based position (UTF-16 index) of the
 * offending character: `logic.unknown_identifier` for a name outside the
 * declared inputs, when the caller passes them; `logic.expression_invalid`
 * for anything else — a syntax error, a character beyond
 * `LOGIC_LIMITS.expressionLength`, or the parenthesis or prefix NOT that
 * nests deeper than `LOGIC_LIMITS.expressionDepth`.
 */
import { LOGIC_LIMITS, LogicError, type Bit } from "./netlist.js";

export type Expr =
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "const"; readonly value: Bit }
  | { readonly kind: "not"; readonly arg: Expr }
  | { readonly kind: "and" | "xor" | "or"; readonly left: Expr; readonly right: Expr };

type Binary = "and" | "xor" | "or";
type TokenType = "ident" | "const" | "not" | "postfix" | Binary | "(" | ")" | "end";
interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly position: number;
}

const SYMBOLS: Readonly<Record<string, TokenType>> = {
  "!": "not",
  "~": "not",
  "¬": "not",
  "'": "postfix",
  "*": "and",
  "·": "and",
  "&": "and",
  "∧": "and",
  "^": "xor",
  "⊕": "xor",
  "+": "or",
  "|": "or",
  "∨": "or",
  "(": "(",
  ")": ")",
  "0": "const",
  "1": "const",
};

const invalid = (position: number, detail = ""): LogicError => new LogicError("logic.expression_invalid", position, detail);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const ident = /[A-Za-z][A-Za-z0-9_]*/y;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    ident.lastIndex = i;
    const name = ident.exec(source)?.[0];
    const type = name ? "ident" : Object.hasOwn(SYMBOLS, c) ? SYMBOLS[c] : undefined;
    if (!type) throw invalid(i, c);
    const text = name ?? c;
    tokens.push({ type, text, position: i });
    i += text.length;
  }
  tokens.push({ type: "end", text: "", position: source.length });
  return tokens;
}

/** Binary levels from the loosest to the tightest: the parser's precedence and `toLatex`'s. */
const LEVELS: readonly Binary[] = ["or", "xor", "and"];

/** Parses one expression; with `declared`, every identifier must be one of those names. */
export function parseExpression(source: string, declared?: readonly string[]): Expr {
  if (source.length > LOGIC_LIMITS.expressionLength) throw invalid(LOGIC_LIMITS.expressionLength, "too long");
  const tokens = tokenize(source);
  let i = 0;
  let depth = 0;
  const peek = (): Token => tokens[i]!;
  /** Parses `inner` one nesting level deeper than `t`. */
  const nested = (t: Token, inner: () => Expr): Expr => {
    if (++depth > LOGIC_LIMITS.expressionDepth) throw invalid(t.position, "too deep");
    const e = inner();
    depth--;
    return e;
  };

  const binary = (level: number): Expr => {
    const op = LEVELS[level];
    if (!op) return unary();
    let left = binary(level + 1);
    while (peek().type === op) {
      i++;
      left = { kind: op, left, right: binary(level + 1) };
    }
    return left;
  };
  const unary = (): Expr => {
    const t = peek();
    if (t.type === "not") {
      i++;
      return { kind: "not", arg: nested(t, unary) };
    }
    let e = atom();
    while (peek().type === "postfix") {
      i++;
      e = { kind: "not", arg: e };
    }
    return e;
  };
  const atom = (): Expr => {
    const t = tokens[i++]!;
    if (t.type === "ident") {
      if (declared && !declared.includes(t.text)) throw new LogicError("logic.unknown_identifier", t.position, t.text);
      return { kind: "var", name: t.text };
    }
    if (t.type === "const") return { kind: "const", value: t.text === "1" ? 1 : 0 };
    if (t.type !== "(") throw invalid(t.position, t.text);
    const inner = nested(t, () => binary(0));
    const close = tokens[i++]!;
    if (close.type !== ")") throw invalid(close.position, close.text);
    return inner;
  };

  const expr = binary(0);
  if (peek().type !== "end") throw invalid(peek().position, peek().text);
  return expr;
}

/** The value of an expression; every variable it reads must be an own key of `env`. */
export function evaluate(expr: Expr, env: Readonly<Record<string, Bit>>): Bit {
  switch (expr.kind) {
    case "var":
      if (!Object.hasOwn(env, expr.name)) throw new LogicError("logic.unknown_identifier", null, expr.name);
      return env[expr.name]!;
    case "const":
      return expr.value;
    case "not":
      return (1 - evaluate(expr.arg, env)) as Bit;
    case "and":
      return (evaluate(expr.left, env) & evaluate(expr.right, env)) as Bit;
    case "xor":
      return (evaluate(expr.left, env) ^ evaluate(expr.right, env)) as Bit;
    case "or":
      return (evaluate(expr.left, env) | evaluate(expr.right, env)) as Bit;
  }
}

/** Binding strength: a binary operator by its level, NOT and atoms above every level. */
const strength = (e: Expr): number => (e.kind === "and" || e.kind === "xor" || e.kind === "or" ? LEVELS.indexOf(e.kind) : LEVELS.length);
const LATEX_OP: Readonly<Record<Binary, string>> = { and: " \\cdot ", xor: " \\oplus ", or: " + " };

/** LaTeX for KaTeX: `\overline` for NOT, `\cdot`, `\oplus`, `+`; a multi-letter name in `\mathrm`. */
export function toLatex(expr: Expr): string {
  switch (expr.kind) {
    case "var":
      return expr.name.length === 1 ? expr.name : `\\mathrm{${expr.name.replaceAll("_", "\\_")}}`;
    case "const":
      return String(expr.value);
    case "not":
      return `\\overline{${toLatex(expr.arg)}}`;
    default: {
      const side = (e: Expr): string => (strength(e) < strength(expr) ? `(${toLatex(e)})` : toLatex(e));
      return side(expr.left) + LATEX_OP[expr.kind] + side(expr.right);
    }
  }
}
