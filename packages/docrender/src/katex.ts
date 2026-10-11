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
 *   calls x the body of a macro, 499 calls to a 1000-character `\def`
 *   (2 KB) rendered for ~290 s; 250 calls to the `\df@tag` that `\tag{…}`
 *   defines, 3.7 KB, wrote 64 MB of HTML in 1.4 s — is closed by
 *   {@link forbiddenCommand}, and what is left by {@link FORMULA_HTML_MAX}.
 *
 * Deep nesting (~500 `\sqrt`, `\boxed` or superscripts) overflows the call
 * stack in ~40 ms: a `RangeError` that `throwOnError: false` does not catch,
 * so every caller catches it.
 */
export const KATEX_LIMITS = { maxSize: 10, maxExpand: 500 } as const;

/**
 * The most HTML one formula may produce, in UTF-16 code units: a renderer
 * that gets more shows the formula as refused instead of inserting it, so an
 * expansion path nobody foresaw cannot put megabytes into the grader's page
 * or the journal. KaTeX 0.18.7 (`htmlAndMathml`), 4 KB formulas without
 * definitions or internal names, measured: 255 nested `\overbrace` 583 KB
 * (the largest found; ~30 ms in Node, 16 + 247 ms of KaTeX, DOM and layout
 * in Chromium), 400 nested `\sqrt` 407 KB, 300 nested `\xrightarrow` 396 KB,
 * 409 nested `\frac` 379 KB, 203 aligned rows 300 KB, a 254-row matrix
 * 234 KB, 4096 plain letters 48 KB. 1 MB is above all of them and far
 * below the 64 MB the `\df@tag` path reached. The cap bounds what reaches
 * the page, not KaTeX's own time, which for these shapes stayed under
 * ~110 ms in Node (a cold first call is the slowest).
 */
export const FORMULA_HTML_MAX = 1024 * 1024;

/**
 * A command that defines or aliases a macro (`\global` prefixes them), a
 * backslash and the name with no letter after it, WHATEVER precedes the
 * backslash. Reading the source as KaTeX's lexer does would let `\\def`
 * through as a line break and letters — and `\verb\!\\def…` makes KaTeX
 * take that very `\def` as a command again (`\verb` with `\` as its
 * delimiter). So it refuses more than KaTeX would define: a line break
 * followed by "def" must be written `\\ def`.
 *
 * Or any control word with an `@`: KaTeX's internal names (`\df@tag`,
 * which `\tag{…}` defines, `\current@color`…), which its lexer reads as
 * commands like any other. No course formula calls one.
 */
const FORBIDDEN =
  /\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global)(?![A-Za-z@])|\\[A-Za-z]*@[A-Za-z@]*/;

/**
 * The first command of `tex` a formula may not use (`"\\def"`,
 * `"\\df@tag"`), or null. Every renderer calls it before KaTeX and refuses
 * the formula when it answers: a definition, or a call to one KaTeX made, is
 * the way a short formula expands into an unbounded one, and no course
 * formula needs either (nothing in the repository's content, seeds or
 * guides uses any). It over-refuses rather than under: a `\def` inside a
 * comment, a `\verb` or after `\\` is refused too.
 */
export function forbiddenCommand(tex: string): string | null {
  return FORBIDDEN.exec(tex)?.[0] ?? null;
}
