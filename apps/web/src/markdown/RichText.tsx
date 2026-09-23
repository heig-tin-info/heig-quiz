import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent, ReactNodeViewRenderer, useEditor, useEditorState } from "@tiptap/react";
import { Check, FileCode2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { RichTextProps } from "@quiz/core/client";

import { useT } from "../i18n";
import { Button, cx, IconButton, inputClass, Z } from "../ui";
import { BlankPopover } from "./BlankPopover";
import {
  clozeHolePossibilities,
  protectHolePipes,
  restoreHolePipes,
  type ClozeHolePossibility,
} from "./clozeHole";
import { CodeBlockView } from "./CodeBlockView";
import type { Formula, FormulaDialog } from "./FormulaDialog";
import { ImageToolsContext, ImageView } from "./ImageView";
import "./richtext.css";
import { handleRichTextKeyDown, isMathNode } from "./richTextKeys";
import {
  RichTextToolbar,
  runToolbarAction,
  toolbarActions,
  useRichTextMarks,
  useRichTextShortcuts,
} from "./RichTextToolbar";
import { SourcePane } from "./SourcePane";
import { INLINE_INPUT_RULES, richTextExtensions } from "./tiptap";

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
 * Trimmed, and that is the whole of it: StarterKit's `TrailingNode` keeps an
 * empty paragraph after a document that ends in a block node — which is what
 * lets the caret land under a closing code fence — and the serializer writes
 * that paragraph out as two newlines. Emitting them would rewrite the stored
 * prompt of every question whose statement ends with a fence, the first time a
 * teacher opened it. Blank lines at either end carry no markdown meaning.
 */
function serialize(editor: Editor): string {
  /*
   * `restoreHolePipes` LAST, after the table renderer has padded its columns:
   * a `|` inside a hole travels through the whole serialisation as U+E000 so
   * that the row it sits in is not split on it (clozeHole.ts says why, and
   * checks that the shipped table renderer escapes nothing of its own).
   */
  return restoreHolePipes(editor.getMarkdown().trim());
}

/** Where the formula dialog will write, and what it starts from. */
export interface FormulaTarget extends Formula {
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

/**
 * Where the card of a hole hangs: the chip's own rectangle, in viewport
 * coordinates. `coordsAtPos` is the fallback for the frame in which the chip
 * has just been created and has no element yet.
 */
function holeAnchor(editor: Editor, pos: number): { top: number; bottom: number; left: number } {
  const dom = editor.view.nodeDOM(pos);
  if (dom instanceof HTMLElement) {
    const r = dom.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left };
  }
  try {
    const c = editor.view.coordsAtPos(pos);
    return { top: c.top, bottom: c.bottom, left: c.left };
  } catch {
    return { top: 0, bottom: 0, left: 0 };
  }
}

/** What the read-only popover under a multi-answer chip shows. */
interface HolePreview {
  anchor: { top: number; bottom: number; left: number };
  items: ClozeHolePossibility[];
}

/** Every hole whose body is still empty, in document order. */
function emptyClozeHoles(editor: Editor): number[] {
  const found: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "clozeHole") return;
    if (node.attrs.body !== "") return;
    found.push(pos);
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
  holes = false,
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
  /**
   * The `{{…}}` hole being written, when there is one. A hole is an atom:
   * there is nothing to type into the chip, so it is edited in a card anchored
   * under it (`BlankPopover`), which asks for the SHAPE of the blank instead
   * of the grammar.
   */
  const [hole, setHole] = useState<null | {
    pos: number;
    body: string;
    created: boolean;
    anchor: { top: number; bottom: number; left: number };
  }>(null);
  /** The read-only list under a hovered multi-answer chip, and under a selected one. */
  const [hoverPreview, setHoverPreview] = useState<HolePreview | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<HolePreview | null>(null);
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
  /** The same, for the empty hole that typing `{{` leaves behind. */
  const emptyHoles = useRef(0);
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
      cloze: holes,
      // The picture's own toolbar (rotate, size, delete) lives in the node
      // view; `ImageToolsContext` below is how it reaches this field's
      // uploader, which is what a rotation writes its result through.
      imageNodeView: () => ReactNodeViewRenderer(ImageView),
      // The block's own language field, at its top-right corner.
      codeBlockNodeView: () => ReactNodeViewRenderer(CodeBlockView),
    }),
    content: holes ? protectHolePipes(value) : value,
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
        //
        // The MINIMUM HEIGHT belongs to the contenteditable, not to the box
        // around it: only the element ProseMirror owns turns a click into a
        // caret, so a field whose chrome was tall and whose surface was one
        // line high answered on its first line and nowhere else. A block
        // field needs room to be written in; an inline one is a row of a
        // list and grows with what it holds.
        class: cx(
          "rt-surface md-body focus:outline-none",
          inline ? "min-h-5 md-sm" : "min-h-32",
        ),
        role: "textbox",
        "aria-multiline": inline ? "false" : "true",
        ...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
      },
      handleKeyDown(view, event) {
        return handleRichTextKeyDown(view, event, {
          inline,
          onTab: onTabRef.current,
          onEnter: onEnterRef.current,
          openMath,
          openHole,
        });
      },
      handleClickOn(_view, _pos, node, nodePos, _event, direct) {
        if (!direct) return false;
        if (isMathNode(node.type.name)) {
          openMath(nodePos, node.attrs.latex, node.type.name);
          return true;
        }
        // The chip of a `{{…}}` hole. The escaped `\{{` is not editable —
        // it is two braces, and there is nothing in it to change.
        if (node.type.name === "clozeHole" && node.attrs.body !== null) {
          openHole(nodePos, String(node.attrs.body ?? ""), false);
          return true;
        }
        return false;
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
        target.commands.insertContent(holes ? protectHolePipes(text) : text, {
          contentType: "markdown",
        });
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

      /*
       * `{{` makes an EMPTY hole (markdown/clozeHole.ts), and an empty hole is
       * a chip with nothing in it: the body field opens on it at once, exactly
       * as `$$` opens the formula dialog, and for the same reason — there is
       * nothing to type into an atom. Compared against the previous count, or
       * every later keystroke would reopen the one already in the text.
       */
      const openHoles = emptyClozeHoles(e);
      if (openHoles.length > emptyHoles.current) {
        const at = openHoles[openHoles.length - 1]!;
        setHole({ pos: at, body: "", created: true, anchor: holeAnchor(e, at) });
      }
      emptyHoles.current = openHoles.length;
    },
  });

  editorRef.current = editor;

  /** Opens the blank card on the hole at `pos`. */
  function openHole(pos: number, body: string, created: boolean) {
    if (!editorRef.current) return;
    setHoverPreview(null);
    setHole({ pos, body, created, anchor: holeAnchor(editorRef.current, pos) });
  }

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

  const marks = useRichTextMarks(editor);

  /**
   * The chip the caret has SELECTED, as one string so the selector can be
   * compared by value: `useEditorState` runs on every transaction, and a fresh
   * object would re-render this component per keystroke.
   */
  const selectedHole = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (e === null) return null;
      const { selection } = e.state;
      if (!(selection instanceof NodeSelection)) return null;
      if (selection.node.type.name !== "clozeHole" || selection.node.attrs.body === null) return null;
      return `${selection.from}\u0000${String(selection.node.attrs.body ?? "")}`;
    },
  }) as string | null;

  useEffect(() => {
    if (!editor || !holes || selectedHole === null) {
      setSelectionPreview(null);
      return;
    }
    const cut = selectedHole.indexOf("\u0000");
    const pos = Number(selectedHole.slice(0, cut));
    const items = clozeHolePossibilities(selectedHole.slice(cut + 1));
    setSelectionPreview(items === null ? null : { anchor: holeAnchor(editor, pos), items });
  }, [editor, holes, selectedHole]);

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
    editor.commands.setContent(holes ? protectHolePipes(value) : value, {
      contentType: "markdown",
      emitUpdate: false,
    });
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

  useRichTextShortcuts({
    inCode: marks.codeBlock === true,
    inline,
    holes,
    shortcuts,
    enabled: focused && !disabled && !source,
  });

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

  /**
   * Writes the body the blank card collected. An EMPTY body removes the chip:
   * a hole with nothing in it is `cloze.empty_blank` and would only be an
   * error the teacher has to come back and delete.
   */
  function applyHole(body: string) {
    if (!editor || !hole) return;
    const node = editor.state.doc.nodeAt(hole.pos);
    const size = node?.type.name === "clozeHole" ? node.nodeSize : 1;
    const range = { from: hole.pos, to: hole.pos + size };
    const chain = editor.chain().focus();
    if (body.trim() === "") chain.deleteRange(range).run();
    else chain.insertContentAt(range, { type: "clozeHole", attrs: { body } }).run();
    setHole(null);
  }

  /** Leaving the card. The chip `{{` had just made goes with it. */
  function cancelHole() {
    if (editor && hole?.created) {
      const node = editor.state.doc.nodeAt(hole.pos);
      if (node?.type.name === "clozeHole") {
        editor.chain().focus().deleteRange({ from: hole.pos, to: hole.pos + node.nodeSize }).run();
      }
    }
    setHole(null);
    editor?.commands.focus();
  }

  /**
   * A click that lands on the field's CHROME — its padding, the strip beside
   * the compact toolbar — rather than on the contenteditable itself.
   *
   * The whole bordered box is the field, so it must take the caret: the
   * surface fills the box (`min-h-*` on `.rt-surface` above), and what is
   * left over is the padding, which ProseMirror never hears about. The caret
   * goes to the position nearest the pointer, and to the end of the text when
   * the layout cannot answer — a click under the last line is a click after
   * the last word. `preventDefault` keeps the field from blurring first.
   */
  function focusFromChrome(event: React.MouseEvent) {
    if (!editor || disabled) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    // The surface heard it already, and a control inside the box — a toolbar
    // button, the language field of a code block — owns its own click.
    if (target.closest(".rt-surface, button, input, select, textarea, a")) return;
    event.preventDefault();
    const box = (editor.view.dom as HTMLElement).getBoundingClientRect();
    const at = editor.view.posAtCoords({
      left: Math.min(Math.max(event.clientX, box.left + 1), box.right - 1),
      top: Math.min(Math.max(event.clientY, box.top + 1), box.bottom - 1),
    });
    editor.commands.focus(at === null ? "end" : at.pos);
  }

  /** The chip under the pointer, when it stands for more than one possibility. */
  function previewAt(target: EventTarget | null): HolePreview | null {
    const el = target instanceof Element ? target.closest('span[data-type="cloze-hole"]') : null;
    if (!(el instanceof HTMLElement) || el.getAttribute("data-literal") === "true") return null;
    const items = clozeHolePossibilities(el.getAttribute("data-body") ?? "");
    if (items === null) return null;
    const r = el.getBoundingClientRect();
    return { anchor: { top: r.top, bottom: r.bottom, left: r.left }, items };
  }

  /** Applies what the link prompt collected, then gives the caret back. */
  function applyAsked(text: string) {
    if (!editor || !asking) return;
    const chain = editor.chain().focus();
    if (text.trim() === "") chain.unsetLink().run();
    else chain.extendMarkRange("link").setLink({ href: text.trim() }).run();
    setAsking(null);
  }

  /** The card wins over the list: they would otherwise sit on top of each other. */
  const preview = hole !== null || source ? null : (hoverPreview ?? selectionPreview);

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
    <RichTextToolbar
      fieldId={fieldId}
      editor={editor}
      marks={marks}
      actions={toolbarActions({ showImage, holes, inline })}
      disabled={disabled}
      uploading={uploading}
      sourceButton={sourceButton}
      onRun={(key) =>
        runToolbarAction(editor, key, {
          pickImage: () => file.current?.click(),
          openMath,
          openFormula,
          askLink: (initial) => setAsking({ initial }),
        })
      }
    />
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
            onMouseDown={focusFromChrome}
            className={cx(
              inputClass,
              "w-full px-3 py-2",
              // `inputClass` styles the wrapper, and the focus ring has to
              // follow the caret into the contenteditable inside it.
              "focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20",
              disabled ? "opacity-50" : "cursor-text",
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
                // No height here: the room a field needs is on the surface
                // INSIDE this wrapper (`editorProps.attributes` above), which
                // is the only element a click can turn into a caret.
                // A chip shows the FIRST possibility and how many more there
                // are; the whole list is one hover away, read-only. Delegated
                // from the field, because the chips are ProseMirror's DOM and
                // a React node view per hole would rebuild on every keystroke.
                {...(holes
                  ? {
                      onMouseOver: (e: React.MouseEvent) => setHoverPreview(previewAt(e.target)),
                      onMouseOut: () => setHoverPreview(null),
                    }
                  : {})}
              />
            </ImageToolsContext.Provider>
          </div>
        </>
      )}

      {hole ? (
        <BlankPopover
          key={`hole-${hole.pos}`}
          anchor={hole.anchor}
          body={hole.body}
          onApply={applyHole}
          onCancel={cancelHole}
        />
      ) : null}

      {preview
        ? createPortal(
            <div
              aria-hidden
              className={cx(
                "pointer-events-none fixed max-w-64 rounded-menu border border-line bg-surface px-2.5 py-1.5 shadow-popover",
                Z.popover,
              )}
              style={{ top: preview.anchor.bottom + 6, left: preview.anchor.left }}
            >
              <ul className="flex flex-col gap-0.5 text-[13px]">
                {preview.items.map((item, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    {item.correct === null ? null : (
                      <Check
                        className={cx("size-3.5 shrink-0 text-success", item.correct ? "" : "opacity-0")}
                      />
                    )}
                    <span className={cx("font-mono", item.correct === false ? "text-fg-muted" : "text-fg")}>
                      {item.label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>,
            document.body,
          )
        : null}

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
