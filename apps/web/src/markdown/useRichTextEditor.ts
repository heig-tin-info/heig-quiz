import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { useEffect, useRef, type RefObject } from "react";

import type { RichTextProps } from "@quiz/core/client";

import { cx } from "../ui";
import { protectHolePipes, restoreHolePipes } from "./clozeHole";
import { CodeBlockView } from "./CodeBlockView";
import { ImageView } from "./ImageView";
import { handleRichTextKeyDown, isMathNode, type RichTextKeyDeps } from "./richTextKeys";
import { INLINE_INPUT_RULES, richTextExtensions } from "./tiptap";
import { emptyClozeHoles } from "./useClozeHole";
import { emptyMath, type FormulaTarget } from "./useFormulaTarget";

/*
 * The construction of the rich text editor: its extensions, its surface, the
 * handlers of `editorProps` and the `onUpdate` bookkeeping that turns every
 * real transaction into at most one `onChange` (RichText.tsx says why
 * mounting emits nothing).
 */

/** Uploads pictures and lays them down, at `at` or at the caret. */
export type ImageUploader = (files: File[], at?: number) => void;

export interface RichTextEditorOptions {
  value: string;
  onChange: RichTextProps["onChange"];
  onEnter: RichTextProps["onEnter"];
  onTab: RichTextProps["onTab"];
  inline: boolean;
  holes: boolean;
  placeholder: string | undefined;
  ariaLabel: string | undefined;
  fieldId: string;
  disabled: boolean;
  autoFocus: boolean;
  /** Set to the editor on every render, for the handlers built before it. */
  editorRef: RefObject<Editor | null>;
  /** The field's uploader, assigned once the editor exists. */
  upload: RefObject<ImageUploader | null>;
  onFocusChange: (focused: boolean) => void;
  openMath: RichTextKeyDeps["openMath"];
  openHole: RichTextKeyDeps["openHole"];
  openFormula: (target: FormulaTarget) => Promise<void>;
  openCreatedHole: (editor: Editor, pos: number) => void;
}

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

const hasImage = (files: File[]): boolean => files.some((f) => f.type.startsWith("image/"));

/**
 * `editorProps.handlePaste`: pictures go to the uploader, and a markdown
 * FENCE goes through the markdown parser.
 */
