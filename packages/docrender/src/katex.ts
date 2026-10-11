/**
 * The bounds every KaTeX rendering of the platform runs under: the question
 * renderer, the rich editor and the formula dialog of `apps/web`, and the
 * journal's renderer here (audit L15). A formula is written by someone other
 * than its reader — a co-author, a student in an essay the grader opens — so
 * neither its size nor its cost may be the author's to choose.
 *
 * A subpath of its own (`@quiz/docrender/katex`), so the web app reads it
 * without pulling the renderer.
 */

/**
 * The options every `katex.render*` call spreads in.
 *
 * - `maxSize` caps every user-specified size, in em: `\rule{1000em}{1000em}`
 *   draws a 10 em square, not a black sheet over the grader's screen. It caps
 *   positive sizes only; what a NEGATIVE one (`\kern{-40em}`) pushes out of
 *   the block is clipped by the `contain: paint` of `.md-body`
 *   (`apps/web/src/style.css`). Not in `.md-inline` (a prompt or a choice
 *   flowing inside a label): an inline box cannot be contained, so a
 *   negative size there still paints outside — teachers' content only.
 * - `maxExpand` caps macro expansions per formula (KaTeX's default is 1000).
 *   Built-ins count too: a six-line aligned logic proof (`\iff` = 8,
 *   `\implies` = 10, `\neq` = 4) needs about 70, so 500 leaves a long
 *   derivation room. It is a belt: the blow-up it cannot stop on its own —
 *   calls x the body of a user-defined macro, 499 calls to a 1000-character
 *   `\def` (2 KB) rendered for ~290 s — is closed by
 *   {@link forbiddenMacroDefinition}.
 *
 * Without macro definitions, the cost follows the source. Measured on KaTeX
 * 0.18.7 for 4 KB formulas, worst case ~110 ms in Node (the server's journal)
 * and ~265 ms in Chromium, KaTeX plus DOM and layout (the grader's screen):
 * 255 nested `\overbrace` (580 KB of HTML; 16 + 247 ms in Chromium), 409
 * nested `\frac` (380 KB; 24 + 144 ms), 4096 plain letters (21 + 83 ms), 203
 * aligned rows or a 254-row matrix (under 60 ms). Deeper nesting (~500
 * `\sqrt`, `\boxed` or superscripts) overflows the call stack in ~40 ms: a
 * `RangeError` that `throwOnError: false` does not catch, so every caller
 * catches it.
 */
export const KATEX_LIMITS = { maxSize: 10, maxExpand: 500 } as const;

/**
 * A command that defines or aliases a macro (`\global` prefixes them), a
 * backslash and the name with no letter after it, WHATEVER precedes the
 * backslash. Reading the source as KaTeX's lexer does would let `\\def`
 * through as a line break and letters — and `\verb\!\\def…` makes KaTeX
 * take that very `\def` as a command again (`\verb` with `\` as its
 * delimiter). So it refuses more than KaTeX would define: a line break
 * followed by "def" must be written `\\ def`.
 */
const MACRO_DEFINITION =
  /\\(def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global)(?![A-Za-z@])/;

/**
 * The first command of `tex` that defines a macro (`"\\def"`), or null.
 * Every renderer calls it before KaTeX and refuses the formula when it
 * answers: a definition is the one way a short formula expands into an
 * unbounded one, and no course formula needs one (nothing in the repository's
 * content, seeds or guides uses any). It over-refuses rather than under: a
 * `\def` inside a comment, a `\verb` or after `\\` is refused too.
 */
export function forbiddenMacroDefinition(tex: string): string | null {
  const match = MACRO_DEFINITION.exec(tex);
  return match ? `\\${match[1]}` : null;
}
