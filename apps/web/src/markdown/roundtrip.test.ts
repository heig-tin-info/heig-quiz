/**
 * @vitest-environment jsdom
 *
 * The acceptance test of the WYSIWYG pane: markdown in, a ProseMirror
 * document, markdown out. Nothing about the editor is worth anything if the
 * value stored in `question_versions.config` comes back different from what
 * the teacher wrote (docs/spec/05 §5.10: markdown is the single source of
 * truth, and the editor is a VIEW of it).
 *
 * jsdom rather than the `node` project of vite.config.ts — which claims every
 * `*.test.ts` — because ProseMirror builds a real document; the docblock above
 * is how vitest is told, per file, without moving the whole suite.
 */
import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { INLINE_INPUT_RULES, richTextExtensions } from "./tiptap";

/*
 * jsdom implements `Range` but none of its layout methods, and ProseMirror
 * calls `getClientRects` while mapping the document to coordinates. The stubs
 * live here and not in `src/test/setup.ts`: they are this editor's need, and a
 * global stub would hide a real layout call in every other component test.
 */
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
// ProseMirror maps a click back to a document position through this one.
document.elementFromPoint ??= () => null;

/** markdown -> editor -> markdown, exactly as `RichText` does it. */
function roundTrip(markdown: string, inline = false): string {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: richTextExtensions({ inline }),
    enableInputRules: inline ? [...INLINE_INPUT_RULES] : true,
    content: markdown,
    contentType: "markdown",
  });
  try {
    return editor.getMarkdown();
  } finally {
    editor.destroy();
  }
}

describe("round trip — inline marks", () => {
  it.each([
    ["**bold**"],
    ["*italic*"],
    ["***bold italic***"],
    ["`code`"],
    ["~~struck~~"],
    ["a **bold** word and an *italic* one"],
    ["**bold with `code` inside**"],
    ["[HEIG-VD](https://heig-vd.ch)"],
    ["![alt](asset:00000000-0000-4000-8000-000000000000)"],
    ["Voir ![schema](asset:a1b2) ci-dessus."],
    // The width of an image is a query on the asset reference, and it has to
    // survive every save — it is the only place the setting is stored.
    ["![a](asset:a1b2?w=50)"],
    ["![a](asset:a1b2?w=25)"],
  ])("keeps %j", (source) => {
    expect(roundTrip(source)).toBe(source);
  });
});

describe("round trip — blocks", () => {
  it.each([
    ["```c\nint main(void) { return 0; }\n```"],
    ["```\nno language\n```"],
    ["- a\n- b"],
    ["- a\n  - a1\n- b"],
    ["1. a\n2. b"],
    ["- [ ] todo\n- [x] done"],
    ["> quoted"],
    ["## A heading"],
    ["one\nstill one paragraph"],
    ["a\n\nb"],
    ["line one  \nline two"],
    [""],
  ])("keeps %j", (source) => {
    expect(roundTrip(source)).toBe(source);
  });
});

describe("round trip — maths", () => {
  it("keeps inline maths", () => {
    expect(roundTrip("La diagonale vaut $\\sqrt{2}$.")).toBe("La diagonale vaut $\\sqrt{2}$.");
  });

  it("keeps two formulas in one paragraph", () => {
    expect(roundTrip("a $x_1$ et $y^2$ b")).toBe("a $x_1$ et $y^2$ b");
  });

  it("keeps display maths", () => {
    expect(roundTrip("$$\n\\sum_{i=1}^{n} x_i\n$$")).toBe("$$\n\\sum_{i=1}^{n} x_i\n$$");
  });

  it("leaves a dollar inside code alone, exactly as render.ts does", () => {
    expect(roundTrip("`$HOME`")).toBe("`$HOME`");
  });

  it("does not eat the space of an unbalanced dollar", () => {
    // The shipped tokenizer of `@tiptap/extension-mathematics` trims the
    // latex, which cost this string a space on every save. See tiptap.ts.
    expect(roundTrip("50 % de 100 $ ou 5$")).toBe("50 % de 100 $ ou 5$");
  });
});

/*
 * Where the round trip is NOT the identity. Each of these renders to the same
 * HTML through `render.ts`, so nothing a student reads changes; what changes
 * is the spelling of the stored source, once, the first time the teacher edits
 * the question in the WYSIWYG pane. They are asserted rather than described so
 * that a future version of `@tiptap/markdown` cannot widen the list quietly.
 */
