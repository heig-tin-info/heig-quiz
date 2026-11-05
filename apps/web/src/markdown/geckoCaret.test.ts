/**
 * @vitest-environment jsdom
 *
 * Firefox's caret after a syntax-colour redraw (#1025): a collapsed DOM
 * selection left on an element by a recreated token span is put back in the
 * text node ProseMirror would have chosen, and nothing else is touched.
 */
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { FORMULA_LABELS } from "../test/formula";
import { reanchorCaret } from "./geckoCaret";
import { richTextExtensions } from "./tiptap";

if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
document.elementFromPoint ??= () => null;

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

function editorFor(markdown: string, focus = true): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: richTextExtensions({ formulaLabels: FORMULA_LABELS }),
    content: markdown,
    contentType: "markdown",
  });
  editors.push(editor);
  if (focus) {
    // jsdom focuses only what it deems focusable.
    editor.view.dom.setAttribute("tabindex", "-1");
    editor.view.dom.focus();
  }
  return editor;
}

function textNode(root: Node, value: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue === value) return node as Text;
  }
  throw new Error(`no text node "${value}"`);
}

function indexOf(node: Node): number {
  return Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode);
}

function selectDom(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function select(editor: Editor, pos: number): void {
  const { state } = editor.view;
  editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

describe("reanchorCaret", () => {
  it("moves a caret left on the element into the end of the token's text node", () => {
    const editor = editorFor("```c\nint x;\n```");
    const { view } = editor;
    expect(view.hasFocus()).toBe(true);
    // 1 opens the code block; `int` ends 3 further.
    select(editor, 4);
    const int = textNode(view.dom, "int");
    const span = int.parentNode!;
    selectDom(span.parentNode!, indexOf(span) + 1);

    expect(reanchorCaret(view)).toBe(true);
    const sel = document.getSelection()!;
    expect(sel.anchorNode).toBe(int);
    expect(sel.anchorOffset).toBe(3);
    expect(view.state.selection.head).toBe(4);
  });

  it("puts a caret after a trailing newline behind the block's trailing <br>", () => {
    const editor = editorFor("```c\nint x;\n```");
    const { view } = editor;
    const end = view.state.doc.firstChild!.nodeSize - 1;
    view.dispatch(view.state.tr.insertText("\n", end));
    select(editor, end + 1);
    const content = textNode(view.dom, " x;\n").parentNode!;
    const br = Array.from(content.childNodes).find((node) => node.nodeName === "BR");
    // ProseMirror adds it because the text ends in `\n`, jsdom included.
    expect(br).toBeDefined();
    selectDom(content, indexOf(br!));

    expect(reanchorCaret(view)).toBe(true);
    const sel = document.getSelection()!;
    expect(sel.anchorNode).toBe(br!.parentNode);
    expect(sel.anchorOffset).toBe(indexOf(br!) + 1);
    expect(view.state.selection.head).toBe(end + 1);
  });

  it("leaves a caret that is already in a text node", () => {
    const editor = editorFor("```c\nint x;\n```");
    const { view } = editor;
    select(editor, 4);
    const int = textNode(view.dom, "int");
    selectDom(int, 3);

    expect(reanchorCaret(view)).toBe(false);
    expect(document.getSelection()!.anchorNode).toBe(int);
  });

  it("does nothing while the editor does not have the focus", () => {
    const editor = editorFor("```c\nint x;\n```", false);
    const { view } = editor;
    select(editor, 4);
    const span = textNode(view.dom, "int").parentNode!;
    selectDom(span.parentNode!, indexOf(span) + 1);

    expect(reanchorCaret(view)).toBe(false);
    expect(document.getSelection()!.anchorNode).toBe(span.parentNode);
  });
});
