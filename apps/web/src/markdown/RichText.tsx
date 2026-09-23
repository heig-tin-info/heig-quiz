import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { FileCode2 } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";

import type { RichTextProps } from "@quiz/core/client";

import { useT } from "../i18n";
import { cx, IconButton, inputClass } from "../ui";
import { BlankPopover } from "./BlankPopover";
import { ImageToolsContext } from "./ImageView";
import "./richtext.css";
import { HolePreviewPopover, LinkPrompt } from "./RichTextPopovers";
import {
  RichTextToolbar,
  runToolbarAction,
  toolbarActions,
  useRichTextMarks,
  useRichTextShortcuts,
} from "./RichTextToolbar";
import { SourcePane } from "./SourcePane";
import { previewAt, useClozeHole, useHoleSelectionPreview } from "./useClozeHole";
import { useFormulaTarget } from "./useFormulaTarget";
import { useRichTextEditor, useRichTextSync, type ImageUploader } from "./useRichTextEditor";

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
  /**
   * The editor itself, for the handlers of `editorProps` — they are built
   * BEFORE it exists, and a pasted markdown fence has to go through the very
   * parser this editor was configured with.
   */
  const editorRef = useRef<Editor | null>(null);
  const { formula, Dialog, openFormula, openMath, applyFormula, cancelFormula } =
    useFormulaTarget(editorRef);
  const { hole, openHole, openCreatedHole, applyHole, cancelHole, hoverPreview, setHoverPreview } =
    useClozeHole(editorRef);

  const upload = useRef<ImageUploader | null>(null);
  const { editor, settled } = useRichTextEditor({
    value,
    onChange,
    onEnter,
    onTab,
    inline,
    holes,
    placeholder,
    ariaLabel,
    fieldId,
    disabled,
    autoFocus,
    editorRef,
    upload,
    onFocusChange: setFocused,
    openMath,
    openHole,
    openFormula,
    openCreatedHole,
  });

  const marks = useRichTextMarks(editor);

  const selectionPreview = useHoleSelectionPreview(editor, holes);

  useRichTextSync(editor, { value, holes, disabled, settled });

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
            <LinkPrompt editor={editor} initial={asking.initial} onClose={() => setAsking(null)} />
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

      {preview ? <HolePreviewPopover preview={preview} /> : null}

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
