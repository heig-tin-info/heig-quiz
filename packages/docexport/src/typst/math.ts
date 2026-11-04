/**
 * LaTeX (the KaTeX subset a statement writes between `$`) into Typst maths,
 * through `tex2typst` (ADR-125 §1).
 *
 * The converter is not a sanitiser: `\text{a"b#c}` comes out as
 * `"a"b#c"`, a closed string followed by a code expression, and a macro it
 * does not know comes out as a bare name, which Typst refuses as an unknown
 * variable and with it the whole PDF. So its output is accepted only when
 * {@link safeTypstMath} reads it as maths alone: strings, single letters,
 * the names Typst knows (from the converter's own symbol table and the
 * functions it writes), numbers and operators. Anything else — a `#` but the
 * `#none` it writes for an empty base, a `$`, a comment, a label, a
 * reference, a name nobody knows — falls back to the LaTeX source in a raw
 * box, visible on the paper, and never fails the compile.
 */
import { shorthandMap, symbolMap, tex2typst } from "tex2typst";

/**
 * The functions `tex2typst` writes and the named arguments it passes them,
 * beside its symbol table: the accents, fonts, fractions, roots, matrices
 * and delimiters of Typst's maths.
 */
const FUNCTIONS = [
  "accent", "arrow", "attach", "binom", "bold", "breve", "cal", "cancel", "caron", "cases", "ceil", "circle",
  "dif", "display", "dot", "floor", "frac", "frak", "grave", "hat", "inline", "italic", "limits", "lr", "macron",
  "mat", "mono", "norm", "op", "overbrace", "overbracket", "overline", "root", "sans", "script", "scripts",
  "serif", "sqrt", "stretch", "tilde", "underbrace", "underbracket", "underline", "upright", "vec", "abs", "bb",
  "delim", "augment", "gap", "size", "none",
];

/** Every multi-letter name an accepted formula may use. */
const KNOWN: ReadonlySet<string> = new Set([
  ...[...symbolMap.values()].filter((v) => /^[A-Za-z][A-Za-z.]*$/.test(v)),
  ...shorthandMap.keys(),
  ...FUNCTIONS,
]);

/** A name (`alpha`, `arrow.r.long`), a number, a string, or one character. */
const TOKEN = /"(?:[^"\\]|\\.)*"|[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*|\d+(?:\.\d+)?|\\.|#none\b|\s+|[\s\S]/gy;

/** Never outside a string: code, a nested equation, a reference, raw. */
const FORBIDDEN = /[#$@`]/;

/** What may stand outside a string, a name or a number: operators and brackets, and letters of any script. */
const OPERATOR = /^[-+*/^_()[\]{},;&=<>!|':.~%?\p{L}\p{N}\p{S}]$/u;

/**
 * Whether `typst` is maths and nothing else: every name known, no code, no
 * comment, no label, no reference, no raw, no nested equation.
 */
export function safeTypstMath(typst: string): boolean {
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(typst); m; m = TOKEN.exec(typst)) {
    const token = m[0];
    const next = typst[m.index + token.length] ?? "";
    if (token === "#none" || /^\s/.test(token) || /^\d/.test(token)) continue;
    // A closed string is a string; a lone quote opens one that never closes.
    if (token[0] === '"') {
      if (token.length < 2) return false;
      continue;
    }
    // An escape is one character; a backslash at the very end escapes nothing.
    if (token[0] === "\\") {
      if (token.length < 2) return false;
      continue;
    }
    if (/^[A-Za-z]/.test(token)) {
      if (token.length > 1 && !KNOWN.has(token)) return false;
      continue;
    }
    if (FORBIDDEN.test(token) || !OPERATOR.test(token)) return false;
    // A comment (`//`, `/*`) or a label (`<name>`).
    if (token === "/" && (next === "/" || next === "*")) return false;
    if (token === "<" && /[A-Za-z]/.test(next)) return false;
  }
  return true;
}

/** The Typst maths of a LaTeX formula, or `null` when it does not convert into maths alone. */
export function latexToTypstMath(tex: string): string | null {
  let typst: string;
  try {
    typst = tex2typst(tex).trim();
  } catch {
    return null;
  }
  return typst !== "" && safeTypstMath(typst) ? typst : null;
}
