/**
 * @vitest-environment jsdom
 *
 * The editor's syntax colour: the STUDENT's tokenizer, drawn over the
 * teacher's document as decorations rather than written into it. What matters
 * here is that the two readers of `tokenize` agree — the same runs, the same
 * classes — and that a decoration never becomes content.
 */
import { Editor } from "@tiptap/core";
import type { Decoration } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";

import { codeHighlightKey } from "./codeHighlight";
import { highlight, tokenize } from "./highlight";
import { richTextExtensions } from "./tiptap";

if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
document.elementFromPoint ??= () => null;

function editorFor(markdown: string): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: richTextExtensions(),
    content: markdown,
    contentType: "markdown",
  });
}

/** Every decoration of the document, as `{ text, class }`, in document order. */
function decorations(editor: Editor): { text: string; cls: unknown }[] {
  const set = codeHighlightKey.getState(editor.state);
  const found = set?.find() ?? [];
  return found.map((decoration: Decoration) => {
    // `type` is not in the public typings of prosemirror-view; the attributes
    // of an inline decoration are the only place its class can be read from.
    const { attrs } = decoration as unknown as { attrs?: Record<string, unknown> };
    const inner = (decoration as unknown as { type?: { attrs?: Record<string, unknown> } }).type;
    return {
      text: editor.state.doc.textBetween(decoration.from, decoration.to),
      cls: (attrs ?? inner?.attrs)?.class,
    };
  });
}

describe("tokenize — the one tokenizer, two readers", () => {
  it("reports offsets into the raw text", () => {
    expect(tokenize("int x = 42; // hi", "c")).toEqual([
      { from: 0, to: 3, cls: "tok-kw" },
      { from: 8, to: 10, cls: "tok-num" },
      { from: 12, to: 17, cls: "tok-com" },
    ]);
  });

  it("has nothing to say about a language it does not know", () => {
    expect(tokenize("$ ls -la", "bash")).toEqual([]);
    // …and the student's HTML is then the escaped text, as it always was.
    expect(highlight("a < b", "bash")).toBe("a &lt; b");
  });

  it("still produces the student's spans, unchanged", () => {
    expect(highlight("int x = 42; // hi", "c")).toBe(
      '<span class="tok-kw">int</span> x = <span class="tok-num">42</span>; ' +
        '<span class="tok-com">// hi</span>',
    );
  });
});

describe("the editor's decorations", () => {
  it("colours a fenced block with the classes the stylesheet already styles", () => {
    const editor = editorFor("```c\nint x = 42; // hi\n```");
    try {
      expect(decorations(editor)).toEqual([
        { text: "int", cls: "tok-kw" },
        { text: "42", cls: "tok-num" },
        { text: "// hi", cls: "tok-com" },
      ]);
    } finally {
      editor.destroy();
    }
  });

  it("colours nothing outside a block: a prompt is prose, not code", () => {
    const editor = editorFor("int x = 42;");
    try {
      expect(decorations(editor)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  it("follows what is typed into the block, and only that block", () => {
    const editor = editorFor("```c\nint x;\n```\n\n```c\ndouble y;\n```");
    try {
      expect(decorations(editor)).toEqual([
        { text: "int", cls: "tok-kw" },
        { text: "double", cls: "tok-kw" },
      ]);
      // ` = 42` at the end of the first block: the second one is untouched.
      const end = editor.state.doc.firstChild!.nodeSize - 1;
      editor.view.dispatch(editor.state.tr.insertText(" = 42", end));
      expect(decorations(editor)).toEqual([
        { text: "int", cls: "tok-kw" },
        { text: "42", cls: "tok-num" },
        { text: "double", cls: "tok-kw" },
      ]);
    } finally {
      editor.destroy();
    }
  });

  it("follows the language: the block is re-read when the field changes it", () => {
    const editor = editorFor("```\ndef f(): pass\n```");
    try {
      expect(decorations(editor)).toEqual([]);
      editor.commands.updateAttributes("codeBlock", { language: "python" });
      expect(decorations(editor)).toEqual([
        { text: "def", cls: "tok-kw" },
        { text: "pass", cls: "tok-kw" },
      ]);
    } finally {
      editor.destroy();
    }
  });

  it("drops the colours when the block stops being one", () => {
    const editor = editorFor("```c\nint x;\n```");
    try {
      expect(decorations(editor)).not.toEqual([]);
      editor.commands.setTextSelection(2);
      editor.commands.toggleCodeBlock();
      expect(decorations(editor)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  it("never writes a span into the markdown", () => {
    const editor = editorFor("```c\nint x = 42;\n```");
    try {
      expect(editor.getMarkdown().trimEnd()).toBe("```c\nint x = 42;\n```");
    } finally {
      editor.destroy();
    }
  });
});
