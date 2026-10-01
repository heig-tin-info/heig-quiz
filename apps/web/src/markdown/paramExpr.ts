/*
 * The `[[expr]]` reference of a parameterized question (ADR-056 §3) in the
 * rich editor: TEXT, under a mark that keeps it verbatim.
 *
 * The interpolation reads the STORED markdown, character for character, before
 * any markdown renderer sees it. The serializer of `@tiptap/markdown`
 * backslash-escapes `` \ ` * _ [ ] ~ `` in every text node and encodes
 * `& < >`, so a reference typed as text was stored `\[\[h\*w\]\]` and was no
 * reference any more: the Try tab, the five draws and the student showed
 * `[[h]]` raw. On the way in, marked's emphasis rule ate the `*` pair of
 * `[[a*b]] and [[c*d]]` before the editor even held it.
 *
 * Why a mark, and not an atom like the `{{…}}` hole of `clozeHole.ts`:
 *  - the serializer skips the escaping (and the entities) for any text under
 *    a mark declared `code` — its own, documented rule for inline code — so
 *    the expression is written back byte for byte without touching the
 *    library;
 *  - a reference stays TEXT: the teacher edits `[[h]]` into `[[h*2]]` in
 *    place, and it keeps the bold around it (`**[[v]] m/s**`), which an atom
 *    loses — `@tiptap/markdown` applies a mark to text nodes only;
 *  - nothing has to recognise the keystroke or the paste: one plugin
 *    re-derives the mark from the text after every change, so a reference is
 *    marked exactly when the interpolation would read one, however it got
 *    there (typed, pasted, a bracket deleted, a line joined).
 * On the way in, the tokenizer takes the reference out of marked's inline
 * stream before any emphasis rule sees it. The grammar is not re-implemented:
 * the editor's walk is `referenceSpans` and the tokenizer's test is
 * `matchReference`, both from `@quiz/domain`, the very walk of the
 * interpolation (nesting and quotes included). The ADR's escape `\[[…]]` is
 * a match too, kept with its backslash.
 *
 * ALWAYS registered, in every field, and not only in a parameterized question:
 * `@tiptap/markdown` puts a tokenizer on the marked SINGLETON (the
 * `ClozeHoleFallback` comment says what that costs), and a field without a
 * handler would drop the token. In a static question it is harmless: a
 * `[[…]]` stored verbatim renders as the same characters.
 */
