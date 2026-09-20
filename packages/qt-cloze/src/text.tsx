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

export interface ClozeTextProps {
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

type Block = { kind: "code"; content: string } | { kind: "paragraph"; content: string };

/** Fenced code blocks first (their content is verbatim), then blank-line paragraphs. */
export function splitBlocks(template: string): Block[] {
  const blocks: Block[] = [];
  const lines = template.split("\n");
  let buffer: string[] = [];
  let fenced = false;

  const flush = (kind: Block["kind"]) => {
    const content = buffer.join("\n");
    buffer = [];
    if (kind === "code") {
      blocks.push({ kind, content });
      return;
    }
    for (const paragraph of content.split(/\n{2,}/)) {
      if (paragraph.trim() !== "") blocks.push({ kind: "paragraph", content: paragraph });
    }
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

export function ClozeFallbackText({ template, renderBlank }: ClozeTextProps) {
  return (
    <>
      {splitBlocks(template).map((block, i) =>
        block.kind === "code" ? (
          <pre
            key={`b${i}`}
            className="overflow-x-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-[13px] leading-7 text-fg"
          >
            <code>{withBlanks(block.content, `b${i}`, renderBlank, false)}</code>
          </pre>
        ) : (
          <p key={`b${i}`} className="text-base leading-9 text-fg">
            {withBlanks(block.content, `b${i}`, renderBlank, true)}
          </p>
        ),
      )}
    </>
  );
}
