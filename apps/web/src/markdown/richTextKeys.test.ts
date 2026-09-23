import { Editor, type JSONContent } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRichTextKeyDown, type RichTextKeyDeps } from "./richTextKeys";
import { richTextExtensions } from "./tiptap";

/*
 * The key rules of the rich text field against a real ProseMirror state, with
 * no render: the view is the state plus a dispatch that records what a rule
 * wrote. Each case pins one guard or one side effect that the component tests
 * (RichText.test.tsx) do not reach on their own.
 */

if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

/** A paragraph holding exactly `text`: markdown would read "```c" as a block already. */
const para = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

/** An editor holding `markdown`, with the caret at `caret` (or `node` selected). */
function setup(
  markdown: string | JSONContent,
  opts: { inline?: boolean; cloze?: boolean; caret?: number; node?: number } = {},
) {
  const editor = new Editor({
    extensions: richTextExtensions({ inline: opts.inline ?? false, cloze: opts.cloze ?? false }),
    content: markdown,
    ...(typeof markdown === "string" ? { contentType: "markdown" as const } : {}),
  });
  editors.push(editor);
  if (opts.node !== undefined) editor.commands.setNodeSelection(opts.node);
  else if (opts.caret !== undefined) editor.commands.setTextSelection(opts.caret);
  const dispatched: Transaction[] = [];
  const view = {
    state: editor.state,
    dispatch: (tr: Transaction) => dispatched.push(tr),
  } as unknown as EditorView;
  return { editor, view, dispatched };
}

/**
 * A keydown with spies on the two ways a rule can take it. A plain object:
 * this file runs under node, and the rules read nothing else of the event.
 */
function key(k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
    preventDefault,
    stopPropagation,
  } as unknown as KeyboardEvent;
  return { event, preventDefault, stopPropagation };
}

function deps(over: Partial<RichTextKeyDeps> = {}): RichTextKeyDeps {
  return {
    inline: false,
    onTab: undefined,
    onEnter: undefined,
    openMath: vi.fn(),
    openHole: vi.fn(),
    ...over,
  };
}

/** The top-level node types of the document a transaction leaves. */
const blocks = (tr: Transaction): string[] => {
  const names: string[] = [];
  tr.doc.forEach((n) => names.push(n.type.name));
  return names;
};

/** Position of the first node named `name`. */
function posOf(editor: Editor, name: string): number {
  let found = -1;
  editor.state.doc.descendants((n, pos) => {
    if (found === -1 && n.type.name === name) found = pos;
  });
  if (found === -1) throw new Error(`no ${name} in the document`);
  return found;
}