import { decodeHtmlEntities, Mark, mergeAttributes } from "@tiptap/core";
import type { JSONContent, MarkdownParseHelpers, MarkdownRendererHelpers, MarkdownToken } from "@tiptap/core";
import type { MarkType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { referenceSpans } from "@quiz/domain";

import { escapableStart, isLinkText, referenceAt } from "./delimiters";

/*
 * THE OLD SPELLING. Before this mark existed the editor stored a reference as
 * `\[\[h\*w\]\]` — every bracket and every special character escaped. That is
 * not the ADR's escape (`\[[`, the second bracket bare), so reading it back as
 * the reference the teacher typed is unambiguous, and the next save of the
 * field stores `[[h*w]]`. Nothing is rewritten on the server, and a version
 * PUBLISHED with this spelling stays literal until it is re-edited and
 * republished (ADR-056, addendum of 2026-10-01).
 */
const LEGACY = /^\\\[\\\[((?:\\[\\`*_[\]~]|[^\\\n])*?)\\\]\\\](?!\()/;

/** The reference at the start of `src`, as the text the editor holds. */
function matchToken(src: string): { raw: string; text: string } | undefined {
  const current = referenceAt(src);
  if (current) return { raw: current.raw, text: current.raw };
  const legacy = LEGACY.exec(src);
  if (!legacy) return undefined;
  const expr = decodeHtmlEntities((legacy[1] ?? "").replace(/\\([\\`*_[\]~])/g, "$1"));
  return { raw: legacy[0], text: `[[${expr}]]` };
}

/** Where a reference may start in `src`: `[[`, the `\` of `\[[`, or the old `\[\[`. */
function startOf(src: string): number {
  const at = escapableStart(src, "[[");
  const legacy = src.indexOf("\\[\\[");
  if (at === -1) return legacy;
  return legacy === -1 ? at : Math.min(at, legacy);
}

/** Stands for what a reference cannot span: an atom, a hard break, code. */
const OPAQUE = "\uFFFC";

/**
 * The CLOSED references of `text` the editor keeps verbatim, as `[from, to)`
 * offsets: the interpolation's own walk (`referenceSpans`), filtered. Not
 * one that spans something OPAQUE, nor a link's text, nor one after an odd
 * number of backticks — a code span being typed, which its closing backtick
 * will make code. The backticks are counted as the walk goes, once.
 */
export function references(text: string): [number, number][] {
  const found: [number, number][] = [];
  let ticks = 0;
  let counted = 0;
  for (const { from, to, closed } of referenceSpans(text)) {
    for (; counted < from; counted += 1) if (text[counted] === "`") ticks += 1;
    if (!closed || ticks % 2 === 1 || isLinkText(text, to)) continue;
    if (!text.slice(from, to).includes(OPAQUE)) found.push([from, to]);
  }
  return found;
}

/**
 * A textblock's text, one character per position: an inline atom and the
 * text of another code mark are OPAQUE, so a reference never reaches into
 * inline code and an offset is a position.
 */
function blockText(block: ProseMirrorNode, type: MarkType): string {
  let text = "";
  block.forEach((child) => {
    const code = child.marks.some((m) => m.type !== type && m.type.spec.code === true);
    text += child.isText && !code ? child.text! : OPAQUE.repeat(child.nodeSize);
  });
  return text;
}

/** Puts the mark exactly on the references of one textblock; false when it already was. */
function normalizeBlock(block: ProseMirrorNode, pos: number, tr: Transaction, type: MarkType): boolean {
  const start = pos + 1;
  const wanted = references(blockText(block, type)).map(([a, b]) => `${a + start}:${b + start}`);
  const present: string[] = [];
  block.forEach((child, offset) => {
    if (!type.isInSet(child.marks)) return;
    const from = start + offset;
    const last = present.at(-1)?.split(":");
    // Two adjacent text nodes under the mark (another mark changes between
    // them) are ONE marked range.
    if (last && Number(last[1]) === from) present[present.length - 1] = `${last[0]}:${from + child.nodeSize}`;
    else present.push(`${from}:${from + child.nodeSize}`);
  });
  if (wanted.join() === present.join()) return false;
  tr.removeMark(start, start + block.content.size, type);
  for (const range of wanted) {
    const [from, to] = range.split(":").map(Number);
    tr.addMark(from!, to!, type.create());
  }
  return true;
}

/**
 * The ranges of the final document the transactions wrote: each step's new
 * range, mapped through the steps after it. A keystroke touches one block,
 * and only that block is read again.
 */
function touchedRanges(transactions: readonly Transaction[]): [number, number][] {
  let ranges: [number, number][] = [];
  for (const tr of transactions) {
    for (const map of tr.mapping.maps) {
      ranges = ranges.map(([from, to]) => [map.map(from, -1), map.map(to, 1)]);
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => void ranges.push([newStart, newEnd]));
    }
  }
  return ranges;
}

function normalize(doc: ProseMirrorNode, ranges: [number, number][], tr: Transaction, type: MarkType): boolean {
  const seen = new Set<number>();
  let changed = false;
  for (const [from, to] of ranges) {
    // One position wider on each side: a range at a block's edge (a join, a
    // split) is still that block's business.
    doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
      if (!node.isTextblock) return true;
      if (!node.type.spec.code && !seen.has(pos)) {
        seen.add(pos);
        changed = normalizeBlock(node, pos, tr, type) || changed;
      }
      return false;
    });
  }
  return changed;
}

export const ParamExpr = Mark.create({
  name: "paramExpr",
  // The serializer's own rule: text under a `code` mark is written as is.
  code: true,
  // Typing right after `]]` is prose, not more expression.
  inclusive: false,

  parseHTML() {
    return [{ tag: "span[data-param-expr]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-param-expr": "", class: "rt-param" }), 0];
  },

  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) =>
    helpers.applyMark("paramExpr", [{ type: "text", text: (token as MarkdownToken & { text: string }).text }]),

  // Nothing around it: the text under the mark IS the markdown.
  renderMarkdown: (node: JSONContent, helpers: MarkdownRendererHelpers) => helpers.renderChildren(node),

  markdownTokenizer: {
    name: "paramExpr",
    level: "inline" as const,
    start: startOf,
    tokenize: (src: string) => {
      const match = matchToken(src);
      return match && { type: "paramExpr", ...match };
    },
  },

  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: new PluginKey("paramExpr"),
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const tr = state.tr;
          return normalize(state.doc, touchedRanges(transactions), tr, type) ? tr : null;
        },
      }),
    ];
  },
});
