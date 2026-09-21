import type { Editor } from "@tiptap/core";
import { exitCode, newlineInCode, splitBlock } from "@tiptap/pm/commands";
import { NodeSelection, type EditorState } from "@tiptap/pm/state";
import { EditorContent, ReactNodeViewRenderer, useEditor, useEditorState } from "@tiptap/react";
import {
  Bold,
  Code,
  FileCode2,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  Sigma,
  SquareCode,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import type { RichTextProps } from "@quiz/core/client";

import { useT } from "../i18n";
import { useShortcuts, type Shortcut } from "../shortcuts";
import { Button, cx, IconButton, inputClass, modKey, type IconType } from "../ui";
import { CodeBlockView } from "./CodeBlockView";
import type { Formula, FormulaDialog } from "./FormulaDialog";
import { ImageToolsContext, ImageView } from "./ImageView";
import "./richtext.css";
import { SourcePane } from "./SourcePane";
import { INLINE_INPUT_RULES, openCodeFence, richTextExtensions } from "./tiptap";

/*
 * The WYSIWYG half of the markdown field (docs/spec/05 §5.10, decision
 * "Éditeur markdown": Tiptap, markdown as the single source of truth).
 *
 * The whole point is in the props: a MARKDOWN STRING in, a markdown string
 * out. The ProseMirror document lives for as long as the component and is
 * never stored, never sent and never compared against; `question_versions`
 * holds the same markdown it held before Tiptap existed, and the source pane
 * one toolbar button away edits that very string in a textarea.
 *
 * Two rules the question editor depends on:
 *
 *  - MOUNTING EMITS NOTHING. The host autosaves on any change, and an editor
 *    that announced a change simply for having opened would write a new draft
 *    version every time a teacher looked at a question. `onUpdate` is the only
 *    path to `onChange`, and it only fires on a real transaction.
 *  - `onChange` is called only when the serialized markdown DIFFERS from
 *    `value`, so the normalisations of the serializer (`_x_` becoming `*x*`,
 *    see roundtrip.test.ts) cost at most one save, on a real edit.
 *
 * `inline` is an interaction rule, not a schema (tiptap.ts says why): Enter
 * calls `onEnter` instead of splitting the paragraph, the toolbar folds into
 * the field and shows while it has the caret, and only the input rules that
 * cannot create a block are enabled.
 */

export type { RichTextProps };

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
type FormulaDialogComponent = typeof FormulaDialog;
let formulaDialog: FormulaDialogComponent | null = null;

/**
 * The editor's document as markdown.
 *
 * Trimmed at the end, and that is the whole of it: StarterKit's `TrailingNode`
 * keeps an empty paragraph after a document that ends in a block node — which
 * is what lets the caret land under a closing code fence — and the serializer
 * writes that paragraph out as two newlines. Emitting them would rewrite the
 * stored prompt of every question whose statement ends with a fence, the first
 * time a teacher opened it. Trailing blank lines carry no markdown meaning.
 */
function serialize(editor: Editor): string {
  return editor.getMarkdown().trimEnd();
}

/** One toolbar action; `actions` below filters out the ones a mode cannot serve. */
interface Action {
  key: string;
  icon: IconType;
  labelKey: "md.bold" | "md.italic" | "md.code" | "md.codeBlock" | "md.math" | "md.image" | "md.link";
  shortcut?: string;
}

/** The two node types a formula can be, as the schema names them. */
const MATH_TYPES = ["inlineMath", "blockMath"] as const;
const isMathNode = (name: string): boolean => (MATH_TYPES as readonly string[]).includes(name);

/** Whether the caret sits inside a fenced block, where every key means something else. */
const inCodeBlock = (state: EditorState): boolean =>
  state.selection.$from.parent.type.name === "codeBlock";

/** Where the formula dialog will write, and what it starts from. */
interface FormulaTarget extends Formula {
  /** Position of the math node being edited, or null for a new one. */
  node: number | null;
  /** Text range the formula replaces (the selection the Σ button was pressed on). */
  range: { from: number; to: number } | null;
  /** The node was made empty by `$$` a moment ago: cancelling removes it again. */
  created: boolean;
}

/** Every empty formula of the document, in document order. */
function emptyMath(editor: Editor): { pos: number; display: boolean }[] {
  const found: { pos: number; display: boolean }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!isMathNode(node.type.name)) return;
    if (String(node.attrs.latex ?? "").trim() !== "") return;
    found.push({ pos, display: node.type.name === "blockMath" });
  });
  return found;
}

