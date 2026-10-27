/**
 * French spacing, applied when markdown is RENDERED and never to the stored
 * source.
 *
 * An author writes `automatiquement :` with the space of their keyboard, and
 * the browser is then free to break the line before the colon, leaving a `:`
 * alone at the start of the next line. French typography puts a narrow
 * no-break space (U+202F) before `:` `;` `!` `?` `»` and after `«`; the
 * renderers (`render.ts` here, and `apps/web/src/markdown/render.ts`) pass
 * the plain text of a page through {@link frenchSpacing} so the space the
 * author typed becomes that one. U+202F everywhere, as the French dictionary
 * of the web app already writes it (`apps/web/src/i18n/fr.ts`).
 *
 * The rule only ever REPLACES a space: `mot:` stays `mot:`, because adding
 * one would rewrite English, a time (`10:30`), a URL or a ratio the author
 * wrote on purpose. Which is also why there is no language detection: in
 * English a space before `:` is already a typo, and making it non-breaking
 * changes nothing a reader can see.
 *
 * It sees TEXT only — the caller hands it marked's plain text tokens, never
 * code, maths, a link's target or raw HTML — so a ternary `a ? b : c` in a
 * code span keeps its spaces.
 */
import type { Token } from "marked";

/** A horizontal space an author may have typed, U+00A0 and U+202F included. */
const SPACE = "[ \\t\\u00A0\\u202F]";

/**
 * The spaces before a closing mark, with at most one line break among them:
 * a soft break (`mot\n:`) is a space to the reader. Two line breaks are a
 * new paragraph and never reach one text token.
 */
const BEFORE = new RegExp(`${SPACE}*(?:\\n${SPACE}*)?(?=[:;!?\\u00BB])`, "g");

/** `«` and the spaces after it, under the same rule. */
const AFTER = new RegExp(`\\u00AB${SPACE}*(?:\\n${SPACE}*)?`, "g");

/** The narrow no-break space. */
export const NNBSP = "\u202F";

/**
 * `text` with every run of spaces before `:` `;` `!` `?` `»`, and after `«`,
 * replaced by one U+202F. A run at the very start of `text` counts too: in
 * `**gras** :` the text token is ` :`, the word it follows being the bold.
 */
export function frenchSpacing(text: string): string {
  return text
    .replace(AFTER, (run) => (run.length > 1 ? `«${NNBSP}` : run))
    .replace(BEFORE, (run) => (run ? NNBSP : run));
}

/**
 * The `walkTokens` hook both renderers install: {@link frenchSpacing} on
 * every LEAF text token, before marked escapes it. Leaf, because a text token
 * with children (the tight item of a list) holds its line as markdown —
 * code spans and all — and is rendered from those children, which the walk
 * reaches on its own. An `escaped` one is text inside a raw `<pre>` or
 * `<script>`, shown as typed. Code, maths, `[[…]]`, autolinks' and links'
 * targets and raw HTML are tokens of other types and never come here; a
 * link's TEXT is a text token, and is spaced like any other.
 */
export function spaceTextToken(token: Token): void {
  if (token.type !== "text" || token.tokens?.length || token.escaped) return;
  token.text = frenchSpacing(token.text);
}