describe("round trip — the normalisations, and only these", () => {
  it.each([
    ["_italic_", "*italic*", "one emphasis spelling"],
    ["__bold__", "**bold**", "one strong spelling"],
    ["* a\n* b", "- a\n- b", "one bullet marker"],
    ["+ a\n+ b", "- a\n- b", "one bullet marker"],
    ["1) a\n2) b", "1. a\n2. b", "one ordered marker"],
    ["$$x$$", "$$\nx\n$$", "a display formula is written on three lines"],
    [
      "https://heig-vd.ch",
      "[https://heig-vd.ch](https://heig-vd.ch)",
      "an autolink becomes an explicit link",
    ],
    [
      "Text with * star and _ underscore",
      "Text with \\* star and \\_ underscore",
      "a literal delimiter is escaped so it cannot become syntax",
    ],
  ])("%j -> %j (%s)", (source, expected) => {
    expect(roundTrip(source)).toBe(expected);
    // Normalising twice changes nothing: the second save is a no-op.
    expect(roundTrip(expected)).toBe(expected);
  });
});

describe("round trip — the prompts this app actually stores", () => {
  const REAL = [
    "Soit `int *p;` déclaré dans une fonction, sans initialisation. Que vaut `p` ?",
    "Dans `void f(int t[10])`, que vaut `sizeof(t)` à l'intérieur de `f` sur une machine 64 bits ?",
    "Quel mode de `fopen` ouvre un fichier en écriture **sans** effacer son contenu ?",
    "Quelle expression donne **l'adresse** de la variable `x` ?",
    "Sur un bus I²C en adressage 7 bits, combien de périphériques distincts peut-on adresser au maximum ?",
    "Sur une machine 64 bits (LP64), que vaut `sizeof(int *)` ? Répondez en octets.",
    "Le programme ci-dessous déborde d'un tampon. Corrigez-le sans changer la taille de `dest`.",
    "Une LED rouge (chute de 2,0 V) est alimentée en 5,0 V à travers une résistance de 200 Ω. Quel courant la traverse, en mA ?",
    "Which declarations are valid in C17?",
    "Let `int *p` point at `0x1000`. What is `p + 1`?",
    "…",
  ];
  it.each(REAL)("keeps %j", (source) => {
    expect(roundTrip(source)).toBe(source);
  });
});

describe("round trip — the choices this app actually stores", () => {
  const CHOICES = [
    "`&x`",
    "`int a[] = {1,2,3};`",
    "`int a[3] = {};`",
    '`"w+"`',
    "Une valeur indéterminée : le lire est un comportement indéfini",
    "`0` sur toute machine conforme à C17",
    "128, moins les adresses réservées",
    "4, la taille d'un `int`",
    "0x1004",
    "…",
  ];
  it.each(CHOICES)("keeps %j in an inline field", (source) => {
    expect(roundTrip(source, true)).toBe(source);
  });
});

describe("an inline field drops nothing", () => {
  // The inline field restricts the INPUT RULES, never the schema: a choice
  // whose stored markdown happens to hold a block survives being opened and
  // saved again, instead of coming back empty.
  it.each([["## a heading"], ["- a\n- b"], ["```c\nint x;\n```"], ["a\n\nb"], ["x  \ny"]])(
    "keeps %j",
    (source) => {
      expect(roundTrip(source, true)).toBe(source);
    },
  );
});

/*
 * What the KEYBOARD makes, which is a different question from what the parser
 * reads: an input rule fires on a character, and `$$` on an empty line is the
 * one shape a teacher writes a display formula in. It used to produce three
 * paragraphs of dollars and no formula at all.
 */
function editorFor(markdown = "", inline = false): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: richTextExtensions({ inline }),
    enableInputRules: inline ? [...INLINE_INPUT_RULES] : true,
    content: markdown,
    contentType: "markdown",
  });
}

/**
 * Types `text` one character at a time, the way ProseMirror sees a keystroke:
 * `handleTextInput` first (that is where the input rules live), a plain
 * insertion when nothing took it.
 */
function type(editor: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (f) =>
      f(editor.view, from, to, ch, () => editor.state.tr),
    );
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
}

const firstChild = (editor: Editor) => editor.state.doc.firstChild!;

describe("typing a formula", () => {
  it("turns `$$` alone on a line into an empty display formula", () => {
    const editor = editorFor();
    try {
      type(editor, "$$");
      expect(firstChild(editor).type.name).toBe("blockMath");
      expect(firstChild(editor).attrs.latex).toBe("");
    } finally {
      editor.destroy();
    }
  });

  it("keeps `$…$` inline while it is typed", () => {
    const editor = editorFor();
    try {
      type(editor, "a $\\sqrt{2}$");
      const paragraph = firstChild(editor);
      expect(paragraph.type.name).toBe("paragraph");
      expect(paragraph.lastChild?.type.name).toBe("inlineMath");
      expect(paragraph.lastChild?.attrs.latex).toBe("\\sqrt{2}");
    } finally {
      editor.destroy();
    }
  });

  it.each([
    ["$$", ""],
    ["$$x^2$$", "x^2"],
  ])("converts %j on Enter, for the fence the input rule never saw", (text, latex) => {
    const editor = editorFor();
    try {
      // Pasted, not typed: no input rule fires on this.
      editor.view.dispatch(editor.state.tr.insertText(text));
      expect(firstChild(editor).type.name).toBe("paragraph");
      editor.commands.keyboardShortcut("Enter");
      expect(firstChild(editor).type.name).toBe("blockMath");
      expect(firstChild(editor).attrs.latex).toBe(latex);
    } finally {
      editor.destroy();
    }
  });

  it("makes no block in an inline field, whose rules cannot", () => {
    const editor = editorFor("", true);
    try {
      type(editor, "$$");
      expect(firstChild(editor).type.name).toBe("paragraph");
      expect(editor.getMarkdown()).toBe("$$");
    } finally {
      editor.destroy();
    }
  });
});

