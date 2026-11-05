/*
 * Firefox paints the caret of a code block on the previous line (#1025).
 *
 * `codeHighlight.ts` colours a code block with inline decorations, and a
 * keystroke re-tokenizes the block. When a token boundary moves, ProseMirror
 * destroys and recreates the `<span>` that held the caret's text node; the DOM
 * then moves the collapsed selection to the parent element, `(contentDOM,
 * index)`. ProseMirror compares that with the position it would set — the end
 * of the previous text node — finds the two equivalent, and leaves the DOM
 * alone. Chromium paints an element-anchored caret where it belongs; Gecko
 * paints it at the end of the previous line, notably right after a `\n` in
 * `white-space: pre`. ProseMirror already works around the same family of
 * Firefox bugs for text-node positions (prosemirror-view issues #1073 and
 * #1128, its `brKludge`), but not here, where the anchor is an element.
 *
 * So, after each view update in Firefox only, an element-anchored caret is put
 * back in the text node ProseMirror itself would have chosen. The new position
 * is equivalent to the old one for ProseMirror: it dispatches nothing and does
 * not fight back, and no loop is possible since this runs only from a plugin
 * view's `update`.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Gecko, detected as prosemirror-view does: Chrome's "like Gecko" has no `/digits`. */
const GECKO = typeof navigator !== "undefined" && /gecko\/(\d+)/i.test(navigator.userAgent);

function indexOf(node: Node): number {
  return Array.from(node.parentNode?.childNodes ?? []).indexOf(node as ChildNode);
}

/**
 * Move a collapsed DOM selection anchored on an element into the text node
 * ProseMirror would have chosen for the same position. Returns true when it
 * moved the selection.
 */
export function reanchorCaret(view: EditorView): boolean {
  if (!view.editable || !view.hasFocus() || view.composing) return false;
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;

  // `ShadowRoot.getSelection` is not in the DOM typings; ProseMirror casts the same way.
  const domSel = (view.root as Document).getSelection();
  if (!domSel || domSel.rangeCount !== 1 || !domSel.isCollapsed) return false;
  const anchor = domSel.anchorNode;
  if (!anchor || anchor.nodeType !== Node.ELEMENT_NODE || !view.dom.contains(anchor)) return false;

  // What ProseMirror's own `setSelection` computes for this head. An element
  // there is what it wants: leave it.
  const at = view.domAtPos(selection.head, -1);
  if (at.node.nodeType !== Node.TEXT_NODE) return false;

  let target: { node: Node; offset: number } = at;
  // ProseMirror's rule for a trailing newline (#1128): a textblock whose text
  // ends in `\n` gets a trailing `<br>`, and Firefox paints the caret right
  // only after that `<br>`.
  const text = at.node.nodeValue ?? "";
  if (at.offset > 0 && at.offset === text.length && text[at.offset - 1] === "\n") {
    const block = view.nodeDOM(selection.$head.before());
    for (
      let scan: Node | null = at.node;
      scan && scan !== block && scan !== view.dom;
      scan = scan.parentNode
    ) {
      const after = scan.nextSibling;
      if (after) {
        if (after.nodeName === "BR" && after.parentNode) {
          target = { node: after.parentNode, offset: indexOf(after) + 1 };
        }
        break;
      }
    }
  }

  // Through a Range, as ProseMirror does on Firefox for these positions.
  const range = (target.node.ownerDocument ?? document).createRange();
  range.setStart(target.node, target.offset);
  range.collapse(true);
  domSel.removeAllRanges();
  domSel.addRange(range);
  return true;
}

export const GeckoCaret = Extension.create({
  name: "geckoCaret",
  addProseMirrorPlugins() {
    if (!GECKO) return [];
    return [
      new Plugin({
        key: new PluginKey("geckoCaret"),
        view: () => ({
          // Only after the DOCUMENT changed: the decorations are redrawn on
          // nothing else, and a selection ProseMirror chose to leave alone
          // (a mouse drag in progress, an arrow key) must stay its own.
          update: (view, prev) => {
            if (view.state.doc !== prev.doc) reanchorCaret(view);
          },
        }),
      }),
    ];
  },
});
