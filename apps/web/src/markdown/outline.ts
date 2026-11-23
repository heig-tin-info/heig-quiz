import { Lexer, type Token } from "marked";

import { decodeEntities } from "@quiz/docexport/entities";

/**
 * The outline of a teacher's markdown text, as plain words: its title and its
 * first paragraph. What names the text before a question (ADR-084) in the
 * student's question list and in the builder's folded band — never what
 * renders it (`MarkdownView` does).
 *
 * Read with marked's lexer, the parser the renderer is built on, so a line
 * inside a code fence is never taken for a heading, and what counts as a
 * heading is what the student sees as one.
 */

/** The words of inline tokens: emphasis, links and code spans dropped to their text, raw HTML dropped. */
function inlineText(tokens: readonly Token[] | undefined): string {
  return (tokens ?? [])
    .map((token) => {
      if (token.type === "html") return "";
      if (token.type === "br") return " ";
      if ("tokens" in token && token.tokens !== undefined && token.tokens.length > 0) {
        return inlineText(token.tokens);
      }
      return "text" in token && typeof token.text === "string" ? token.text : "";
    })
    .join("");
}

/** The words of a block: a paragraph, a quote, a list. */
function blockText(token: Token): string {
  switch (token.type) {
    case "blockquote":
      return (token.tokens ?? []).map(blockText).join(" ");
    case "list":
      return (token.items as Token[])
        .map((item) => ("tokens" in item ? (item.tokens ?? []).map(blockText).join(" ") : ""))
        .join(" ");
    case "paragraph":
    case "text":
    case "heading":
      return inlineText(token.tokens);
    default:
      return "";
  }
}

const tidy = (text: string): string => decodeEntities(text).replace(/\s+/g, " ").trim();

/**
 * The text of the FIRST heading of the markdown, wherever it stands among the
 * top-level blocks (after a paragraph too), at any level, ATX (`## …`) or
 * setext (underlined): its emphasis, links and code spans stripped to their
 * words. `null` when the text has none, or only an empty one. A `#` line
 * inside a code fence is code, not a heading.
 */
export function markdownTitle(markdown: string): string | null {
  for (const token of Lexer.lex(markdown)) {
    if (token.type !== "heading") continue;
    const title = tidy(inlineText(token.tokens));
    if (title !== "") return title;
  }
  return null;
}

/**
 * The first prose block of the markdown, as one line of words: a paragraph,
 * a quote or a list, whichever comes first. Headings, code blocks, tables and
 * rules are skipped: a summary of the text, not of its code. `""` when there
 * is no prose.
 */
export function markdownLead(markdown: string): string {
  for (const token of Lexer.lex(markdown)) {
    if (token.type !== "paragraph" && token.type !== "blockquote" && token.type !== "list") continue;
    const lead = tidy(blockText(token));
    if (lead !== "") return lead;
  }
  return "";
}
