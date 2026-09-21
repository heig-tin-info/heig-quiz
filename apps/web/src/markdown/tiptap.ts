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
import { Extension, InputRule, flattenExtensions } from "@tiptap/core";
import type { AnyExtension, Node as TiptapNode, NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extension-placeholder";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";

import { clozeHoleExtensions } from "./clozeHole";
import { CodeHighlight } from "./codeHighlight";
import { assetUrl, assetWidth } from "./render";

/** KaTeX behaves here as in the student view: a broken formula shows, it never throws. */
const KATEX_OPTIONS = { throwOnError: false } as const;

/**
 * What an INLINE field (one choice of an mcq) lets the keyboard build: the
 * marks and a formula, never a block. Typing "- " at the head of a choice
 * writes "- ", it does not turn the choice into a bullet list.
 */
export const INLINE_INPUT_RULES = [
  "bold",
  "italic",
  "code",
  "strike",
  "inlineMath",
  // The one BLOCK rule an inline field keeps. A choice is allowed a second
  // paragraph (Ctrl+Enter in `RichText`), and the reason a teacher asks for
  // one is almost always a snippet: "Which of these compiles?" with three
  // lines of C under it. Typing ``` on that new line must open the fence, or
  // the field can hold a block it gives no way to make. The list and heading
  // rules stay off: "- " at the head of a choice is still the two characters
  // the teacher typed.
  "codeBlock",
  // The two rules of `CodeFence` below: the fence that opens a block with its
  // language, and the closing fence that gathers what was typed before it.
  "codeFence",
  // Only a field with `holes` carries the extension at all, so listing its
  // rule here costs nothing elsewhere — and a `cloze` text is authored in a
  // block field anyway.
  "clozeHole",
] as const;

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
          if (resolved === null) return { src };
          // The WIDTH lives in the reference too (`asset:<id>?w=50`), and it
          // is rendered as the student's own class so a copy of the editor's
          // HTML looks like the question. The editor itself draws through the
          // node view below, which sizes the FRAME rather than the picture.
          const width = assetWidth(src);
          return {
            src: resolved,
            "data-asset": src,
            ...(width === 100 ? {} : { class: `md-img-${width}` }),
          };
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

/**
 * Replaces the paragraph the range sits in with `node`, when the range covers
 * the whole of it and the parent accepts a block there. Returns false when it
 * does not, so a caller can leave the text alone rather than drop a block node
 * inside a textblock.
 */
function replaceWholeParagraph(
  tr: Transaction,
  doc: ProseMirrorNode,
  from: number,
  to: number,
  node: ProseMirrorNode,
): boolean {
  const $from = doc.resolve(from);
  if ($from.depth === 0 || !$from.parent.isTextblock) return false;
  if (from !== $from.start() || to !== $from.end()) return false;
  if (!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), node.type)) return false;
  tr.replaceWith($from.before(), $from.after(), node);
  return true;
}

/** The two shapes a line that is nothing but dollars can have while typing. */
const EMPTY_FENCE = /^\$\$$/;
const FULL_FENCE = /^\$\$([^$]+)\$\$$/;

const BlockMathTyping = BlockMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: FULL_FENCE,
        handler: ({ state, range, match }) => {
          const latex = (match[1] ?? "").trim();
          if (!latex) return;
          const { tr } = state;
          const node = this.type.create({ latex });
          // Replace the host paragraph when the rule consumed the whole of it;
          // otherwise a block node would land inside a textblock.
          if (!replaceWholeParagraph(tr, state.doc, range.from, range.to, node))
            tr.replaceWith(range.from, range.to, node);
        },
      }),
      /*
       * `$$` ALONE on a line, the moment the second dollar is typed. This is
       * how a teacher actually writes a display formula — `$$`, Enter, the
       * latex, Enter, `$$` — and with only the rule above they got three
       * paragraphs of dollars and no formula, because the closing fence was
       * never on the same line as the opening one.
       *
       * The node is created EMPTY and `RichText` opens the formula dialog on
       * it: there is nothing to type into a rendered formula, so the editor
       * hands over to the one surface that can edit it.
       */
      new InputRule({
        find: EMPTY_FENCE,
        handler: ({ state, range }) => {
          replaceWholeParagraph(
            state.tr,
            state.doc,
            range.from,
            range.to,
            this.type.create({ latex: "" }),
          );
        },
      }),
    ];
  },

  /**
   * The same conversion on Enter, for the `$$` that the input rule could not
   * see: one pasted, one typed before the caret came back to the line, one
   * left over from an older version of the prompt. An inline field never
   * reaches this — `RichText` answers Enter first, from `editorProps`, which
   * ProseMirror consults before any plugin keymap.
   */
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.depth === 0 || !$from.parent.isTextblock) return false;
        const text = $from.parent.textContent;
        const full = FULL_FENCE.exec(text);
        const latex = full ? (full[1] ?? "").trim() : EMPTY_FENCE.test(text) ? "" : null;
        if (latex === null) return false;
        const { tr } = state;
        if (!replaceWholeParagraph(tr, state.doc, $from.start(), $from.end(), this.type.create({ latex })))
          return false;
        editor.view.dispatch(tr);
        return true;
      },
    };
  },
});