/*
 * The ONE block an inline field is allowed to build. A choice may hold a
 * second paragraph (Ctrl+Enter in `RichText`), and what a teacher writes on
 * that line is almost always a snippet — so the fence rule is on, and the
 * list and heading rules stay off.
 */
describe("the input rules of an inline field", () => {
  // The shipped rule of StarterKit fires on the whitespace AFTER the fence
  // (```<lang> and a space), which is also the only spelling an inline field
  // can reach: its Enter belongs to the host.
  it.each([["``` "], ["```c "]])("opens a fenced block on %j", (source) => {
    const editor = editorFor("", true);
    try {
      type(editor, source);
      expect(firstChild(editor).type.name).toBe("codeBlock");
    } finally {
      editor.destroy();
    }
  });

  it.each([["- "], ["1. "], ["# "], ["> "]])("leaves %j as the characters typed", (source) => {
    const editor = editorFor("", true);
    try {
      type(editor, source);
      expect(firstChild(editor).type.name).toBe("paragraph");
    } finally {
      editor.destroy();
    }
  });
});

/*
 * THE FENCE, as a teacher writes one: ```c, the lines, ```. What used to come
 * out of that was five paragraphs of literal backticks — the shipped rule of
 * StarterKit only fires on a fence followed by a SPACE, and an inline field
 * never reaches it at all, since its Enter belongs to the host.
 *
 * `tiptap.ts` answers with two mechanisms, and both are checked here: the
 * fence that OPENS a block under the caret, and the closing fence that
 * GATHERS what was written above it.
 */
