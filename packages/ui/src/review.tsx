/**
 * The scaffolding the type reviews share: the statement they open with and
 * the header row of their results tables. What a review shows under them is
 * its own.
 */
import type { ReactNode } from "react";

import { showsSection, type MarkdownRenderer, type ReviewSections } from "@quiz/core/client";

import { markdown } from "./content.js";
import { cx, reviewPrompt, table } from "./styles.js";

/**
 * The statement, so a verdict is never read without the question it judges —
 * unless the reader chose to hide it (`sections`, #109). `as` keeps each
 * type's element: a `p` for a prompt that is one paragraph, a `div` for one
 * that may hold blocks. `preWrap` keeps the line breaks of a program's or a
 * circuit's statement.
 */
export function ReviewPrompt({
  prompt,
  sections,
  renderMarkdown,
  as: Tag = "div",
  preWrap = false,
}: {
  prompt: string;
  sections: ReviewSections | undefined;
  renderMarkdown: MarkdownRenderer | undefined;
  as?: "p" | "div";
  preWrap?: boolean;
}): ReactNode {
  if (!showsSection(sections, "prompt")) return null;
  return <Tag className={preWrap ? cx("whitespace-pre-wrap", reviewPrompt) : reviewPrompt}>{markdown(renderMarkdown, prompt)}</Tag>;
}

/** The header row of a results table: its {@link Th} cells, in order. */
export function TableHead({ children }: { children: ReactNode }): ReactNode {
  return (
    <thead className={table.head}>
      <tr>{children}</tr>
    </thead>
  );
}

/** A column header; `right` for a column of numbers. */
export function Th({ right = false, children }: { right?: boolean; children: ReactNode }): ReactNode {
  return (
    <th scope="col" className={cx(table.th, right && "text-right")}>
      {children}
    </th>
  );
}
