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
    extensions: richTextExtensions(),
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
    extensions: richTextExtensions(),
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
