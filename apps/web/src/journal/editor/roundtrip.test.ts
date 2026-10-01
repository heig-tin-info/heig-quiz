/**
 * @vitest-environment jsdom
 *
 * D25, condition 1: a journal page opened in the editor and written back
 * without an edit is the page it was — over a synthetic journal committed
 * beside this file (`synthetic-journal/`), and over a real one when
 * `JOURNAL_CORPUS_DIR` names a directory of markdown files (kept outside this
 * public repository, like the exam corpus; skipped otherwise).
 *
 * "Written back" is the whole path the editor takes: the front matter split
 * off into fields and joined again (frontMatter.ts), the body through the
 * journal's schema (markdown/journalSchema.ts) and serialized, then
 * reconciled with what was opened (reconcile.ts). The accepted
 * normalisations — what the SCHEMA alone writes differently, and therefore
 * what an EDITED block may change beyond its edit — are asserted at the end,
 * so a new version of `@tiptap/markdown` cannot widen the list quietly.
 */
import { Editor } from "@tiptap/core";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { richTextExtensions, spellWith } from "../../markdown/tiptap";
import { composePage, readFields, splitPage } from "./frontMatter";
import { reconciler } from "./reconcile";

// jsdom has no layout; ProseMirror asks for rectangles (markdown/roundtrip.test.ts says why here).
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
document.elementFromPoint ??= () => null;

function journalEditor(body: string): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: richTextExtensions({ journal: true }),
    content: body,
    contentType: "markdown",
  });
}

/** What the schema alone writes for `body` (trimmed, as the field emits it). */
function schemaRoundTrip(body: string): string {
  const editor = journalEditor(body);
  try {
    return editor.getMarkdown().trim();
  } finally {
    editor.destroy();
  }
}

/** The editor's whole path, page in, page out, no edit. */
function pageRoundTrip(page: string): string {
  const split = splitPage(page);
  const editor = journalEditor(split.body);
  try {
    const body = reconciler(split.body)(editor.getMarkdown().trim(), spellWith(editor));
    return composePage(split, readFields(split.yaml), body);
  } finally {
    editor.destroy();
  }
}

/** The page after `edit` changed the editor's document, through the same path. */
function pageAfter(page: string, edit: (editor: Editor) => void): string {
  const split = splitPage(page);
  const editor = journalEditor(split.body);
  try {
    edit(editor);
    const body = reconciler(split.body)(editor.getMarkdown().trim(), spellWith(editor));
    return composePage(split, readFields(split.yaml), body);
  } finally {
    editor.destroy();
  }
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (name.startsWith(".")) return [];
      if (statSync(path).isDirectory()) return markdownFiles(path);
      return /\.md$/i.test(name) ? [path] : [];
    });
}

const SYNTHETIC = join(__dirname, "synthetic-journal");
const synthetic = markdownFiles(SYNTHETIC).map((path) => [relative(SYNTHETIC, path), readFileSync(path, "utf8")]);

