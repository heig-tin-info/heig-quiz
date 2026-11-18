/**
 * The one image reference a Markdown field may draw (ADR-134), and the
 * images a text holds, read by `marked`'s lexer — the grammar of every
 * renderer of a statement (the web's, the journal's, the PDF's) — so a
 * picture inside a code span or a fence, or an escaped `\![x](y)`, is the
 * text it is, and a reference-style image is resolved as the renderers
 * resolve it.
 *
 * No Node API here: the web app imports this subpath.
 */
import { Marked, type Token } from "marked";

/** An asset id as the upload endpoint gives it; a fragment of {@link ASSET_REF}. */
export const ASSET_ID = "[A-Za-z0-9_-]{1,64}";

/**
 * `asset:<id>`, with an optional query that carries the width (`?w=50`):
 * the only image a statement draws. The web renderer, the PDF and the MCP
 * tools' check of foreign images all read it.
 */
export const ASSET_REF = new RegExp(`^asset:(${ASSET_ID})(?:\\?([A-Za-z0-9_=&%.-]{0,64}))?$`);

const lexer = new Marked({ gfm: true, breaks: false });

/** One image of a text: an `image` token's `href`, or the raw HTML that holds an `<img>`. */
export type MarkdownImage = { kind: "markdown"; href: string; raw: string } | { kind: "html"; raw: string };

/** Every image `text` holds, in order: Markdown images (inline or by reference) and raw `<img>` HTML. */
export function markdownImages(text: string): MarkdownImage[] {
  const found: MarkdownImage[] = [];
  lexer.walkTokens(lexer.lexer(text), (token: Token) => {
    if (token.type === "image") found.push({ kind: "markdown", href: (token.href ?? "").trim(), raw: token.raw });
    else if (token.type === "html" && /<img\b/i.test(token.raw)) found.push({ kind: "html", raw: token.raw });
  });
  return found;
}
