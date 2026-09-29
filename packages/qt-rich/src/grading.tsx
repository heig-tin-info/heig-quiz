/**
 * The `rich` column of the grading table (ADR-040): ONE wide column, the
 * essay as plain text clamped to three lines — enough to tell a paragraph
 * from a sentence and a sentence from nothing; the answer panel has the
 * rest. The expected row holds the model answer, else the rubric: both are
 * the grader's, and a teacher reads them beside every answer (ADR-037).
 *
 * The text is PLAIN: an essay written in the formatted field is markdown,
 * and its marks are stripped here rather than rendered — a cell is a line
 * of reading, and nothing a student typed is ever set as HTML.
 */
import type { GradingColumn, QuestionTypeGrading } from "@quiz/core/client";
import { gradingSortKey, resolveStrings } from "@quiz/core/client";
import { cx, Dash } from "@quiz/ui";

import type { RichAnswer, RichDetails, RichSolution, RichStudent } from "./schema.js";
import { richGradingStrings } from "./strings.js";

/**
 * Markdown as the words a reader sees: code fences, headings, quotes, list
 * markers, emphasis, links (their text), images (their alt text) and HTML
 * tags removed — only what is shaped like one (`<` then a letter, up to
 * `>`), so a spaced comparison stays ("x < y and y > z", "while i<n"),
 * while "i<n and y>z" reads as a tag, as a browser would read it — backslash
 * escapes undone, whitespace collapsed. A reading aid, not a parser: what
 * it misses stays as typed, never as markup.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/(\*\*|__|~~)(\S(?:[^]*?\S)?)\1/g, "$2")
    .replace(/(?<![\w*])([*_])(\S(?:[^]*?\S)?)\1(?![\w*])/g, "$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const ESSAY = "line-clamp-3 max-w-[110ch] text-[13px] leading-[1.45]";

export const richGrading: QuestionTypeGrading<RichStudent, RichAnswer, RichSolution, RichDetails> = {
  columns(student, solution, strings) {
    const s = resolveStrings(richGradingStrings, strings);
    const textOf = (answer: RichAnswer | null) => {
      const text = answer?.text ?? "";
      return student.format === "markdown" ? plainText(text) : text.replace(/\s+/g, " ").trim();
    };
    const guide = solution?.reference?.trim() || solution?.rubric?.trim() || "";
    const column: GradingColumn<RichAnswer, RichDetails> = {
      key: "essay",
      label: s.essay,
      cell: ({ answer }) => {
        const text = textOf(answer);
        return text === "" ? <Dash /> : <p className={cx(ESSAY, "text-fg-muted")}>{text}</p>;
      },
      expected: () =>
        guide === "" ? (
          <Dash />
        ) : (
          <p className={cx(ESSAY, "text-info")}>{plainText(guide)}</p>
        ),
      sortKey: (answer) => gradingSortKey(textOf(answer)),
    };
    return [column];
  },
};
