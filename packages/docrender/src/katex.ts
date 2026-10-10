/**
 * The bounds every KaTeX rendering of the platform runs under: the question
 * renderer and the rich editor of `apps/web`, and the journal's renderer
 * here (audit L15). A formula is written by someone other than its reader —
 * a co-author, a student in an essay the grader opens — so neither its size
 * nor its cost may be the author's to choose.
 *
 * - `maxSize` caps every user-specified size, in em: `\rule{1000em}{1000em}`
 *   draws a 10 em square, not a black sheet over the grader's screen. It caps
 *   positive sizes only; what a NEGATIVE one (`\kern{-40em}`) pushes out of
 *   the block is clipped by the `contain: paint` of `.md-body`
 *   (`apps/web/src/style.css`), which keeps whatever a formula draws inside
 *   the block it belongs to.
 * - `maxExpand` caps macro expansions per formula (KaTeX's default is 1000).
 *   Built-ins count too: a six-line aligned logic proof (`\iff` = 8,
 *   `\implies` = 10, `\neq` = 4, `\,`) needs about 70, so 500 leaves long
 *   derivations room. Measured on KaTeX 0.18.7 (Node, no DOM): a 4 KB
 *   formula of 990 calls to a 2000-character `\def` errors in ~360 ms at
 *   500 (at 1000 it rendered for minutes). The cap is NOT a time bound on
 *   its own: each expansion emits the macro's whole body, so the cost grows
 *   with calls x body length, superlinearly — 499 calls to a 100-character
 *   macro (1.1 KB) take ~5.5 s, to a 1000-character one (2 KB) ~290 s
 *   (at 100: 99 calls x 1000 characters, 1.2 KB, ~4.3 s). Bounding that needs
 *   a cap on the formula's length or output, which this constant is not.
 *
 * A subpath of its own (`@quiz/docrender/katex`), so the web app reads the
 * constant without pulling the renderer.
 */
export const KATEX_LIMITS = { maxSize: 10, maxExpand: 500 } as const;