describe("typing a fence", () => {
  const language = (editor: Editor) => firstChild(editor).attrs.language;

  /*
   * These documents are built as NODES and not from markdown: the whole point
   * is a document whose fences are literal text, and a markdown fixture would
   * have been parsed into the very block the test is about to build.
   */
  const para = (text: string) => ({
    type: "paragraph",
    content: text === "" ? [] : [{ type: "text", text }],
  });
  const fenceNode = (language: string, text: string) => ({
    type: "codeBlock",
    attrs: { language },
    content: [{ type: "text", text }],
  });
  function editorWith(content: JSONContent[], inline = false): Editor {
    const editor = editorFor("", inline);
    editor.commands.setContent({ type: "doc", content }, { emitUpdate: false });
    return editor;
  }

  it.each([["```c "], ["```c++ "], ["```python3 "]])(
    "opens a block with its language on %j",
    (source) => {
      const editor = editorFor();
      try {
        type(editor, source);
        expect(firstChild(editor).type.name).toBe("codeBlock");
        expect(language(editor)).toBe(source.trim().slice(3));
      } finally {
        editor.destroy();
      }
    },
  );

  it("opens a block on Enter, which is how a fence is actually written", () => {
    const editor = editorFor();
    try {
      // The input-rule plugin runs the rules on Enter too, with "\n" as the
      // text; what the teacher typed is still only the fence.
      type(editor, "```c");
      expect(firstChild(editor).type.name).toBe("paragraph");
      editor.commands.keyboardShortcut("Enter");
      expect(firstChild(editor).type.name).toBe("codeBlock");
      expect(language(editor)).toBe("c");
    } finally {
      editor.destroy();
    }
  });

  it.each([["Mod-Enter"], ["Shift-Enter"]])("opens a block on %s too", (keys) => {
    const editor = editorFor();
    try {
      editor.view.dispatch(editor.state.tr.insertText("```c"));
      editor.commands.keyboardShortcut(keys);
      expect(firstChild(editor).type.name).toBe("codeBlock");
      expect(language(editor)).toBe("c");
    } finally {
      editor.destroy();
    }
  });

  it("serializes the block it just opened as a fence with its language", () => {
    const editor = editorFor();
    try {
      type(editor, "```c ");
      type(editor, "int x = 1;");
      expect(editor.getMarkdown().trimEnd()).toBe("```c\nint x = 1;\n```");
    } finally {
      editor.destroy();
    }
  });

  /*
   * The retroactive half: the paragraphs are already there — pasted, or typed
   * before any of this existed — and the closing fence is what turns them into
   * a block, the moment its third backtick lands.
   */
  it("gathers the paragraphs above it when the closing fence is typed", () => {
    // The five paragraphs a teacher was left with before any of this existed:
    // literal backticks, and no block anywhere.
    const editor = editorWith([
      para("```c"),
      para("int main(void)"),
      para("{"),
      para("    return 0;"),
      para("}"),
    ]);
    try {
      // The caret goes to the end, on a new paragraph, and the fence is typed.
      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");
      type(editor, "```");
      const block = firstChild(editor);
      expect(block.type.name).toBe("codeBlock");
      expect(block.attrs.language).toBe("c");
      expect(block.textContent).toBe("int main(void)\n{\n    return 0;\n}");
      expect(editor.getMarkdown().trimEnd()).toBe(
        "```c\nint main(void)\n{\n    return 0;\n}\n```",
      );
    } finally {
      editor.destroy();
    }
  });

  it("gathers nothing when there is no fence above: the backticks are typed", () => {
    const editor = editorFor("Une phrase\n\n");
    try {
      editor.commands.focus("end");
      type(editor, "```");
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
      expect(editor.state.doc.lastChild?.textContent).toBe("```");
    } finally {
      editor.destroy();
    }
  });

  /*
   * A CHOICE reaches back over a code block, a PROMPT does not. In a choice
   * the flow is one snippet: the opening fence has already become a block, the
   * lines after it are paragraphs (Ctrl+Enter leaves a block), and the closing
   * fence has to gather them back. In a prompt, a teacher typing ``` under a
   * block they wrote earlier is opening a SECOND one, and swallowing the prose
   * between the two would be the worst thing this could do.
   */
  it("reaches back over a block already opened, in an inline field", () => {
    // What a CHOICE looks like mid-flow: the fence opened a block, Ctrl+Enter
    // left it, and the two lines after it are paragraphs.
    const editor = editorWith(
      [fenceNode("c", "int main(void) {"), para("    return 0;"), para("}")],
      true,
    );
    try {
      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");
      type(editor, "```");
      expect(firstChild(editor).type.name).toBe("codeBlock");
      expect(editor.getMarkdown().trimEnd()).toBe(
        "```c\nint main(void) {\n    return 0;\n}\n```",
      );
    } finally {
      editor.destroy();
    }
  });

  it("leaves the prose alone in a block field, where ``` opens a second fence", () => {
    const editor = editorWith([fenceNode("c", "int x;"), para("Corrigez-le :")]);
    try {
      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");
      type(editor, "```");
      expect(editor.state.doc.child(1).textContent).toBe("Corrigez-le :");
      expect(editor.state.doc.lastChild?.textContent).toBe("```");
    } finally {
      editor.destroy();
    }
  });
});

/*
 * Leaving a block, which is the other half of being able to open one. Two of
 * these are Tiptap's own rules and are asserted because they are OPTIONS: they
 * are off by default in some versions of the extension, and a teacher stuck
 * inside a fenced block at the end of a prompt has no way out at all.
 */
describe("getting out of a fenced block", () => {
  /*
   * The DOCUMENT is what these read, never the caret: `keyboardShortcut`
   * replays the STEPS of the command it ran and drops the selection it set, so
   * a caret assertion here would measure the test helper. Where the caret
   * lands is checked in the browser, on the real editor.
   */
  it("makes a paragraph on ArrowDown when nothing follows (exitOnArrowDown)", () => {
    const editor = editorFor("```c\nint x;\n```");
    try {
      expect(editor.state.doc.childCount).toBe(1);
      editor.commands.focus("end");
      editor.commands.keyboardShortcut("ArrowDown");
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    } finally {
      editor.destroy();
    }
  });

  it("makes a paragraph on the third Enter of an empty last line (exitOnTripleEnter)", () => {
    const editor = editorFor("```c\nint x;\n```");
    try {
      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");
      editor.commands.keyboardShortcut("Enter");
      expect(firstChild(editor).textContent).toBe("int x;\n\n");
      editor.commands.keyboardShortcut("Enter");
      // The two empty lines go with the exit: they were the gesture.
      expect(firstChild(editor).textContent).toBe("int x;");
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    } finally {
      editor.destroy();
    }
  });

  it("indents by two spaces on Tab and back on Shift+Tab", () => {
    const editor = editorFor("```c\nint x;\n```");
    try {
      editor.commands.focus("start");
      editor.commands.keyboardShortcut("Tab");
      expect(firstChild(editor).textContent).toBe("  int x;");
      editor.commands.keyboardShortcut("Shift-Tab");
      expect(firstChild(editor).textContent).toBe("int x;");
      // Nothing left to remove: the key is spent, not handed to the page.
      expect(editor.commands.keyboardShortcut("Shift-Tab")).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});
