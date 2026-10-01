/*
 * The journal's spelling of markdown (M4-06, D25): the extensions that make
 * the rich editor write a page back the way its author wrote it.
 *
 * A question's prompt lives in the database and is only ever read rendered,
 * so its editor may normalise (`_x_` becomes `*x*`, roundtrip.test.ts lists
 * every case). A journal page lives in a git repository: every normalisation
 * is a line of noise in a teacher's diff, and raw HTML is something the
 * question editor parses and DROPS. So, for the journal only:
 *
 *  - emphasis and strong remember their delimiter (`_` or `*`, `__` or `**`);
 *  - a bullet list remembers its marker (`-`, `*` or `+`);
 *  - a thematic break remembers its spelling (`***`, `___`, `- - -`);
 *  - a hard break remembers its form (two spaces, or a backslash);
 *  - an autolink (`<https://…>`) stays one;
 *  - raw HTML is a literal node, shown as text (D15: the journal shows raw
 *    HTML as text) and written back verbatim, block or inline.
 *
 * What is still not the identity is whitespace inside a block the teacher
 * edited (a table's padding) and a few spellings this file does not chase;
 * `journal/editor/reconcile.ts` puts every block the teacher did NOT edit
 * back exactly as it was read, and `journal/editor/roundtrip.test.ts` lists
 * the rest.
 *
 * Like tiptap.ts, no React here: the round-trip test builds this schema
 * headless.
 */
import { flattenExtensions, mergeAttributes, Node } from "@tiptap/core";
import type { AnyExtension, Mark as TiptapMark, Node as TiptapNode } from "@tiptap/core";
import type { Mark as ProseMirrorMark, MarkType } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";

/** The kit's own extension by name, to be extended (tiptap.ts says why not imported directly). */
const kit = <T extends AnyExtension>(name: string) =>
  flattenExtensions([StarterKit]).find((extension) => extension.name === name) as T;

/** An attribute the markdown reads and writes, never drawn into the HTML. */
const sourceOnly = (fallback: string | null) => ({ default: fallback, rendered: false });

