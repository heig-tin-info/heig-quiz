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
 *   Every expansion can emit a macro's whole body, so the cap is the factor a
 *   `\def` can multiply a formula by: a 4 KB formula of 990 calls to a
 *   2000-character macro froze a renderer for minutes at 1000. A six-line
 *   aligned logic proof (`\iff`, `\implies`, `\neq`, `\,`) needs about 70.
 *
 * A subpath of its own (`@quiz/docrender/katex`), so the web app reads the
 * constant without pulling the renderer.
 */
export const KATEX_LIMITS = { maxSize: 10, maxExpand: 100 } as const;
