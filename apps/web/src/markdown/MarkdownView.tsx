import { useMemo } from "react";

import { useT } from "../i18n";
import { cx } from "../ui";
import { renderMarkdown } from "./render";

/**
 * Renders untrusted markdown — a question prompt, a choice, an explanation, a
 * teacher comment — through the sanitising pipeline of `render.ts`.
 *
 * It is the ONE renderer a student ever sees. `markdown.tsx` next to it is a
 * different thing: trusted help text we author, turned into React elements
 * and never into HTML. Neither replaces the other, and neither should grow
 * into the other.
 *
 * Every visual value lives in the `.md-body` block of `style.css` (the one
 * place a stylesheet is unavoidable, because the content is HTML this
 * component never sees as elements). `size="sm"` is the dense variant for a
 * table cell or a dashboard inspection panel.
 */
export function MarkdownView({
  source,
  className = "",
  size = "md",
  as: Tag = "div",
  inline = false,
}: {
  source: string;
  className?: string;
  size?: "sm" | "md";
  /** `span` for a one-line cell, where a <div> would break the row. */
  as?: "div" | "span";
  /**
   * WP9: student player — renders inside a host element that already is a
   * paragraph or a label (a question prompt, one choice of an mcq). It renders
   * a `span` and drops the wrapping `<p>` when the source is a single
   * paragraph, which is what a `<p><div>` nesting would otherwise cost.
   * Multi-block content keeps its blocks, inside the span.
   */
  inline?: boolean;
}) {
  const t = useT();
  const codeLabel = t("markdown.codeBlock");
  const Element = inline ? "span" : Tag;
  const html = useMemo(
    () =>
      inline
        ? unwrapParagraph(renderMarkdown(source, codeLabel))
        : renderMarkdown(source, codeLabel),
    [source, inline, codeLabel],
  );
  if (!html) return null;
  return (
    <Element
      className={cx("md-body", size === "sm" && "md-sm", inline && "md-inline", className)}
      // Sanitised by `renderMarkdown`: allow-listed tags and attributes, no
      // script, no foreign origin, no `javascript:`. See render.ts.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * A single `<p>…</p>` loses its wrapper; anything else is left alone. The
 * check is deliberately literal (one opening tag, at the very start, closed at
 * the very end): a regex clever enough to handle two paragraphs would be a
 * regex clever enough to break one.
 */
function unwrapParagraph(html: string): string {
  const trimmed = html.trimEnd();
  if (!trimmed.startsWith("<p>") || !trimmed.endsWith("</p>")) return html;
  const inner = trimmed.slice(3, -4);
  return inner.includes("<p>") || inner.includes("</p>") ? html : inner;
}
