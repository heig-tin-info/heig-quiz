import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  Bold,
  Code,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  Sigma,
  SquareCode,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { RichTextProps } from "@quiz/core/client";

import { useT } from "../i18n";
import { Button, cx, IconButton, inputClass, type IconType } from "../ui";
import "./richtext.css";
import { INLINE_INPUT_RULES, richTextExtensions } from "./tiptap";

/*
 * The WYSIWYG half of the markdown field (docs/spec/05 §5.10, decision
 * "Éditeur markdown": Tiptap, markdown as the single source of truth).
 *
 * The whole point is in the props: a MARKDOWN STRING in, a markdown string
 * out. The ProseMirror document lives for as long as the component and is
 * never stored, never sent and never compared against; `question_versions`
 * holds the same markdown it held before Tiptap existed, and the "Source"
 * pane next door edits that very string with a textarea.
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
 * calls `onEnter` instead of splitting the paragraph, the toolbar is usually
 * hidden, and only the input rules that cannot create a block are enabled.
 */

export type { RichTextProps };

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
  toolbar = true,
}: RichTextProps) {
  const t = useT();
  const auto = useId();
  const fieldId = id ?? auto;
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  /** The one inline prompt the toolbar opens: a link address, or a formula. */
  const [asking, setAsking] = useState<null | { kind: "link" | "math"; initial: string }>(null);

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

  const upload = useRef<((files: File[]) => void) | null>(null);

  const editor = useEditor({
    extensions: richTextExtensions({ placeholder: placeholder ?? "" }),
    content: value,
    contentType: "markdown",
    editable: !disabled,
    autofocus: autoFocus,
    // An inline field types marks and formulas; "- " at the head of a choice
    // stays the two characters the teacher typed.
    enableInputRules: inline ? [...INLINE_INPUT_RULES] : true,
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
      handleKeyDown(_view, event) {
        if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          // The host answers first (a list of choices adds a row, or moves on)
          // and says whether it took the key. Unhandled, Tab leaves the field,
          // which is what a keyboard user expects of a rich text box.
          if (onTabRef.current?.(event.shiftKey)) {
            event.preventDefault();
            return true;
          }
          return false;
        }
        if (event.key === "Enter" && inline && onEnterRef.current) {
          event.preventDefault();
          onEnterRef.current();
          return true;
        }
        return false;
      },
      handlePaste(_view, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.some((f) => f.type.startsWith("image/"))) return false;
        event.preventDefault();
        upload.current?.(files);
        return true;
      },
      handleDrop(_view, event) {
        const dropped = event instanceof DragEvent ? Array.from(event.dataTransfer?.files ?? []) : [];
        if (!dropped.some((f) => f.type.startsWith("image/"))) return false;
        event.preventDefault();
        upload.current?.(dropped);
        return true;
      },
    },
    onUpdate({ editor: e }) {
      const markdown = serialize(e);
      if (markdown === settled.current) return;
      settled.current = markdown;
      onChangeRef.current(markdown);
    },
  });

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
    async (files: File[]) => {
      if (!uploadImage || !editor) return;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      setUploading((n) => n + images.length);
      try {
        for (const image of images) {
          const src = await uploadImage(image);
          const alt = image.name.replace(/\.[^.]+$/, "");
          editor.chain().focus().setImage({ src, alt }).run();
        }
      } finally {
        setUploading((n) => Math.max(0, n - images.length));
      }
    },
    [uploadImage, editor],
  );
  upload.current = (files) => void insertImages(files);

  const showImage = uploadImage !== undefined;

  /** Every action the toolbar can offer, before the mode filters it. */
  const ACTIONS: Action[] = [
    { key: "bold", icon: Bold, labelKey: "md.bold", shortcut: "Ctrl+B" },
    { key: "italic", icon: Italic, labelKey: "md.italic", shortcut: "Ctrl+I" },
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
        const node = editor.state.selection.$from.nodeAfter;
        const latex = typeof node?.attrs.latex === "string" ? node.attrs.latex : "";
        const selected = editor.state.doc.textBetween(
          editor.state.selection.from,
          editor.state.selection.to,
        );
        setAsking({ kind: "math", initial: latex || selected });
        return;
      }
      case "link": {
        const href = editor.getAttributes("link").href;
        setAsking({ kind: "link", initial: typeof href === "string" ? href : "" });
        return;
      }
    }
  }

  /** Applies what the inline prompt collected, then gives the caret back. */
  function applyAsked(text: string) {
    if (!editor || !asking) return;
    const chain = editor.chain().focus();
    if (asking.kind === "link") {
      if (text.trim() === "") chain.unsetLink().run();
      else chain.extendMarkRange("link").setLink({ href: text.trim() }).run();
    } else if (text.trim() !== "") {
      // Replacing the selection is what makes the button work on a formula
      // that is already there: it was put in the prompt, it comes back edited.
      chain.insertContent({ type: "inlineMath", attrs: { latex: text.trim() } }).run();
    }
    setAsking(null);
  }

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {toolbar && actions.length > 0 ? (
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
              disabled={disabled || editor === null}
              {...(marks[a.key] === undefined ? {} : { active: marks[a.key] })}
              onClick={() => run(a.key)}
            >
              <a.icon />
            </IconButton>
          ))}
          {uploading > 0 ? (
            <span role="status" className="ml-1 text-xs text-fg-muted">
              {t("md.uploading")}
            </span>
          ) : null}
        </div>
      ) : null}

      {asking ? (
        <AskBar
          label={asking.kind === "link" ? t("md.url") : t("md.latex")}
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

      <EditorContent
        editor={editor}
        className={cx(
          inputClass,
          "w-full px-3 py-2",
          // A block field needs room to be written in; an inline one is a row
          // of a list and grows with what it holds.
          inline ? "min-h-8.5" : "min-h-32",
          // `inputClass` styles the wrapper, and the focus ring has to follow
          // the caret into the contenteditable inside it.
          "focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20",
          disabled && "opacity-50",
        )}
      />

      {showImage ? (
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
 * The one-field prompt the link and the formula buttons open, in the flow of
 * the card rather than in a dialog: it holds a single value, and a modal for
 * one text input is the heaviest possible answer (DESIGN.md, §4 of the UI
 * skill). Escape cancels and gives the caret back, Enter applies.
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
