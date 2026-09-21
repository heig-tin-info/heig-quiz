/*
 * The Tiptap schema the WYSIWYG pane of `MarkdownField` and the `RichText`
 * component are built on (decision "Éditeur markdown" of docs/spec/05 §5.10:
 * Tiptap, markdown as the single source of truth).
 *
 * This module holds no React. It exists so that the ROUND TRIP — markdown in,
 * a ProseMirror document, markdown out — can be tested without mounting a
 * component, and so that the block editor and the one-paragraph inline editor
 * of a choice are built from the SAME extension list.
 *
 * `@tiptap/markdown` 3.31 does the work: every extension declares its own
 * `markdownTokenName` / `parseMarkdown` / `renderMarkdown` (and, for a
 * non-standard syntax, a `markdownTokenizer` for marked's lexer), the
 * `Markdown` extension wires them into a `MarkdownManager`, and the editor
 * gains `getMarkdown()` plus `contentType: "markdown"` for `content` and
 * `setContent`. Nothing here re-implements a serializer; the overrides below
 * exist because a shipped default is wrong FOR THIS APP, and each says why.
 *
 * ONE schema for both modes, deliberately. An earlier version gave the inline
 * field a document of `content: "paragraph"` and turned the block extensions
 * off — and a choice whose stored markdown happened to hold a heading or a
 * fence came back EMPTY, because ProseMirror cannot build a node type the
 * schema does not know and Tiptap then falls back to an empty document. A
 * WYSIWYG pane that can empty a stored value is not worth having, whatever it
 * gains in tidiness. "Inline" is therefore an interaction rule, not a schema:
 * the list of input rules below is what an inline field enables (no rule that
 * would create a block), and `RichText` intercepts Enter. Nothing is ever
 * dropped, in either mode.
 */
import { InputRule } from "@tiptap/core";
import type { AnyExtension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extension-placeholder";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";

import { assetUrl } from "./render";

/** KaTeX behaves here as in the student view: a broken formula shows, it never throws. */
const KATEX_OPTIONS = { throwOnError: false } as const;

/**
 * What an INLINE field (one choice of an mcq) lets the keyboard build: the
 * marks and a formula, never a block. Typing "- " at the head of a choice
 * writes "- ", it does not turn the choice into a bullet list.
 */
export const INLINE_INPUT_RULES = ["bold", "italic", "code", "strike", "inlineMath"] as const;

/**
 * An `asset:<id>` is not a URL a browser can fetch, and the editor has to SHOW
 * the picture the teacher just dropped. So the attribute keeps the canonical
 * `asset:` form — that is what `renderMarkdown` serializes and what is stored —
 * and only the rendered `src` is resolved to the same-origin endpoint. A URL
 * that is not an asset is left alone and simply does not load, which is what
 * the student view does with it too (`render.ts`).
 */
const AssetImage = Image.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      src: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-asset") ?? element.getAttribute("src"),
        renderHTML: (attributes: Record<string, unknown>) => {
          const src = typeof attributes.src === "string" ? attributes.src : "";
          const resolved = assetUrl(src);
          return resolved === null ? { src } : { src: resolved, "data-asset": src };
        },
      },
    };
  },
});

/**
 * Two things are replaced on the inline maths node.
 *
 * The TOKENIZER, because the shipped one trims the latex: `100 $ ou 5$` — a
 * price and a stray dollar, not a formula — came back one space shorter every
 * time the teacher touched the field. `render.ts` reads exactly the same span
 * as maths, so the editor agrees with the student view; it just no longer eats
 * anything.
 *
 * The INPUT RULE, because the shipped one is the opposite of what it
 * serializes to: typing `$$x$$` made an INLINE formula and a block one needed
 * `$$$x$$$`. The round trip is the contract here (`$…$` inline, `$$…$$`
 * display, as `render.ts` reads them), so both rules are rewritten. The
 * negative lookbehind is what lets `$$` be typed through without the inline
 * rule firing on the first pair.
 */
const InlineMathTyping = InlineMath.extend({
  markdownTokenizer: {
    name: "inlineMath",
    level: "inline" as const,
    start: (src: string) => src.indexOf("$"),
    tokenize: (src: string) => {
      const match = /^\$([^$\n]+)\$(?!\$)/.exec(src);
      if (!match) return undefined;
      return { type: "inlineMath", raw: match[0], latex: match[1] ?? "" };
    },
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(?<!\$)\$([^$\n]+)\$$/,
        handler: ({ state, range, match }) => {
          const latex = (match[1] ?? "").trim();
          if (!latex) return;
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex }));
        },
      }),
    ];
  },
});

const BlockMathTyping = BlockMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const latex = (match[1] ?? "").trim();
          if (!latex) return;
          const { tr } = state;
          const $from = state.doc.resolve(range.from);
          const node = this.type.create({ latex });
          // Replace the host paragraph when the rule consumed the whole of it;
          // otherwise a block node would land inside a textblock.
          const whole =
            $from.depth > 0 &&
            $from.parent.isTextblock &&
            range.from === $from.start() &&
            range.to === $from.end() &&
            $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type);
          if (whole) tr.replaceWith($from.before(), $from.after(), node);
          else tr.replaceWith(range.from, range.to, node);
        },
      }),
    ];
  },
});

export interface RichTextSchemaOptions {
  /** Shown by the Placeholder extension through `data-placeholder`. */
  placeholder?: string;
}

/**
 * The extension list, in the order Tiptap registers them.
 *
 * `Markdown` is last and sees every other extension: Tiptap flattens the list
 * and hands it to the `MarkdownManager`, so each extension's own markdown
 * handlers are picked up wherever it sits.
 */
export function richTextExtensions({ placeholder }: RichTextSchemaOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      // A link is edited, not followed, inside an editor.
      link: { openOnClick: false },
    }),
    AssetImage.configure({ allowBase64: false }),
    InlineMathTyping.configure({ katexOptions: KATEX_OPTIONS }),
    BlockMathTyping.configure({ katexOptions: KATEX_OPTIONS }),
    // GFM task lists. StarterKit does not carry them and `render.ts` does, so
    // without these two a `- [x] done` in a prompt came back a plain bullet —
    // a silent loss on the next autosave.
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: placeholder ?? "" }),
    Markdown,
  ];
}
