import { useMemo } from "react";

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
}: {
  source: string;
  className?: string;
  size?: "sm" | "md";
  /** `span` for a one-line cell, where a <div> would break the row. */
  as?: "div" | "span";
}) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  if (!html) return null;
  return (
    <Tag
      className={cx("md-body", size === "sm" && "md-sm", className)}
      // Sanitised by `renderMarkdown`: allow-listed tags and attributes, no
      // script, no foreign origin, no `javascript:`. See render.ts.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