export function RichText({
  value,
  onChange,
  inline = false,
  placeholder,
  "aria-label": ariaLabel,
  id,
  disabled = false,
  autoFocus = false,
  className = "",
  onEnter,
  onTab,
  uploadImage,
  toolbar = "always",
  sourceToggle = !inline,
  shortcuts = [],
}: RichTextProps) {
  const t = useT();
  const auto = useId();
  const fieldId = id ?? auto;
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  /** The markdown source pane, one toolbar button away from the rich one. */
  const [source, setSource] = useState(false);
  /** Whether the caret is in this field: what a `focus` toolbar follows. */
  const [focused, setFocused] = useState(false);
  /** The link address prompt (a formula opens the dialog instead). */
  const [asking, setAsking] = useState<null | { initial: string }>(null);
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
  const openFormulaRef = useRef(openFormula);
  openFormulaRef.current = openFormula;

  /*
   * The callbacks live in refs, and the editor is built once. Passing them to
   * `useEditor` directly would rebuild the whole ProseMirror view on every
   * render of the host — which loses the caret, the undo history and the
   * selection, several times per keystroke in a controlled form.
   */
  const onChangeRef = useRef(onChange);
  const onEnterRef = useRef(onEnter);
  const onTabRef = useRef(onTab);
  onChangeRef.current = onChange;
  onEnterRef.current = onEnter;
  onTabRef.current = onTab;

  /**
   * The markdown this component last agreed on with its host: the `value` it
   * was given, or the value it last emitted. It is what tells an edit made
   * INSIDE the editor from a `value` that changed outside it (a version
   * restored into the draft), which is the only case worth reloading for.
   */
  const settled = useRef(value);

  const upload = useRef<((files: File[], at?: number) => void) | null>(null);
  /** How many empty formulas the document held at the previous transaction. */
  const emptyCount = useRef(0);
  /**
   * The editor itself, for the handlers of `editorProps` — they are built
   * BEFORE it exists, and a pasted markdown fence has to go through the very
   * parser this editor was configured with.
   */
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    extensions: richTextExtensions({
      placeholder: placeholder ?? "",
      inline,
      // The picture's own toolbar (rotate, size, delete) lives in the node
      // view; `ImageToolsContext` below is how it reaches this field's
      // uploader, which is what a rotation writes its result through.
      imageNodeView: () => ReactNodeViewRenderer(ImageView),
      // The block's own language field, at its top-right corner.
      codeBlockNodeView: () => ReactNodeViewRenderer(CodeBlockView),
    }),
    content: value,
    contentType: "markdown",
    editable: !disabled,
    autofocus: autoFocus,
    // An inline field types marks and formulas; "- " at the head of a choice
    // stays the two characters the teacher typed.
    enableInputRules: inline ? [...INLINE_INPUT_RULES] : true,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    editorProps: {
      attributes: {
        id: fieldId,
        // `.md-body` is the student's stylesheet: what the teacher sees while
        // typing is what the question will look like, down to the code tint
        // and the KaTeX size. `.rt-surface` adds what ProseMirror needs.
        class: cx("rt-surface md-body focus:outline-none", inline && "md-sm"),
        role: "textbox",
        "aria-multiline": inline ? "false" : "true",
        ...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
      },
      handleKeyDown(view, event) {
        if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          // Inside a fenced block Tab is an INDENT — two spaces, or one level
          // back on Shift+Tab (`enableTabIndentation` in tiptap.ts). A teacher
          // writing C there is not asking for another choice.
          if (inCodeBlock(view.state)) return false;
          // The host answers first (a list of choices adds a row, or moves on)
          // and says whether it took the key. Unhandled, Tab leaves the field,
          // which is what a keyboard user expects of a rich text box.
          if (onTabRef.current?.(event.shiftKey)) {
            event.preventDefault();
            return true;
          }
          return false;
        }
        if (event.key === "Enter") {
          // A formula is an atom: there is nothing to type into it, so Enter
          // on a selected one opens the editor that CAN change it.
          const { selection } = view.state;
          if (selection instanceof NodeSelection && isMathNode(selection.node.type.name)) {
            event.preventDefault();
            openMath(selection.from, selection.node.attrs.latex, selection.node.type.name);
            return true;
          }
          /*
           * A FENCE opens, whichever of the three spellings the teacher used —
           * plain Enter included, because a line that is nothing but ``` or
           * ```c is not a choice waiting for the next one (tiptap.ts,
           * `openCodeFence`, which also closes a fence over what is above it).
           */
          if (inline && openCodeFence(view.state, view.dispatch, true)) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          /*
           * The same thing on Ctrl+Enter in a BLOCK field, and here rather
           * than in the extension's keymap because only this handler has the
           * EVENT: the question editor answers Ctrl+Enter on `window` with
           * "Try the question", and a teacher who just opened a fence must not
           * be carried off to another tab. Plain Enter there is the input
           * rule's, which needs no such care.
           */
          if (
            !inline &&
            (event.ctrlKey || event.metaKey) &&
            openCodeFence(view.state, view.dispatch, false)
          ) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          /*
           * INSIDE a block, Enter is a line of code and never the next choice.
           * Ctrl+Enter is the way OUT (a paragraph after the block), plain
           * Enter falls through to Tiptap — which is what keeps its own
           * three-empty-lines exit working — and Shift+Enter, which no keymap
           * binds inside code, is spelled out as the newline it looks like.
           */
          if (inline && inCodeBlock(view.state)) {
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault();
              event.stopPropagation();
              exitCode(view.state, view.dispatch);
              return true;
            }
            if (event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              newlineInCode(view.state, view.dispatch);
              return true;
            }
            return false;
          }
          /*
           * A SECOND LINE inside a choice. Plain Enter belongs to the host (it
           * moves to the next choice), so the modifier is what is left — and
           * both spellings answer, because a teacher who wants a line break
           * reaches for Shift+Enter and a developer for Ctrl+Enter.
           *
           * It splits the block rather than inserting a hard break: what a
           * choice is asked to hold is a snippet, and a fence cannot open
           * inside a paragraph. The new paragraph serializes as a blank line,
           * which is the markdown for exactly what is on screen.
           */
          if (inline && (event.ctrlKey || event.metaKey || event.shiftKey)) {
            event.preventDefault();
            // And STOPPED, not merely prevented: the question editor answers
            // Ctrl+Enter on `window` with "Try the question", and a teacher
            // who asked a choice for a second line must not be carried off to
            // another tab. The field publishes its own Ctrl+Enter in the
            // shortcut strip while it has the caret, so the strip says which
            // of the two is live.
            event.stopPropagation();
            splitBlock(view.state, view.dispatch);
            return true;
          }
          if (inline && onEnterRef.current) {
            event.preventDefault();
            onEnterRef.current();
            return true;
          }
        }
        return false;
      },
      handleClickOn(_view, _pos, node, nodePos, _event, direct) {
        if (!direct || !isMathNode(node.type.name)) return false;
        openMath(nodePos, node.attrs.latex, node.type.name);
        return true;
      },
      handlePaste(_view, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.some((f) => f.type.startsWith("image/"))) {
          event.preventDefault();
          upload.current?.(files);
          return true;
        }
        /*
         * MARKDOWN on the clipboard. A teacher copying a snippet out of a
         * slide deck, a README or another question pastes ```c and three lines
         * of C; ProseMirror sees plain text and lays down four paragraphs of
         * backticks, which is the bug this field was reported for.
         *
         * A FENCE is the trigger, and deliberately the only one: every other
         * markdown shape (a `-` list, a `#` heading) is also something a
         * teacher may want as the characters they pasted, and a paste that
         * silently restructures ordinary text is worse than one that does
         * nothing. Rich clipboard content is left to ProseMirror, which has
         * the HTML and knows more than we do; so is VS Code's, which the code
         * block extension handles with the language it came with.
         *
         * In an inline field the parser is the same, so a pasted list or
         * heading does land as one INSIDE the choice — the schema has always
         * been able to hold them (the head of tiptap.ts says why), and what a
         * teacher pasted deliberately is not what an input rule builds by
         * accident.
         */
        const clipboard = event.clipboardData;
        const text = clipboard?.getData("text/plain") ?? "";
        if (!text.includes("```")) return false;
        if (clipboard?.getData("text/html")) return false;
        if (clipboard?.getData("vscode-editor-data")) return false;
        const target = editorRef.current;
        if (!target) return false;
        event.preventDefault();
        target.commands.insertContent(text, { contentType: "markdown" });
        return true;
      },
      handleDrop(view, event) {
        const dropped = event instanceof DragEvent ? Array.from(event.dataTransfer?.files ?? []) : [];
        if (!dropped.some((f) => f.type.startsWith("image/"))) return false;
        event.preventDefault();
        /*
         * WHERE the picture was dropped, not where the caret happened to be.
         * The upload takes a second, the document may have moved on, and an
         * image landing in the middle of a paragraph the teacher was not even
         * looking at is what the first version did.
         */
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        upload.current?.(dropped, at?.pos ?? view.state.doc.content.size);
        return true;
      },
    },
    onUpdate({ editor: e }) {
      const markdown = serialize(e);
      if (markdown !== settled.current) {
        settled.current = markdown;
        onChangeRef.current(markdown);
      }
      /*
       * `$$` on an empty line makes an EMPTY formula (tiptap.ts), and an empty
       * formula renders as nothing at all: the dialog opens on it at once, so
       * the teacher types the latex where it can be seen. Compared against the
       * previous count and not against zero, or every later keystroke in a
       * prompt that happens to hold an empty formula would reopen it.
       */
      const empties = emptyMath(e);
      if (empties.length > emptyCount.current) {
        const target = empties[empties.length - 1]!;
        void openFormulaRef.current({
          latex: "",
          display: target.display,
          node: target.pos,
          range: null,
          created: true,
        });
      }
      emptyCount.current = empties.length;
    },
  });

  editorRef.current = editor;

  /** Opens the dialog on the math node at `pos`. */
  function openMath(pos: number, latex: unknown, typeName: string) {
    void openFormulaRef.current({
      latex: typeof latex === "string" ? latex : "",
      display: typeName === "blockMath",
      node: pos,
      range: null,
      created: false,
    });
  }

  /*
   * Which marks the caret sits in, for the pressed state of the toolbar.
   * `useEditorState` and not `shouldRerenderOnTransaction`: the second
   * re-renders this component on every keystroke, which in a long prompt is
   * the whole document reconciled per character.
   */
  const marks = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e === null
        ? {}
        : {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            code: e.isActive("code"),
            codeBlock: e.isActive("codeBlock"),
            math: e.isActive("inlineMath") || e.isActive("blockMath"),
            link: e.isActive("link"),
          },
  }) as Partial<Record<string, boolean>>;

  /*
   * `value` changed underneath us — a restored version, a reset draft — so the
   * document is rebuilt. An edit this component made itself never lands here:
   * `settled` already holds it, which is what keeps the caret where the
   * teacher left it while typing.
   */
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === settled.current) return;
    settled.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable === !disabled) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  const insertImages = useCallback(
    async (files: File[], at?: number) => {
      if (!uploadImage || !editor) return;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      setUploading((n) => n + images.length);
      try {
        // The drop position is remembered BEFORE the upload and the pictures
        // are laid down from it, in the order they were dropped.
        let pos = at;
        for (const image of images) {
          const src = await uploadImage(image);
          const alt = image.name.replace(/\.[^.]+$/, "");
          const node = { type: "image", attrs: { src, alt } };
          if (pos === undefined) editor.chain().focus().setImage({ src, alt }).run();
          else {
            const size = editor.state.doc.content.size;
            const where = Math.min(pos, size);
            editor.chain().focus().insertContentAt(where, node).run();
            pos = Math.min(editor.state.selection.to, editor.state.doc.content.size);
          }
        }
      } finally {
        setUploading((n) => Math.max(0, n - images.length));
      }
    },
    [uploadImage, editor],
  );
  upload.current = (files, at) => void insertImages(files, at);

  const showImage = uploadImage !== undefined;

  /** What the image node view reads; see `ImageView.tsx` for why it is a context. */
  const imageTools = useMemo(
    () => (uploadImage === undefined ? {} : { uploadImage }),
    [uploadImage],
  );

  /** Every action the toolbar can offer, before the mode filters it. */
  const ACTIONS: Action[] = [
    { key: "bold", icon: Bold, labelKey: "md.bold", shortcut: `${modKey()}+B` },
    { key: "italic", icon: Italic, labelKey: "md.italic", shortcut: `${modKey()}+I` },
    { key: "code", icon: Code, labelKey: "md.code" },
    { key: "codeBlock", icon: SquareCode, labelKey: "md.codeBlock" },
    { key: "math", icon: Sigma, labelKey: "md.math" },
    { key: "image", icon: ImageIcon, labelKey: "md.image" },
    { key: "link", icon: LinkIcon, labelKey: "md.link" },
  ];

  const actions = ACTIONS.filter(
    (a) =>
      (a.key !== "image" || showImage) &&
      // A one-paragraph field has nowhere to put a fenced block.
      (a.key !== "codeBlock" || !inline),
  );

  /*
   * What the app's shortcut strip shows while the caret is in this field: the
   * two formatting keys every rich field answers to, plus whatever the host
   * added (a list of choices answers Tab and Enter). Registered on focus, so
   * the strip follows the caret and not merely the screen.
   */
  /*
   * INSIDE A FENCED BLOCK the strip says something else entirely, and it has
   * to: Enter is a line of code and not the next choice, Tab is an indent and
   * not a new row, and a host's "Tab — Add a choice" would be a lie while the
   * caret is in there. The marks are dropped with them — a code block carries
   * none, so Ctrl+B does nothing in it.
   */
  const live: Shortcut[] = marks.codeBlock
    ? [
        ...(inline
          ? [
              { keys: "Enter", label: t("md.code.newLine") },
              { keys: `${modKey()}+Enter`, label: t("md.code.leave") },
            ]
          : []),
        { keys: "Tab", label: t("md.code.indent") },
      ]
    : [
        { keys: `${modKey()}+B`, label: t("md.bold") },
        { keys: `${modKey()}+I`, label: t("md.italic") },
        // Only an inline field: a block field splits its paragraph on plain
        // Enter, and teaching a second key for the same thing is noise.
        ...(inline ? [{ keys: `${modKey()}+Enter`, label: t("md.newLine") }] : []),
        ...shortcuts.map((s) => ({ keys: s.keys, label: s.label })),
      ];
  useShortcuts(live, focused && !disabled && !source);

  function run(key: string) {
    if (!editor) return;
    switch (key) {
      case "bold":
        editor.chain().focus().toggleBold().run();
        return;
      case "italic":
        editor.chain().focus().toggleItalic().run();
        return;
      case "code":
        editor.chain().focus().toggleCode().run();
        return;
      case "codeBlock":
        editor.chain().focus().toggleCodeBlock().run();
        return;
      case "image":
        file.current?.click();
        return;
      case "math": {
        const { selection } = editor.state;
        if (selection instanceof NodeSelection && isMathNode(selection.node.type.name)) {
          openMath(selection.from, selection.node.attrs.latex, selection.node.type.name);
          return;
        }
        // A selected run of text is what the formula starts from: select
        // `x^2`, press Σ, and it is already in the dialog.
        const text = editor.state.doc.textBetween(selection.from, selection.to);
        void openFormula({
          latex: text,
          display: false,
          node: null,
          range: selection.empty ? null : { from: selection.from, to: selection.to },
          created: false,
        });
        return;
      }
      case "link": {
        const href = editor.getAttributes("link").href;
        setAsking({ initial: typeof href === "string" ? href : "" });
        return;
      }
    }
  }

  /** Writes what the formula dialog collected, where it was opened from. */
  function applyFormula({ latex, display }: Formula) {
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

  /** Applies what the link prompt collected, then gives the caret back. */
  function applyAsked(text: string) {
    if (!editor || !asking) return;
    const chain = editor.chain().focus();
    if (text.trim() === "") chain.unsetLink().run();
    else chain.extendMarkRange("link").setLink({ href: text.trim() }).run();
    setAsking(null);
  }

  const sourceButton =
    sourceToggle && toolbar !== "never" ? (
      <IconButton
        size="sm"
        label={t("md.source")}
        active={source}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setSource((s) => !s)}
      >
        <FileCode2 />
      </IconButton>
    ) : null;

  /** The row of actions, drawn the same above a block field and inside an inline one. */
  const toolbarRow = (
    <div
      role="toolbar"
      aria-label={t("md.toolbar")}
      aria-controls={fieldId}
      className="flex flex-wrap items-center gap-0.5"
    >
      {actions.map((a) => (
        <IconButton
          key={a.key}
          size="sm"
          label={a.shortcut ? `${t(a.labelKey)} (${a.shortcut})` : t(a.labelKey)}
          // A code block carries no mark and holds no node: bold, a formula
          // and a picture cannot land in one. The fence toggle stays, since it
          // is the way back out of the block.
          disabled={
            disabled || editor === null || (marks.codeBlock === true && a.key !== "codeBlock")
          }
          {...(marks[a.key] === undefined ? {} : { active: marks[a.key] })}
          // The toolbar of an inline field lives INSIDE it: pressing a button
          // must format the selection, not take the caret out of the row.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(a.key)}
        >
          <a.icon />
        </IconButton>
      ))}
      {sourceButton}
      {uploading > 0 ? (
        <span role="status" className="ml-1 text-xs text-fg-muted">
          {t("md.uploading")}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {source ? (
        <SourcePane
          id={fieldId}
          value={value}
          onChange={onChange}
          label={ariaLabel ?? t("md.label")}
          placeholder={placeholder ?? t("md.placeholder.body")}
          disabled={disabled}
          rows={inline ? 3 : 8}
          {...(uploadImage === undefined ? {} : { uploadImage })}
          trailing={sourceButton}
        />
      ) : (
        <>
          {toolbar === "always" ? toolbarRow : null}

          {asking ? (
            <AskBar
              label={t("md.url")}
              initial={asking.initial}
              apply={t("common.save")}
              cancel={t("common.cancel")}
              onSubmit={applyAsked}
              onCancel={() => {
                setAsking(null);
                editor?.commands.focus();
              }}
            />
          ) : null}

          <div
            className={cx(
              inputClass,
              "w-full px-3 py-2",
              // `inputClass` styles the wrapper, and the focus ring has to
              // follow the caret into the contenteditable inside it.
              "focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20",
              disabled && "opacity-50",
            )}
          >
            {/*
             * The compact toolbar of an inline field, on the row above the
             * text and only while the field has the caret: a list of six
             * choices, each with its own permanent toolbar, is a wall of
             * icons. Nothing is reserved for it — the field grows when it
             * appears, and the rows below do not move otherwise.
             */}
            {toolbar === "focus" && focused ? (
              <div className="-mx-1 mb-1.5 border-b border-line px-1 pb-1.5">{toolbarRow}</div>
            ) : null}
            <ImageToolsContext.Provider value={imageTools}>
              <EditorContent
                editor={editor}
                // A block field needs room to be written in; an inline one is
                // a row of a list and grows with what it holds.
                className={inline ? "min-h-5" : "min-h-32"}
              />
            </ImageToolsContext.Provider>
          </div>
        </>
      )}

      {formula && Dialog ? (
        <Dialog
          initial={{ latex: formula.latex, display: formula.display }}
          allowDisplay={!inline}
          onInsert={applyFormula}
          onCancel={cancelFormula}
        />
      ) : null}

      {showImage && !source ? (
        <input
          ref={file}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          aria-label={t("md.image")}
          onChange={(e) => {
            void insertImages(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The one-field prompt the link button opens, in the flow of the card rather
 * than in a dialog: it holds a single value — an address, pasted in one
 * gesture — and a modal for one text input is the heaviest possible answer
 * (DESIGN.md, §4 of the UI skill). A FORMULA is the opposite case, which is
 * why it got a dialog of its own: it wants a palette, a preview and a
 * placement. Escape cancels and gives the caret back, Enter applies.
 */
function AskBar({
  label,
  initial,
  apply,
  cancel,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  apply: string;
  cancel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-field bg-surface-2 px-2 py-1.5">
      <label htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(text);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className={cx(inputClass, "h-7 min-w-0 flex-1 font-mono text-[13px]")}
      />
      <Button size="sm" variant="secondary" onClick={() => onSubmit(text)}>
        {apply}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {cancel}
      </Button>
    </div>
  );
}
