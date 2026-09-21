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

import { tokenize } from "./highlight";

/** The node this extension colours; the only one whose content is code. */
const CODE_BLOCK = "codeBlock";

export const codeHighlightKey = new PluginKey<DecorationSet>("codeHighlight");

/** The decorations of ONE code block, `pos` being the position of the node. */
function decorate(node: ProseMirrorNode, pos: number): Decoration[] {
  const language = typeof node.attrs.language === "string" ? node.attrs.language : null;
  const text = node.textContent;
  if (text === "") return [];
  // `pos + 1` is the first character: a text block's content starts one
  // position inside the node.
  return tokenize(text, language).map(({ from, to, cls }) =>
    Decoration.inline(pos + 1 + from, pos + 1 + to, { class: cls }),
  );
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

export const CodeHighlight = Extension.create({
  name: "codeHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: codeHighlightKey,
        state: {
          init(_config, state) {
            return DecorationSet.create(
              state.doc,
              codeBlocksIn(state.doc).flatMap(({ node, pos }) => decorate(node, pos)),
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
                blocks.flatMap(({ node, pos }) => decorate(node, pos)),
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
