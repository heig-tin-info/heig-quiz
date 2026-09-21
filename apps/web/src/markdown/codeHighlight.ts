/*
 * Syntax colour INSIDE the editor, with the student's own tokenizer.
 *
 * `render.ts` colours a fenced block for the reader by wrapping runs of the
 * source in `<span class="tok-…">`. The editor cannot do that: the text of a
 * code block is a ProseMirror text node, and a span written into it would be
 * content — it would end up in the markdown. A DECORATION is the same span
 * drawn over the document without being part of it, which is exactly the
 * distinction the round trip depends on.
 *
 * The classes are the ones the stylesheet already styles under `.md-body`
 * (`tok-com`, `tok-str`, `tok-kw`, `tok-num`), and the editing surface carries
 * `.md-body` (see `RichText.tsx`), so the teacher's block is tinted exactly
 * like the student's.
 *
 * Cost: a keystroke re-tokenizes the blocks the transaction TOUCHED, never the
 * document. Everything else is carried over by mapping the decoration set
 * through the transaction, which is a position shift and no string work.
 */
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { findClozeClosingBraces } from "@quiz/domain";

import { tokenize } from "./highlight";

/** The node this extension colours; the only one whose content is code. */
const CODE_BLOCK = "codeBlock";

export const codeHighlightKey = new PluginKey<DecorationSet>("codeHighlight");

export interface CodeHighlightOptions {
  /**
   * Also mark the `{{…}}` holes of a `cloze` text. INSIDE a fenced block a
   * hole cannot be the node the rest of the field uses — the content of a code
   * block is text — so the only way to show the teacher that "complétez ce
   * code" still has its holes is to draw over them.
   */
  holes: boolean;
}

/** The `{{…}}` runs of one block, by the grammar of `@quiz/domain`. */
function holeRanges(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith("\\{{", i)) {
      i += 2;
      continue;
    }
    if (!text.startsWith("{{", i)) continue;
    const end = findClozeClosingBraces(text, i + 2);
    if (end === -1) break;
    out.push({ from: i, to: end + 2 });
    i = end + 1;
  }
  return out;
}

/** The decorations of ONE code block, `pos` being the position of the node. */
function decorate(node: ProseMirrorNode, pos: number, holes: boolean): Decoration[] {
  const language = typeof node.attrs.language === "string" ? node.attrs.language : null;
  const text = node.textContent;
  if (text === "") return [];
  const ranges = holes ? holeRanges(text) : [];
  // `pos + 1` is the first character: a text block's content starts one
  // position inside the node.
  const at = (from: number, to: number, cls: string) =>
    Decoration.inline(pos + 1 + from, pos + 1 + to, { class: cls });
  return [
    // A hole is not code: the tokens it overlaps are dropped rather than
    // drawn under it, or `{{#10:0}}` would be half a number and half a hole.
    ...tokenize(text, language)
      .filter(({ from, to }) => !ranges.some((r) => from < r.to && r.from < to))
      .map(({ from, to, cls }) => at(from, to, cls)),
    ...ranges.map(({ from, to }) => at(from, to, "tok-hole")),
  ];
}

/** Every code block of `doc`, with its position. Used on load and on a reload. */
function codeBlocksIn(
  doc: ProseMirrorNode,
  from = 0,
  to = doc.content.size,
): { node: ProseMirrorNode; pos: number }[] {
  const found: { node: ProseMirrorNode; pos: number }[] = [];
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
    if (node.type.name !== CODE_BLOCK) return true;
    found.push({ node, pos });
    // Its content is text; there is nothing below it to visit.
    return false;
  });
  return found;
}

export const CodeHighlight = Extension.create<CodeHighlightOptions>({
  name: "codeHighlight",

  addOptions() {
    return { holes: false };
  },

  addProseMirrorPlugins() {
    const { holes } = this.options;
    return [
      new Plugin<DecorationSet>({
        key: codeHighlightKey,
        state: {
          init(_config, state) {
            return DecorationSet.create(
              state.doc,
              codeBlocksIn(state.doc).flatMap(({ node, pos }) => decorate(node, pos, holes)),
            );
          },
          apply(tr, set) {
            // A selection move changes no text: the set is already right.
            if (!tr.docChanged) return set;
            const mapped = set.map(tr.mapping, tr.doc);

            /*
             * The span the transaction rewrote, in the NEW document. Each step
             * map reports its replaced range; mapping it through the steps
             * that FOLLOW it puts them all in the same coordinates. This is
             * what keeps a keystroke from re-tokenizing a long prompt.
             */
            let from = Infinity;
            let to = -Infinity;
            tr.mapping.maps.forEach((map, index) => {
              map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                const rest = tr.mapping.slice(index + 1);
                from = Math.min(from, rest.map(newStart, -1));
                to = Math.max(to, rest.map(newEnd, 1));
              });
            });
            if (from > to) return mapped;

            const blocks = codeBlocksIn(tr.doc, from, to);
            // The rewritten span is cleared whether or not a block survives in
            // it: a code block turned back into a paragraph must not leave its
            // colours on the prose.
            let low = from;
            let high = to;
            for (const { node, pos } of blocks) {
              low = Math.min(low, pos);
              high = Math.max(high, pos + node.nodeSize);
            }
            return mapped
              .remove(mapped.find(low, high))
              .add(
                tr.doc,
                blocks.flatMap(({ node, pos }) => decorate(node, pos, holes)),
              );
          },
        },
        props: {
          decorations(state) {
            return codeHighlightKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