/*
 * ---------------------------------------------------------------------------
 * The fence, as a teacher writes one.
 *
 * A teacher does not press a "code block" button: they type ``` — usually
 * ```c — and then the lines, and then ``` again, because that is what markdown
 * is. Before this, that produced five paragraphs of literal backticks: the
 * shipped input rule of StarterKit only fires on ``` followed by a SPACE, and
 * an inline field never even reaches it, since its Enter belongs to the host.
 *
 * Two mechanisms, and they meet in the middle:
 *
 *  - OPENING. A paragraph that is exactly ``` or ```lang becomes an empty code
 *    block with that language, on Enter, Ctrl+Enter or Shift+Enter (and still
 *    on a space, through the input rule). In an inline field `RichText` calls
 *    the same command from its own key handler, BEFORE the host's "next
 *    choice" — a teacher opening a fence is not asking for another choice.
 *  - CLOSING, retroactively. The moment a third backtick alone on a line is
 *    typed, everything between it and the nearest fence above is gathered into
 *    ONE code block with the opening fence's language. That is what rescues
 *    the paragraphs already written, and it is also what closes the block in
 *    the flow below: Ctrl+Enter inside a block leaves it (a rule of its own),
 *    so the lines a teacher types after the first one land as paragraphs until
 *    the closing fence gathers them back.
 *
 * `mergeIntoBlock` is why the second half works in a CHOICE and not in a
 * prompt. Reaching back over an existing code block is right where a field
 * holds one snippet; in a prompt, where a teacher types ``` under a block they
 * wrote earlier to start a SECOND one, it would swallow the prose between the
 * two. An inline field turns it on, a block field leaves it off and merges
 * only over a fence written as text, which is unambiguous.
 * ---------------------------------------------------------------------------
 */