/** `_x_` or `*x*`, as written. */
const Italic = kit<TiptapMark>("italic").extend({
  addAttributes() {
    return { delimiter: sourceOnly("*") };
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark("italic", helpers.parseInline(token.tokens ?? []), {
      delimiter: token.raw?.startsWith("_") ? "_" : "*",
    }),
  renderMarkdown: (node, h) => {
    const d = node.attrs?.delimiter === "_" ? "_" : "*";
    return `${d}${h.renderChildren(node)}${d}`;
  },
});

/** `__x__` or `**x**`, as written. */
const Bold = kit<TiptapMark>("bold").extend({
  addAttributes() {
    return { delimiter: sourceOnly("**") };
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark("bold", helpers.parseInline(token.tokens ?? []), {
      delimiter: token.raw?.startsWith("__") ? "__" : "**",
    }),
  renderMarkdown: (node, h) => {
    const d = node.attrs?.delimiter === "__" ? "__" : "**";
    return `${d}${h.renderChildren(node)}${d}`;
  },
});

/** The marker of a bullet list, from the raw source of its first item. */
const bulletOf = (raw: string | undefined): string => {
  const m = /^\s*([-*+])\s/.exec(raw ?? "");
  return m?.[1] ?? "-";
};

const BulletList = kit<TiptapNode>("bulletList").extend({
  addAttributes() {
    return { bullet: sourceOnly("-") };
  },
  parseMarkdown: (token, helpers) => {
    if (token.type !== "list" || token.ordered) return [];
    return {
      type: "bulletList",
      attrs: { bullet: bulletOf(token.raw) },
      content: token.items ? helpers.parseChildren(token.items) : [],
    };
  },
});

/** The item writes `- `; under a list that was written with another marker, that one. */
type RenderMarkdown = NonNullable<TiptapNode["config"]["renderMarkdown"]>;

const ListItem = kit<TiptapNode>("listItem").extend({
  renderMarkdown(this: { parent?: RenderMarkdown | null }, node, h, ctx) {
    const out: string = this.parent?.(node, h, ctx) ?? "";
    const bullet = ctx?.parentType === "bulletList" ? ctx.meta?.parentAttrs?.bullet : undefined;
    return typeof bullet === "string" && bullet !== "-" ? out.replace(/^- /, `${bullet} `) : out;
  },
});

const HorizontalRule = kit<TiptapNode>("horizontalRule").extend({
  addAttributes() {
    return { marker: sourceOnly("---") };
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode("horizontalRule", { marker: (token.raw ?? "").trim() || "---" }),
  renderMarkdown: (node) => (typeof node.attrs?.marker === "string" ? node.attrs.marker : "---"),
});

const HardBreak = kit<TiptapNode>("hardBreak").extend({
  addAttributes() {
    return { backslash: { default: false, rendered: false } };
  },
  parseMarkdown: (token) => ({
    type: "hardBreak",
    attrs: { backslash: (token.raw ?? "").startsWith("\\") },
  }),
  renderMarkdown: (node) => (node.attrs?.backslash ? "\\\n" : "  \n"),
});

/** `<https://…>` stays an autolink; anything else is the kit's `[text](href)`. */
const Link = kit<TiptapMark>("link").extend({
  addAttributes() {
    return { ...this.parent?.(), autolink: { default: false, rendered: false } };
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark("link", helpers.parseInline(token.tokens ?? []), {
      href: token.href,
      title: token.title || null,
      autolink: (token.raw ?? "").startsWith("<"),
    }),
  // A mark is rendered around a placeholder (the manager cuts its opening and
  // closing off it), so the text is not known here: `autoLinkKeeper` below
  // drops the flag the moment the text stops being the address.
  renderMarkdown: (node, h) => {
    const href = node.attrs?.href ?? "";
    const title = node.attrs?.title ?? "";
    const text = h.renderChildren(node);
    if (node.attrs?.autolink) return `<${text}>`;
    return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`;
  },
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), autoLinkKeeper(this.type)];
  },
});

/**
 * An autolink stays one only while its text IS its address. Once the text is
 * edited (`<https://x>` retyped as "the site"), the link is an ordinary
 * `[text](href)`, or `<…>` would write the edited text as the address.
 */
function autoLinkKeeper(type: MarkType): Plugin {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((t) => t.docChanged)) return null;
      const tr = state.tr;
      state.doc.descendants((block, blockPos) => {
        if (!block.isTextblock) return true;
        let run: { from: number; to: number; text: string; mark: ProseMirrorMark } | null = null;
        const flush = () => {
          if (run && run.text !== run.mark.attrs.href) {
            tr.removeMark(run.from, run.to, run.mark);
            tr.addMark(run.from, run.to, type.create({ ...run.mark.attrs, autolink: false }));
          }
          run = null;
        };
        block.forEach((child, offset) => {
          const mark = child.marks.find((m) => m.type === type && m.attrs.autolink === true);
          const from = blockPos + 1 + offset;
          if (mark && child.isText && run && run.mark.eq(mark) && run.to === from) {
            run.to = from + child.nodeSize;
            run.text += child.text;
            return;
          }
          flush();
          if (mark && child.isText) run = { from, to: from + child.nodeSize, text: child.text ?? "", mark };
        });
        flush();
        return false;
      });
      return tr.docChanged || tr.steps.length > 0 ? tr : null;
    },
  });
}

/** The kit's extensions this file replaces, to turn off in `StarterKit.configure`. */
export const JOURNAL_KIT_OVERRIDES = {
  italic: false,
  bold: false,
  bulletList: false,
  listItem: false,
  horizontalRule: false,
  hardBreak: false,
  link: false,
} as const;

/** The attribute a literal HTML node is recognised by when the editor's HTML is parsed back. */
const RAW_ATTR = "data-raw-html";

/**
 * A block of raw HTML (`<div class="note">…</div>` on lines of its own):
 * one atom, drawn as the text it is, written back as it was read.
 */
const RawHtmlBlock = Node.create({
  name: "rawHtmlBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { raw: { default: "", rendered: false } };
  },
  parseHTML() {
    return [{ tag: `pre[${RAW_ATTR}]`, getAttrs: (el) => ({ raw: (el as HTMLElement).textContent ?? "" }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["pre", mergeAttributes(HTMLAttributes, { [RAW_ATTR]: "", class: "rt-raw-html" }), String(node.attrs.raw)];
  },
  markdownTokenName: "html",
  parseMarkdown: (token) => {
    if (!token.block) return [];
    const raw = (token.raw ?? "").replace(/\s+$/, "");
    return raw ? { type: "rawHtmlBlock", attrs: { raw } } : [];
  },
  renderMarkdown: (node) => String(node.attrs?.raw ?? ""),
});

/** An inline tag or comment, as marked recognises one: `<span …>`, `</b>`, `<br/>`, `<!-- … -->`. */
const INLINE_TAG = /^(?:<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\s*\/?>)/;

/**
 * One inline tag of raw HTML. It needs a TOKENIZER of its own: the markdown
 * manager handles marked's inline `html` tokens itself (it parses them as
 * HTML, which drops what the schema does not know) before any extension is
 * asked, so the tag is claimed under another token name first.
 */
const RawHtmlInline = Node.create({
  name: "rawHtmlInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { raw: { default: "", rendered: false } };
  },
  parseHTML() {
    return [{ tag: `span[${RAW_ATTR}]`, getAttrs: (el) => ({ raw: (el as HTMLElement).textContent ?? "" }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { [RAW_ATTR]: "", class: "rt-raw-html" }), String(node.attrs.raw)];
  },
  markdownTokenName: "rawHtmlInline",
  markdownTokenizer: {
    name: "rawHtmlInline",
    level: "inline" as const,
    start: (src: string) => src.indexOf("<"),
    tokenize: (src: string) => {
      const match = INLINE_TAG.exec(src);
      return match ? { type: "rawHtmlInline", raw: match[0], text: match[0] } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: "rawHtmlInline", attrs: { raw: token.raw ?? "" } }),
  renderMarkdown: (node) => String(node.attrs?.raw ?? ""),
});

/** What the journal adds to the editor's extension list, in place of the kit's own. */
export function journalExtensions(): AnyExtension[] {
  return [Italic, Bold, BulletList, ListItem, HorizontalRule, HardBreak, Link.configure({ openOnClick: false }), RawHtmlBlock, RawHtmlInline];
}
