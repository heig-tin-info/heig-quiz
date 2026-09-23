import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { useId, useMemo, useRef, useState } from "react";

import type { RichTextProps } from "@quiz/core/client";

import { useT } from "../i18n";
import { cx, inputClass } from "../ui";
import { ImageToolsContext } from "./ImageView";
import "./richtext.css";
import { LinkPrompt, RichTextOverlays } from "./RichTextPopovers";
import { RichTextSourcePane, SourceToggle } from "./RichTextSource";
import {
  RichTextToolbar,
  runToolbarAction,
  toolbarActions,
  useRichTextMarks,
  useRichTextShortcuts,
} from "./RichTextToolbar";
import { useClozeHole, useHoleSelectionPreview } from "./useClozeHole";
import { useFormulaTarget } from "./useFormulaTarget";
import { useImageUpload } from "./useImageUpload";
import {
  focusFromChrome,
  useRichTextEditor,
  useRichTextSync,
  type ImageUploader,
} from "./useRichTextEditor";

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
  /** The markdown source pane, one toolbar button away from the rich one. */
  const [source, setSource] = useState(false);
  /** Whether the caret is in this field: what a `focus` toolbar follows. */
  const [focused, setFocused] = useState(false);
  /** The link address prompt (a formula opens the dialog instead). */
  const [asking, setAsking] = useState<null | { initial: string }>(null);
  /** The editor, for what is built BEFORE it exists: `editorProps`, and the openers below. */
  const editorRef = useRef<Editor | null>(null);
  const { formula, Dialog, openFormula, openMath, applyFormula, cancelFormula } =
    useFormulaTarget(editorRef);
  const { hole, openHole, openCreatedHole, applyHole, cancelHole, hoverPreview, hoverHandlers } =
    useClozeHole(editorRef, holes);

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

  const { uploading, insertImages } = useImageUpload(editor, uploadImage);
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
    focused,
    disabled,
    source,
  });

  const sourceButton =
    sourceToggle && toolbar !== "never" ? (
      <SourceToggle source={source} disabled={disabled} onToggle={() => setSource((s) => !s)} />
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
        <RichTextSourcePane
          fieldId={fieldId}
          value={value}
          onChange={onChange}
          ariaLabel={ariaLabel}
          placeholder={placeholder}
          disabled={disabled}
          inline={inline}
          uploadImage={uploadImage}
          trailing={sourceButton}
        />
      ) : (
        <>
          {toolbar === "always" ? toolbarRow : null}

          {asking ? (
            <LinkPrompt editor={editor} initial={asking.initial} onClose={() => setAsking(null)} />
          ) : null}

          <div
            onMouseDown={(e) => focusFromChrome(e, editor, disabled)}
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
              {/*
               * No height here: the room a field needs is on the surface
               * INSIDE this wrapper (`editorProps.attributes`), which is the
               * only element a click can turn into a caret. The hover of the
               * hole chips is delegated from here (useClozeHole.ts).
               */}
              <EditorContent editor={editor} {...hoverHandlers} />
            </ImageToolsContext.Provider>
          </div>
        </>
      )}

      <RichTextOverlays
        hole={hole}
        onApplyHole={applyHole}
        onCancelHole={cancelHole}
        hoverPreview={hoverPreview}
        selectionPreview={selectionPreview}
        source={source}
        formula={formula}
        Dialog={Dialog}
        allowDisplay={!inline}
        onInsertFormula={applyFormula}
        onCancelFormula={cancelFormula}
      />

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