/** A line that is nothing but a fence: ``` or ```lang. */
const FENCE_LINE = /^```([A-Za-z0-9+#._-]*)$/;

/** The same, while it is being typed: the whitespace is what fires the rule. */
const FENCE_TYPED = /^```([A-Za-z0-9+#._-]*)[\s\n]$/;

/** The third backtick of a line that holds nothing else. */
const FENCE_CLOSING = /^```$/;

/** `language` is left unset rather than empty, so the fence serializes as ```. */
const languageAttrs = (language: string) => (language === "" ? {} : { language });

/**
 * The closing fence: replaces everything from the nearest fence above the
 * caret to the paragraph the caret sits in with one code block.
 *
 * The caret's own paragraph is DROPPED, whatever it holds — it is the closing
 * fence, and the third backtick that fires the input rule is not even in the
 * document yet when this runs.
 */
function closeCodeFence(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  mergeIntoBlock: boolean,
): boolean {
  const type = state.schema.nodes.codeBlock;
  if (!type) return false;
  const { $from } = state.selection;
  if ($from.depth === 0) return false;
  const parent = $from.node(-1);
  const index = $from.index(-1);

  let open = -1;
  let language = "";
  let fromBlock = false;
  for (let i = index - 1; i >= 0; i -= 1) {
    const child = parent.child(i);
    if (child.type === type) {
      if (!mergeIntoBlock) break;
      open = i;
      language = typeof child.attrs.language === "string" ? child.attrs.language : "";
      fromBlock = true;
      break;
    }
    // An image, a table, a quote: the fence above, if there is one, belongs to
    // something else. Stop rather than swallow it.
    if (!child.isTextblock) break;
    const match = FENCE_LINE.exec(child.textContent.trim());
    if (match) {
      open = i;
      language = match[1] ?? "";
      break;
    }
  }
  if (open === -1) return false;
  if (!parent.canReplaceWith(open, index + 1, type)) return false;

  const lines: string[] = [];
  if (fromBlock) lines.push(parent.child(open).textContent);
  for (let i = open + 1; i < index; i += 1) lines.push(parent.child(i).textContent);
  // An empty opening block contributes nothing, not a blank first line.
  while (lines.length > 0 && lines[0] === "") lines.shift();
  const text = lines.join("\n");

  if (dispatch) {
    let from = $from.start(-1);
    for (let i = 0; i < open; i += 1) from += parent.child(i).nodeSize;
    const node = type.create(
      languageAttrs(language),
      text === "" ? null : state.schema.text(text),
    );
    const tr = state.tr.replaceWith(from, $from.after(), node);
    // The caret lands at the END of the block that was just gathered, which is
    // where the teacher was looking.
    tr.setSelection(TextSelection.near(tr.doc.resolve(from + node.nodeSize - 1), -1));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * The fence under the caret becomes a code block: the closing one gathers what
 * is above it, the opening one turns into an empty block the caret drops into.
 *
 * Exported because an inline field cannot go through a keymap: `RichText`
 * answers Enter from `editorProps`, which ProseMirror consults before any
 * plugin, and has to run this itself.
 */
export function openCodeFence(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  mergeIntoBlock = false,
): boolean {
  const type = state.schema.nodes.codeBlock;
  if (!type) return false;
  const { $from, empty } = state.selection;
  if (!empty || $from.depth === 0 || !$from.parent.isTextblock) return false;
  // Inside a block already: the fence is code, not syntax.
  if ($from.parent.type === type) return false;
  const match = FENCE_LINE.exec($from.parent.textContent.trim());
  if (!match) return false;
  const language = match[1] ?? "";
  // A bare ``` is a CLOSING fence whenever there is something to close.
  if (language === "" && closeCodeFence(state, dispatch, mergeIntoBlock)) return true;
  if (!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), type)) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith($from.before(), $from.after(), type.create(languageAttrs(language)));
    tr.setSelection(TextSelection.near(tr.doc.resolve($from.before() + 1)));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/*
 * The shipped table renderer opens with a newline of its own and closes with
 * another, on top of the blank line the serializer already puts between two
 * blocks: a table between two paragraphs came back with THREE newlines on
 * each side, and a document that is only a table came back starting with an
 * empty line. Nothing downstream minds, but the stored source is what a
 * teacher reads in the source pane and what a diff of a version shows.
 */
const MarkdownTable = Table.extend({
  renderMarkdown(
    this: { parent?: ((node: unknown, helpers: unknown) => string) | null },
    node: unknown,
    helpers: unknown,
  ): string {
    return (this.parent?.(node, helpers) ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
  },
});

export interface CodeFenceOptions {
  /** See the block comment above: on for a choice, off for a prompt. */
  mergeIntoBlock: boolean;
}

const CodeFence = Extension.create<CodeFenceOptions>({
  name: "codeFence",
  // Ahead of the core keymap, whose Enter would have split the paragraph
  // before this ever saw the fence.
  priority: 1000,

  addOptions() {
    return { mergeIntoBlock: false };
  },

  addInputRules() {
    return [
      /*
       * ```lang and a space (or a newline: the input-rule plugin runs the
       * rules on Enter too, with "\n" as the typed text). StarterKit ships the
       * same rule for a lowercase tag only, so `c++`, `python3` and `c#` used
       * to fall through it.
       */
      new InputRule({
        find: FENCE_TYPED,
        handler: ({ state, range, match }) => {
          const type = state.schema.nodes.codeBlock;
          if (!type) return;
          replaceWholeParagraph(
            state.tr,
            state.doc,
            range.from,
            range.to,
            type.create(languageAttrs(match[1] ?? "")),
          );
        },
      }),
      /*
       * The closing fence, the moment its third backtick is typed. Nothing
       * happens when there is no fence above — the rule leaves the transaction
       * empty and the backtick is typed as itself.
       */
      new InputRule({
        find: FENCE_CLOSING,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if (!$from.parent.isTextblock) return;
          if (range.from !== $from.start() || range.to !== $from.end()) return;
          closeCodeFence(state, () => undefined, this.options.mergeIntoBlock);
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const open = () =>
      openCodeFence(this.editor.state, this.editor.view.dispatch, this.options.mergeIntoBlock);
    // A teacher reaches for Enter, a developer for Ctrl+Enter, and Shift+Enter
    // is what a choice answers to; all three open the fence under the caret.
    return { Enter: open, "Mod-Enter": open, "Shift-Enter": open };
  },
});

/*
 * StarterKit's own code block, taken out of the kit so it can be EXTENDED.
 * `@tiptap/extension-code-block` is not a dependency of this app (the kit is),
 * and under pnpm's strict layout importing it directly resolves to nothing.
 * `flattenExtensions` is Tiptap's own way of expanding a kit into what it
 * carries — the extension manager does exactly this with it — so the node, its
 * markdown handlers and its version stay the kit's.
 */
const StarterCodeBlock = flattenExtensions([StarterKit]).find(
  (extension) => extension.name === "codeBlock",
) as TiptapNode;

export interface RichTextSchemaOptions {
  /** Shown by the Placeholder extension through `data-placeholder`. */
  placeholder?: string;
  /**
   * The node view of the image node, when the host has one. It is a function
   * and not a component because THIS MODULE HOLDS NO REACT (see the head of
   * the file): `RichText` passes `() => ReactNodeViewRenderer(ImageView)`, and
   * the round-trip tests build the same schema without any of it.
   */
  imageNodeView?: () => NodeViewRenderer;
  /** The node view of the code block (its language field), same rule as above. */
  codeBlockNodeView?: () => NodeViewRenderer;
  /**
   * The field is one row of a list (a choice). It changes NO schema — the head
   * of this file says why there is only one — and only the interaction rules
   * that cannot be expressed anywhere else: here, whether a closing fence may
   * gather a code block written above it (`CodeFence`).
   */
  inline?: boolean;
  /**
   * The `{{…}}` holes of the `cloze` type become chips (`clozeHole.ts`). OFF
   * by default and opt-in per field: `{{` is two ordinary braces in an mcq
   * prompt, and an input rule that swallowed them there would be a trap.
   */
  cloze?: boolean;
}

/**
 * The extension list, in the order Tiptap registers them.
 *
 * `Markdown` is last and sees every other extension: Tiptap flattens the list
 * and hands it to the `MarkdownManager`, so each extension's own markdown
 * handlers are picked up wherever it sits.
 */
export function richTextExtensions({
  placeholder,
  imageNodeView,
  codeBlockNodeView,
  inline = false,
  cloze = false,
}: RichTextSchemaOptions = {}): AnyExtension[] {
  const image = imageNodeView ? AssetImage.extend({ addNodeView: imageNodeView }) : AssetImage;
  const code = codeBlockNodeView
    ? StarterCodeBlock.extend({ addNodeView: codeBlockNodeView })
    : StarterCodeBlock;
  return [
    StarterKit.configure({
      // A link is edited, not followed, inside an editor.
      link: { openOnClick: false },
      // Taken out of the kit and put back below, extended (see `CodeFence`).
      codeBlock: false,
    }),
    // Two spaces and not four: a snippet in a question is read in a narrow
    // column, and C in this school is written with two.
    code.configure({ enableTabIndentation: true, tabSize: 2 }),
    CodeFence.configure({ mergeIntoBlock: inline }),
    // Inside a fenced block a hole stays TEXT — the content of a code block is
    // text, and a node cannot live in it — so it is coloured by a decoration
    // instead, like the keywords around it.
    CodeHighlight.configure({ holes: cloze }),
    image.configure({ allowBase64: false }),
    InlineMathTyping.configure({ katexOptions: KATEX_OPTIONS }),
    BlockMathTyping.configure({ katexOptions: KATEX_OPTIONS }),
    // GFM task lists. StarterKit does not carry them and `render.ts` does, so
    // without these two a `- [x] done` in a prompt came back a plain bullet —
    // a silent loss on the next autosave.
    TaskList,
    TaskItem.configure({ nested: true }),
    /*
     * GFM tables, in EVERY field. `@tiptap/extension-table` 3.31 ships the
     * markdown handlers (`markdownTokenizer`, `parseMarkdown`,
     * `renderMarkdown`), so nothing is written here but the trim below: a
     * `| a | b |` table round-trips through marked's own `table` token, cells
     * padded to the column width. Column resizing is off — a width dragged in
     * the editor has nowhere to be stored, markdown being the single source of
     * truth, so the handle would promise what the save cannot keep.
     */
    MarkdownTable.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({ placeholder: placeholder ?? "" }),
    ...clozeHoleExtensions(cloze),
    Markdown,
  ];
}