describe("handleRichTextKeyDown", () => {
  it("Enter on a selected formula opens the formula dialog on it", () => {
    const probe = setup("a $x^2$ b");
    const { view } = setup("a $x^2$ b", { node: posOf(probe.editor, "inlineMath") });
    const d = deps();
    const k = key("Enter");
    expect(handleRichTextKeyDown(view, k.event, d)).toBe(true);
    expect(d.openMath).toHaveBeenCalledWith(posOf(probe.editor, "inlineMath"), "x^2", "inlineMath");
    expect(k.preventDefault).toHaveBeenCalled();
  });

  it("Enter on a selected hole chip opens the blank card on it", () => {
    const probe = setup("a {{cat}} b", { cloze: true });
    const at = posOf(probe.editor, "clozeHole");
    const { view } = setup("a {{cat}} b", { cloze: true, node: at });
    const d = deps();
    const k = key("Enter");
    expect(handleRichTextKeyDown(view, k.event, d)).toBe(true);
    expect(d.openHole).toHaveBeenCalledWith(at, "cat", false);
    expect(k.preventDefault).toHaveBeenCalled();
    expect(d.openMath).not.toHaveBeenCalled();
  });

  it("block field: plain Enter on a fence line is left to the input rule", () => {
    const { view, dispatched } = setup(para("```c"), { caret: 5 });
    const k = key("Enter");
    expect(handleRichTextKeyDown(view, k.event, deps())).toBe(false);
    expect(dispatched).toHaveLength(0);
    expect(k.preventDefault).not.toHaveBeenCalled();
  });

  it("block field: Ctrl+Enter on a fence line opens the block and stops the key", () => {
    const { view, dispatched } = setup(para("```c"), { caret: 5 });
    const k = key("Enter", { ctrl: true });
    expect(handleRichTextKeyDown(view, k.event, deps())).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(blocks(dispatched[0]!)).toContain("codeBlock");
    expect(k.preventDefault).toHaveBeenCalled();
    expect(k.stopPropagation).toHaveBeenCalled();
  });

  it("inline field: Enter on a fence line opens the block and stops the key", () => {
    const { view, dispatched } = setup(para("```c"), { inline: true, caret: 5 });
    const onEnter = vi.fn();
    const k = key("Enter");
    expect(handleRichTextKeyDown(view, k.event, deps({ inline: true, onEnter }))).toBe(true);
    expect(blocks(dispatched[0]!)).toContain("codeBlock");
    expect(k.stopPropagation).toHaveBeenCalled();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("inline field: Shift+Enter in a paragraph splits it and stops the key", () => {
    const { view, dispatched } = setup("hello", { inline: true, caret: 3 });
    const onEnter = vi.fn();
    const k = key("Enter", { shift: true });
    expect(handleRichTextKeyDown(view, k.event, deps({ inline: true, onEnter }))).toBe(true);
    expect(blocks(dispatched[0]!)).toEqual(["paragraph", "paragraph"]);
    expect(k.preventDefault).toHaveBeenCalled();
    expect(k.stopPropagation).toHaveBeenCalled();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("inline field, inside a code block: Ctrl+Enter leaves the block", () => {
    const md = "```c\nint x;\n```";
    const probe = setup(md, { inline: true });
    const { view, dispatched } = setup(md, { inline: true, caret: posOf(probe.editor, "codeBlock") + 3 });
    const onEnter = vi.fn();
    const k = key("Enter", { ctrl: true });
    expect(handleRichTextKeyDown(view, k.event, deps({ inline: true, onEnter }))).toBe(true);
    expect(dispatched).toHaveLength(1);
    const after = blocks(dispatched[0]!);
    expect(after[after.indexOf("codeBlock") + 1]).toBe("paragraph");
    expect(dispatched[0]!.doc.firstChild!.textContent).toBe("int x;");
    expect(k.stopPropagation).toHaveBeenCalled();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("inline field, inside a code block: Shift+Enter is a newline in the code", () => {
    const md = "```c\nint x;\n```";
    const probe = setup(md, { inline: true });
    const { view, dispatched } = setup(md, { inline: true, caret: posOf(probe.editor, "codeBlock") + 4 });
    const onEnter = vi.fn();
    const k = key("Enter", { shift: true });
    expect(handleRichTextKeyDown(view, k.event, deps({ inline: true, onEnter }))).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(blocks(dispatched[0]!)).toEqual(blocks({ doc: probe.editor.state.doc } as Transaction));
    expect(dispatched[0]!.doc.firstChild!.textContent).toBe("int\n x;");
    expect(k.stopPropagation).toHaveBeenCalled();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("inline field, inside a code block: plain Enter is Tiptap's and never the host's", () => {
    const md = "```c\nint x;\n```";
    const probe = setup(md, { inline: true });
    const { view, dispatched } = setup(md, { inline: true, caret: posOf(probe.editor, "codeBlock") + 3 });
    const onEnter = vi.fn();
    expect(handleRichTextKeyDown(view, key("Enter").event, deps({ inline: true, onEnter }))).toBe(false);
    expect(dispatched).toHaveLength(0);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("Alt+Tab is not offered to the host", () => {
    const { view } = setup("hello", { caret: 2 });
    const onTab = vi.fn(() => true);
    const k = key("Tab", { alt: true });
    expect(handleRichTextKeyDown(view, k.event, deps({ onTab }))).toBe(false);
    expect(onTab).not.toHaveBeenCalled();
    expect(k.preventDefault).not.toHaveBeenCalled();
  });

  it("plain Tab is offered to the host, which takes it", () => {
    const { view } = setup("hello", { caret: 2 });
    const onTab = vi.fn(() => true);
    const k = key("Tab", { shift: true });
    expect(handleRichTextKeyDown(view, k.event, deps({ onTab }))).toBe(true);
    expect(onTab).toHaveBeenCalledWith(true);
    expect(k.preventDefault).toHaveBeenCalled();
  });

  describe("the fence rules pass when there is no fence", () => {
    it("inline: plain Enter on ordinary text reaches the host's onEnter", () => {
      const { view, dispatched } = setup("hello", { inline: true, caret: 6 });
      const onEnter = vi.fn();
      const k = key("Enter");
      expect(handleRichTextKeyDown(view, k.event, deps({ inline: true, onEnter }))).toBe(true);
      expect(onEnter).toHaveBeenCalledTimes(1);
      expect(dispatched).toHaveLength(0);
      expect(k.stopPropagation).not.toHaveBeenCalled();
    });

    it("block: Ctrl+Enter on ordinary text is left alone, for the window's shortcut", () => {
      const { view, dispatched } = setup("hello", { caret: 6 });
      const k = key("Enter", { ctrl: true });
      expect(handleRichTextKeyDown(view, k.event, deps())).toBe(false);
      expect(dispatched).toHaveLength(0);
      expect(k.preventDefault).not.toHaveBeenCalled();
      expect(k.stopPropagation).not.toHaveBeenCalled();
    });
  });
});
