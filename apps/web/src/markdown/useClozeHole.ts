import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useEffect, useState, type MouseEvent, type RefObject } from "react";

import { clozeHolePossibilities, type ClozeHolePossibility } from "./clozeHole";

/** Where a card hangs, in viewport coordinates. */
export interface HoleAnchor {
  top: number;
  bottom: number;
  left: number;
}

/** The hole the blank card is open on. */
export interface OpenHole {
  pos: number;
  body: string;
  created: boolean;
  anchor: HoleAnchor;
}

/** What the read-only popover under a multi-answer chip shows. */
export interface HolePreview {
  anchor: HoleAnchor;
  items: ClozeHolePossibility[];
}

/**
 * Where the card of a hole hangs: the chip's own rectangle, in viewport
 * coordinates. `coordsAtPos` is the fallback for the frame in which the chip
 * has just been created and has no element yet.
 */
export function holeAnchor(editor: Editor, pos: number): HoleAnchor {
  const dom = editor.view.nodeDOM(pos);
  if (dom instanceof HTMLElement) {
    const r = dom.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left };
  }
  try {
    const c = editor.view.coordsAtPos(pos);
    return { top: c.top, bottom: c.bottom, left: c.left };
  } catch {
    return { top: 0, bottom: 0, left: 0 };
  }
}

/** Every hole whose body is still empty, in document order. */
export function emptyClozeHoles(editor: Editor): number[] {
  const found: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "clozeHole") return;
    if (node.attrs.body !== "") return;
    found.push(pos);
  });
  return found;
}

/** The chip under the pointer, when it stands for more than one possibility. */
export function previewAt(target: EventTarget | null): HolePreview | null {
  const el = target instanceof Element ? target.closest('span[data-type="cloze-hole"]') : null;
  if (!(el instanceof HTMLElement) || el.getAttribute("data-literal") === "true") return null;
  const items = clozeHolePossibilities(el.getAttribute("data-body") ?? "");
  if (items === null) return null;
  const r = el.getBoundingClientRect();
  return { anchor: { top: r.top, bottom: r.bottom, left: r.left }, items };
}

/**
 * The `{{…}}` hole being written, and the read-only list under a hovered
 * multi-answer chip. `editorRef` is read when the teacher acts: the openers
 * are handed to the editor's options, which exist before it does.
 */
export function useClozeHole(editorRef: RefObject<Editor | null>, holes: boolean) {
  /**
   * The `{{…}}` hole being written, when there is one. A hole is an atom:
   * there is nothing to type into the chip, so it is edited in a card anchored
   * under it (`BlankPopover`), which asks for the SHAPE of the blank instead
   * of the grammar.
   */
  const [hole, setHole] = useState<OpenHole | null>(null);
  /** The read-only list under a hovered multi-answer chip. */
  const [hoverPreview, setHoverPreview] = useState<HolePreview | null>(null);

  /** Opens the blank card on the hole at `pos`. */
  function openHole(pos: number, body: string, created: boolean) {
    if (!editorRef.current) return;
    setHoverPreview(null);
    setHole({ pos, body, created, anchor: holeAnchor(editorRef.current, pos) });
  }

  /** Opens the card on the empty chip `{{` has just made at `pos`. */
  function openCreatedHole(editor: Editor, pos: number) {
    setHole({ pos, body: "", created: true, anchor: holeAnchor(editor, pos) });
  }

  /**
   * Writes the body the blank card collected. An EMPTY body removes the chip:
   * a hole with nothing in it is `cloze.empty_blank` and would only be an
   * error the teacher has to come back and delete.
   */
  function applyHole(body: string) {
    const editor = editorRef.current;
    if (!editor || !hole) return;
    const node = editor.state.doc.nodeAt(hole.pos);
    const size = node?.type.name === "clozeHole" ? node.nodeSize : 1;
    const range = { from: hole.pos, to: hole.pos + size };
    const chain = editor.chain().focus();
    if (body.trim() === "") chain.deleteRange(range).run();
    else chain.insertContentAt(range, { type: "clozeHole", attrs: { body } }).run();
    setHole(null);
  }

  /** Leaving the card. The chip `{{` had just made goes with it. */
  function cancelHole() {
    const editor = editorRef.current;
    if (editor && hole?.created) {
      const node = editor.state.doc.nodeAt(hole.pos);
      if (node?.type.name === "clozeHole") {
        editor.chain().focus().deleteRange({ from: hole.pos, to: hole.pos + node.nodeSize }).run();
      }
    }
    setHole(null);
    editor?.commands.focus();
  }

  /*
   * A chip shows the FIRST possibility and how many more there are; the
   * whole list is one hover away, read-only. Delegated from the field,
   * because the chips are ProseMirror's DOM and a React node view per hole
   * would rebuild on every keystroke. Only a cloze field listens.
   */
  const hoverHandlers = holes
    ? {
        onMouseOver: (e: MouseEvent) => setHoverPreview(previewAt(e.target)),
        onMouseOut: () => setHoverPreview(null),
      }
    : {};

  return {
    hole,
    openHole,
    openCreatedHole,
    applyHole,
    cancelHole,
    hoverPreview,
    hoverHandlers,
  };
}

/** The read-only list under the chip the caret has SELECTED, in a cloze field. */
export function useHoleSelectionPreview(editor: Editor | null, holes: boolean): HolePreview | null {
  const [selectionPreview, setSelectionPreview] = useState<HolePreview | null>(null);

  /**
   * The chip the caret has SELECTED, as one string so the selector can be
   * compared by value: `useEditorState` runs on every transaction, and a fresh
   * object would re-render this component per keystroke.
   */
  const selectedHole = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (e === null) return null;
      const { selection } = e.state;
      if (!(selection instanceof NodeSelection)) return null;
      if (selection.node.type.name !== "clozeHole" || selection.node.attrs.body === null) return null;
      return `${selection.from}\u0000${String(selection.node.attrs.body ?? "")}`;
    },
  }) as string | null;

  useEffect(() => {
    if (!editor || !holes || selectedHole === null) {
      setSelectionPreview(null);
      return;
    }
    const cut = selectedHole.indexOf("\u0000");
    const pos = Number(selectedHole.slice(0, cut));
    const items = clozeHolePossibilities(selectedHole.slice(cut + 1));
    setSelectionPreview(items === null ? null : { anchor: holeAnchor(editor, pos), items });
  }, [editor, holes, selectedHole]);

  return selectionPreview;
}