function pasteIntoRichText(
  event: ClipboardEvent,
  editor: Editor | null,
  holes: boolean,
  upload: ImageUploader | null,
): boolean {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (hasImage(files)) {
    event.preventDefault();
    upload?.(files);
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
  if (!editor) return false;
  event.preventDefault();
  editor.commands.insertContent(holes ? protectHolePipes(text) : text, {
    contentType: "markdown",
  });
  return true;
}

/** `editorProps.handleDrop`: dropped pictures go to the uploader, where they fell. */
function dropIntoRichText(view: EditorView, event: DragEvent, upload: ImageUploader | null): boolean {
  const dropped = event instanceof DragEvent ? Array.from(event.dataTransfer?.files ?? []) : [];
  if (!hasImage(dropped)) return false;
  event.preventDefault();
  /*
   * WHERE the picture was dropped, not where the caret happened to be.
   * The upload takes a second, the document may have moved on, and an
   * image landing in the middle of a paragraph the teacher was not even
   * looking at is what the first version did.
   */
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  upload?.(dropped, at?.pos ?? view.state.doc.content.size);
  return true;
}

/**
 * The Tiptap editor of a rich text field, built once for the life of the
 * component, and `settled`: the markdown it last agreed on with its host.
 */
export function useRichTextEditor(o: RichTextEditorOptions) {
  /*
   * The callbacks live in refs, and the editor is built once. Passing them to
   * `useEditor` directly would rebuild the whole ProseMirror view on every
   * render of the host — which loses the caret, the undo history and the
   * selection, several times per keystroke in a controlled form.
   */
  const onChangeRef = useRef(o.onChange);
  const onEnterRef = useRef(o.onEnter);
  const onTabRef = useRef(o.onTab);
  onChangeRef.current = o.onChange;
  onEnterRef.current = o.onEnter;
  onTabRef.current = o.onTab;

  /**
   * The markdown this component last agreed on with its host: the `value` it
   * was given, or the value it last emitted. It is what tells an edit made
   * INSIDE the editor from a `value` that changed outside it (a version
   * restored into the draft), which is the only case worth reloading for.
   */
  const settled = useRef(o.value);

  /** How many empty formulas the document held at the previous transaction. */
  const emptyCount = useRef(0);
  /** The same, for the empty hole that typing `{{` leaves behind. */
  const emptyHoles = useRef(0);

  /** Opens what a `$$` or a `{{` has just left empty (see `onUpdate`). */
  function openNewlyEmpty(e: Editor) {
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
      void o.openFormula({
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
      o.openCreatedHole(e, at);
    }
    emptyHoles.current = openHoles.length;
  }

  const editor = useEditor({
    extensions: richTextExtensions({
      placeholder: o.placeholder ?? "",
      inline: o.inline,
      cloze: o.holes,
      // The picture's own toolbar (rotate, size, delete) lives in the node
      // view; `ImageToolsContext` in RichText.tsx is how it reaches this
      // field's uploader, which is what a rotation writes its result through.
      imageNodeView: () => ReactNodeViewRenderer(ImageView),
      // The block's own language field, at its top-right corner.
      codeBlockNodeView: () => ReactNodeViewRenderer(CodeBlockView),
    }),
    content: o.holes ? protectHolePipes(o.value) : o.value,
    contentType: "markdown",
    editable: !o.disabled,
    autofocus: o.autoFocus,
    // An inline field types marks and formulas; "- " at the head of a choice
    // stays the two characters the teacher typed.
    enableInputRules: o.inline ? [...INLINE_INPUT_RULES] : true,
    onFocus: () => o.onFocusChange(true),
    onBlur: () => o.onFocusChange(false),
    editorProps: {
      attributes: {
        id: o.fieldId,
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
          o.inline ? "min-h-5 md-sm" : "min-h-32",
        ),
        role: "textbox",
        "aria-multiline": o.inline ? "false" : "true",
        ...(o.ariaLabel === undefined ? {} : { "aria-label": o.ariaLabel }),
      },
      handleKeyDown(view, event) {
        return handleRichTextKeyDown(view, event, {
          inline: o.inline,
          onTab: onTabRef.current,
          onEnter: onEnterRef.current,
          openMath: o.openMath,
          openHole: o.openHole,
        });
      },
      handleClickOn(_view, _pos, node, nodePos, _event, direct) {
        if (!direct) return false;
        if (isMathNode(node.type.name)) {
          o.openMath(nodePos, node.attrs.latex, node.type.name);
          return true;
        }
        // The chip of a `{{…}}` hole. The escaped `\{{` is not editable —
        // it is two braces, and there is nothing in it to change.
        if (node.type.name === "clozeHole" && node.attrs.body !== null) {
          o.openHole(nodePos, String(node.attrs.body ?? ""), false);
          return true;
        }
        return false;
      },
      handlePaste(_view, event) {
        return pasteIntoRichText(event, o.editorRef.current, o.holes, o.upload.current);
      },
      handleDrop(view, event) {
        return dropIntoRichText(view, event, o.upload.current);
      },
    },
    onUpdate({ editor: e }) {
      const markdown = serialize(e);
      if (markdown !== settled.current) {
        settled.current = markdown;
        onChangeRef.current(markdown);
      }
      openNewlyEmpty(e);
    },
  });

  o.editorRef.current = editor;

  return { editor, settled };
}

/**
 * Keeps a built editor in step with its props: a `value` changed outside it,
 * and `disabled`. Separate from `useRichTextEditor` so that RichText runs
 * these effects where it always has, after the selectors of the editor state.
 */
export function useRichTextSync(
  editor: Editor | null,
  { value, holes, disabled, settled }: {
    value: string;
    holes: boolean;
    disabled: boolean;
    settled: RefObject<string>;
  },
): void {
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
}
