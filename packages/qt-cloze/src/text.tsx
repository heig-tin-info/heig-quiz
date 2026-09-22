/**
 * Rendering the cloze text with its blanks in place (decision D5).
 *
 * The parser replaces every `{{…}}` by the sentinel `⸢<index>⸣`, which keeps
 * the markdown's block structure intact — lists, tables and fenced code blocks
 * survive — and leaves the renderer one job: swap the sentinel text nodes for
 * input components.
 *
 * A `qt-*` package owns no markdown renderer (it cannot depend on `apps/web`),
 * so the host injects its own sanitised one through `renderText`. What lives
 * here is the fallback: paragraphs, fenced code blocks, inline code, bold and
 * italic. It is deliberately small; `apps/web` will pass its `MarkdownView`.
 */
import type { ReactNode } from "react";
import { CLOZE_SENTINEL_PATTERN } from "@quiz/domain";
import { cx } from "./ui.js";

interface ClozeTextProps {
  /** The sentinel-bearing markdown, exactly as `toStudent` sent it. */
  template: string;
  /** The control (or the verdict) to place at blank `index`. */
  renderBlank: (index: number) => ReactNode;
}

/** What `apps/web` injects to render the text with its own markdown pipeline. */
export type ClozeTextRenderer = (props: ClozeTextProps) => ReactNode;

const SENTINEL = new RegExp(CLOZE_SENTINEL_PATTERN, "g");
const INLINE = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;

/** Inline markdown of one plain-text run: bold, italic, code. Nothing else. */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  let i = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyBase}-i${i}`;
    if (match[2] !== undefined) nodes.push(<strong key={key}>{match[2]}</strong>);
    else if (match[4] !== undefined) nodes.push(<em key={key}>{match[4]}</em>);
    else if (match[6] !== undefined)
      nodes.push(
        <code key={key} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.9em]">
          {match[6]}
        </code>,
      );
    last = match.index + match[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Splits a run on the sentinels and interleaves the blanks. Used for a
 * paragraph (with inline markdown) and for a code fence (verbatim).
 */
function withBlanks(
  source: string,
  keyBase: string,
  renderBlank: (index: number) => ReactNode,
  format: boolean,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  SENTINEL.lastIndex = 0;
  while ((match = SENTINEL.exec(source)) !== null) {
    const before = source.slice(last, match.index);
    if (before !== "") nodes.push(...(format ? inline(before, `${keyBase}-${last}`) : [before]));
    nodes.push(
      <span key={`${keyBase}-b${match[1]}`} className="inline-block align-baseline">
        {renderBlank(Number(match[1]))}
      </span>,
    );
    last = match.index + match[0].length;
  }
  const rest = source.slice(last);
  if (rest !== "") nodes.push(...(format ? inline(rest, `${keyBase}-${last}`) : [rest]));
  return nodes;
}

export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { kind: "code"; content: string }
  | { kind: "paragraph"; content: string }
  | { kind: "table"; header: string[]; rows: string[][]; align: TableAlign[] };

/** A GFM delimiter row: `| --- | :--: |`. What tells a table from a paragraph. */
const DELIMITER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const isRow = (line: string) => line.trimStart().startsWith("|");

/** Splits one row on its unescaped pipes, dropping the outer ones. */
function cells(line: string): string[] {
  const out: string[] = [];
  let current = "";
  const trimmed = line.trim();
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
      current += trimmed[i + 1];
      i += 1;
      continue;
    }
    if (trimmed[i] === "|") {
      out.push(current);
      current = "";
      continue;
    }
    current += trimmed[i];
  }
  out.push(current);
  if (out[0]?.trim() === "") out.shift();
  if (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
  return out.map((cell) => cell.trim());
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/**
 * One run of text, cut into paragraphs and GFM TABLES.
 *
 * A table is not decoration here: a `cloze` hole inside a table cell is the
 * shape predefined choice sets exist for (docs/04 §4.6), and a student shown
 * `| Directe | ⸢3⸣ |` as a line of prose would be reading the source of the
 * question rather than the question.
 */
function paragraphsAndTables(content: string): Block[] {
  const out: Block[] = [];
  const lines = content.split("\n");
  let buffer: string[] = [];
  const flushText = () => {
    const text = buffer.join("\n");
    buffer = [];
    for (const paragraph of text.split(/\n{2,}/)) {
      if (paragraph.trim() !== "") out.push({ kind: "paragraph", content: paragraph });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (isRow(line) && next !== undefined && isRow(next) && DELIMITER.test(next)) {
      flushText();
      const header = cells(line);
      const align = cells(next).map(alignOf);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && isRow(lines[j]!); j += 1) rows.push(cells(lines[j]!));
      out.push({ kind: "table", header, rows, align });
      i = j - 1;
      continue;
    }
    buffer.push(line);
  }
  flushText();
  return out;
}

/** Fenced code blocks first (their content is verbatim), then tables and paragraphs. */
export function splitBlocks(template: string): Block[] {
  const blocks: Block[] = [];
  const lines = template.split("\n");
  let buffer: string[] = [];
  let fenced = false;

  const flush = (kind: "code" | "paragraph") => {
    const content = buffer.join("\n");
    buffer = [];
    if (kind === "code") {
      blocks.push({ kind, content });
      return;
    }
    blocks.push(...paragraphsAndTables(content));
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      flush(fenced ? "code" : "paragraph");
      fenced = !fenced;
      continue;
    }
    buffer.push(line);
  }
  flush(fenced ? "code" : "paragraph");
  return blocks;
}

/** The three alignments a GFM delimiter row can ask for. */
const alignClass = (align: TableAlign): string =>
  align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";

export function ClozeFallbackText({ template, renderBlank }: ClozeTextProps) {
  return (
    <>
      {splitBlocks(template).map((block, i) => {
        if (block.kind === "code") {
          return (
            <pre
              key={`b${i}`}
              className="overflow-x-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-[13px] leading-7 text-fg"
            >
              <code>{withBlanks(block.content, `b${i}`, renderBlank, false)}</code>
            </pre>
          );
        }
        if (block.kind === "table") {
          return (
            <div key={`b${i}`} className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {block.header.map((cell, c) => (
                      <th
                        key={c}
                        className={cx(
                          "border-b border-line px-2.5 py-1.5 font-semibold text-fg-muted",
                          alignClass(block.align[c] ?? null),
                        )}
                      >
                        {withBlanks(cell, `b${i}-h${c}`, renderBlank, true)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td
                          key={c}
                          className={cx(
                            "border-b border-line px-2.5 py-1.5 text-fg",
                            alignClass(block.align[c] ?? null),
                          )}
                        >
                          {withBlanks(cell, `b${i}-${r}-${c}`, renderBlank, true)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={`b${i}`} className="text-base leading-9 text-fg">
            {withBlanks(block.content, `b${i}`, renderBlank, true)}
          </p>
        );
      })}
    </>
  );
}
