import type { Editor } from "@tiptap/core";
import { useCallback, useState, type RefObject } from "react";

import type { Formula, FormulaDialog } from "./FormulaDialog";
import { isMathNode } from "./richTextKeys";

/**
 * The formula dialog, and with it MathLive, arrive when a teacher asks for a
 * formula — not when a field is drawn. It is the heaviest thing this editor
 * can open and the one a teacher of prose never touches (N-PERF-05).
 *
 * Fetched by hand rather than through `lazy` + `Suspense`, and that is not a
 * style preference: the dialog opens from INSIDE a ProseMirror transaction
 * (typing `$$`), React treats that update as synchronous input, and a
 * component that suspends there makes React throw its subtree away — which,
 * next to a contenteditable whose DOM ProseMirror owns, took the whole editor
 * down with a `removeChild` of a node React no longer had. Awaiting the module
 * first means the dialog only ever mounts already resolved, one microtask
 * after the transaction, and the chunk is still a chunk.
 */
export type FormulaDialogComponent = typeof FormulaDialog;
let formulaDialog: FormulaDialogComponent | null = null;

/** Where the formula dialog will write, and what it starts from. */
export interface FormulaTarget extends Formula {
  /** Position of the math node being edited, or null for a new one. */
  node: number | null;
  /** Text range the formula replaces (the selection the Σ button was pressed on). */
  range: { from: number; to: number } | null;
  /** The node was made empty by `$$` a moment ago: cancelling removes it again. */
  created: boolean;
}

/** Every empty formula of the document, in document order. */
export function emptyMath(editor: Editor): { pos: number; display: boolean }[] {
  const found: { pos: number; display: boolean }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!isMathNode(node.type.name)) return;
    if (String(node.attrs.latex ?? "").trim() !== "") return;
    found.push({ pos, display: node.type.name === "blockMath" });
  });
  return found;
}

/**
 * The formula being written, the dialog that writes it, and what applying or
 * leaving it does to the document. `editorRef` is read when the teacher acts:
 * the openers are handed to the editor's options, which exist before it does.
 */
export function useFormulaTarget(editorRef: RefObject<Editor | null>) {
  const [formula, setFormula] = useState<FormulaTarget | null>(null);
  /** The dialog component, once its chunk has arrived (never `lazy`, above). */
  // The initializer is a FUNCTION returning the component: `useState(fn)` would
  // call it as a lazy initializer — and a React component called with no props
  // takes the page down (it did).
  const [Dialog, setDialog] = useState<FormulaDialogComponent | null>(() => formulaDialog);

  /** Fetches the dialog if needed, then opens it on `target`. */
  const openFormula = useCallback(async (target: FormulaTarget) => {
    if (formulaDialog === null) {
      formulaDialog = (await import("./FormulaDialog")).FormulaDialog;
    }
    setDialog(() => formulaDialog as FormulaDialogComponent);
    setFormula(target);
  }, []);

  /** Opens the dialog on the math node at `pos`. */
  function openMath(pos: number, latex: unknown, typeName: string) {
    void openFormula({
      latex: typeof latex === "string" ? latex : "",
      display: typeName === "blockMath",
      node: pos,
      range: null,
      created: false,
    });
  }

  /** Writes what the formula dialog collected, where it was opened from. */
  function applyFormula({ latex, display }: Formula) {
    const editor = editorRef.current;
    if (!editor || !formula) return;
    const content = { type: display ? "blockMath" : "inlineMath", attrs: { latex } };
    const chain = editor.chain().focus();
    if (formula.node !== null) {
      const node = editor.state.doc.nodeAt(formula.node);
      chain.insertContentAt({ from: formula.node, to: formula.node + (node?.nodeSize ?? 1) }, content);
    } else if (formula.range) chain.insertContentAt(formula.range, content);
    else chain.insertContent(content);
    chain.run();
    setFormula(null);
  }

  /**
   * Leaving the dialog. The empty node `$$` had just made goes with it: an
   * invisible formula in the middle of a prompt is worse than no formula, and
   * the teacher who cancels meant to be back where they were.
   */
  function cancelFormula() {
    const editor = editorRef.current;
    if (editor && formula?.created && formula.node !== null) {
      const node = editor.state.doc.nodeAt(formula.node);
      if (node && isMathNode(node.type.name)) {
        editor
          .chain()
          .focus()
          .deleteRange({ from: formula.node, to: formula.node + node.nodeSize })
          .run();
      }
    }
    setFormula(null);
    editor?.commands.focus();
  }

  return { formula, Dialog, openFormula, openMath, applyFormula, cancelFormula };
}
