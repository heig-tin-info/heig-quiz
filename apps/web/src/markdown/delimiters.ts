/*
 * What the markdown tokenizers of this directory share about a delimiter of
 * our own (`{{…}}`, `[[…]]`): where one may start, and when a `[[…]]` is a
 * reference rather than a link's text. No Tiptap here: `render.ts`, the
 * student's renderer, imports it too.
 */
import { matchReference } from "@quiz/domain";

/**
 * The first place in `src` where `open` may begin a token: `open` itself, or
 * the backslash right before it, which makes the escaped spelling (`\{{`,
 * `\[[`) a token of its own. -1 when there is none (marked reads -1 as "not
 * here").
 */
export function escapableStart(src: string, open: string): number {
  const at = src.indexOf(open);
  return at > 0 && src[at - 1] === "\\" ? at - 1 : at;
}

/**
 * Whether the `[[…]]` that ends at `end` is the text of a LINK:
 * `[[1]](https://…)` is a link whose text is `[1]`, and stays one.
 */
export const isLinkText = (text: string, end: number): boolean => text[end] === "(";

/**
 * A closed `[[…]]` (or the escaped `\[[…]]`) at the start of `src`, unless it
 * is a link's text. The grammar is the interpolation's (`matchReference`).
 */
export function referenceAt(src: string): { raw: string; escaped: boolean } | undefined {
  const match = matchReference(src);
  return match && !isLinkText(src, match.raw.length) ? match : undefined;
}