describe("D25 (1): the synthetic journal comes back unchanged", () => {
  it("holds every construct the card names", () => {
    const all = synthetic.map(([, md]) => md).join("\n");
    for (const construct of [
      /^#{1,3} /m, // headings
      /^- \[/m, // lists of links
      /^ {2}- /m, // nested bullet list
      /^ {3}1\. /m, // nested ordered list
      /^\| .* \|$/m, // tables
      /^```c$/m, // a fence with a language
      /\$[^$\n]+\$/, // inline KaTeX
      /^\$\$$/m, // display KaTeX
      /\]\([^)]+\.md#[^)]+\)/, // relative link with an anchor
      /!\[[^\]]*\]\((?!https?:)[^)]+\)/, // relative image
      /^---\n[\s\S]*?\n---\n/m, // front matter
      /^> /m, // blockquote
      /<details>/, // raw inline HTML
      /^<div/m, // raw block HTML
      /_[^_\s][^_]*_/, // emphasis with _
      /\*[^*\s][^*]*\*/, // emphasis with *
      / {2}\n/, // hard break, two spaces
      /\\\n/, // hard break, backslash
    ]) {
      expect(all, String(construct)).toMatch(construct);
    }
  });

  it.each(synthetic)("%s", (_name, page) => {
    expect(pageRoundTrip(page)).toBe(page);
  });

  it.each(synthetic)("%s keeps its front matter out of the editor", (_name, page) => {
    expect(splitPage(page).body).not.toMatch(/^---\n[\s\S]*?\n---/);
  });
});

const corpusDir = process.env.JOURNAL_CORPUS_DIR;
const corpus = corpusDir && existsSync(corpusDir) ? markdownFiles(corpusDir) : [];

describe.skipIf(corpus.length === 0)(
  `D25 (1) on a real journal (JOURNAL_CORPUS_DIR${corpusDir ? `=${corpusDir}` : " unset: skipped"})`,
  () => {
    it.each(corpus.map((path) => [relative(corpusDir!, path), path]))("%s", (_name, path) => {
      const page = readFileSync(path, "utf8");
      expect(pageRoundTrip(page)).toBe(page);
    });
  },
);

describe("D25 (1): constructs the journal's schema writes back as read", () => {
  it.each([
    ["_emphasis_ and *emphasis*"],
    ["__strong__ and **strong**"],
    ["***both***"],
    ["* a\n* b"],
    ["+ a\n+ b"],
    ["- a\n  - a1\n- b"],
    ["1. a\n2. b\n   1. b1"],
    ["***"],
    ["___"],
    ["a  \nb"],
    ["a\\\nb"],
    ["<https://heig-vd.ch>"],
    ["[relative](../semaine-02.md#exercices)"],
    ["![schema](images/schema.png)"],
    ["![gdb](../images/gdb.png \"Session\")"],
    ["$x^2$ and $$\n\\int_0^1 f\n$$".split(" and ")[0]!],
    ["$$\n\\int_0^1 f(x)\\,dx\n$$"],
    ["Text with <kbd>Ctrl</kbd> keys."],
    ["<!-- a comment -->"],
    ["<div class=\"note\">\nraw block\n</div>"],
    ["> quote\n>\n> > nested"],
    ["```c\nint x;\n```"],
    ["- [ ] todo\n- [x] done"],
  ])("%j", (source) => {
    expect(schemaRoundTrip(source)).toBe(source);
  });
});

/*
 * What the schema writes differently. None of these changes the rendered
 * page; they change its SPELLING, and only in a block the teacher edits —
 * every other block is written back as read (reconcile.ts). Each line is
 * one accepted normalisation, reported in docs/merge/09-tasks.md (M4-06).
 */
describe("D25 (1): the accepted normalisations of an edited block, and only these", () => {
  it.each([
    ["| a | b |\n|:-|-:|\n| 1 | 2 |", "| a   | b   |\n| :--- | ---: |\n| 1   | 2   |", "a table is re-padded to its columns"],
    ["Title\n=====", "# Title", "a setext heading becomes an ATX one"],
    ["~~~\ncode\n~~~", "```\ncode\n```", "a tilde fence becomes a backtick fence"],
    ["    indented code", "```\nindented code\n```", "an indented code block becomes a fence"],
    ["1) a\n2) b", "1. a\n2. b", "one ordered-list delimiter"],
    ["1. a\n1. b", "1. a\n2. b", "an ordered list is numbered"],
    ["$$x$$", "$$\nx\n$$", "a display formula is written on three lines"],
    ["https://heig-vd.ch", "[https://heig-vd.ch](https://heig-vd.ch)", "a bare URL becomes an explicit link"],
    ["a * b", "a \\* b", "a literal delimiter is escaped"],
    ["R&amp;D", "R&amp;D", "an entity is kept (identity)"],
    ["R&D and a < b", "R&amp;D and a &lt; b", "a bare & or < in text is written as an entity"],
    ["[a][r]\n\n[r]: https://x.ch", "[a](https://x.ch)", "a reference link is inlined (its definition is kept by the reconciliation)"],
  ])("%j -> %j (%s)", (source, expected) => {
    expect(schemaRoundTrip(source)).toBe(expected);
    expect(schemaRoundTrip(expected)).toBe(expected);
  });
});

describe("the reconciliation writes only the edited block", () => {
  const page = synthetic.find(([name]) => name === "index.md")![1]!;

  it("rewrites the one paragraph typed into, and nothing around it", () => {
    const out = pageAfter(page, (editor) => {
      // The end of "Bienvenue dans le journal du cours. …".
      let at = -1;
      editor.state.doc.descendants((node, pos) => {
        if (at === -1 && node.isTextblock && node.textContent.startsWith("Bienvenue")) at = pos + node.nodeSize - 1;
      });
      editor.chain().insertContentAt(at, " Bonne lecture !").run();
    });
    expect(out).toBe(page.replace("ci-dessous.", "ci-dessous. Bonne lecture !"));
  });

  it("keeps a table it did not touch byte for byte, when another block changes", () => {
    const out = pageAfter(page, (editor) => {
      editor.chain().insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "Fin." }] }).run();
    });
    expect(out).toContain("| Épreuve | Poids | Date |\n| --- | --- | --- |");
    expect(out.endsWith("**gras étoilé**.\n\nFin.\n")).toBe(true);
  });

  it("deletes a block the teacher deleted, and leaves its neighbours as they were", () => {
    const out = pageAfter(page, (editor) => {
      let range: { from: number; to: number } | null = null;
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name === "blockquote") range = { from: offset, to: offset + node.nodeSize };
      });
      editor.chain().deleteRange(range!).run();
    });
    expect(out).not.toContain("> **Important**");
    expect(out).toContain("| Examen | 40 % | janvier |\n\nUn texte avec de l'_emphase soulignée_");
  });

  it("keeps a link definition the editor cannot show", () => {
    const source = "Voir [le site][heig].\n\n[heig]: https://heig-vd.ch\n\nFin.\n";
    const out = pageAfter(source, (editor) => {
      editor.chain().insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "Ajout." }] }).run();
    });
    expect(out).toBe("Voir [le site][heig].\n\n[heig]: https://heig-vd.ch\n\nFin.\n\nAjout.\n");
  });

  it("gives back the very source once an edit is undone", () => {
    const out = pageAfter(page, (editor) => {
      editor.chain().insertContentAt(1, "X").run();
      editor.chain().deleteRange({ from: 1, to: 2 }).run();
    });
    expect(out).toBe(page);
  });
});
