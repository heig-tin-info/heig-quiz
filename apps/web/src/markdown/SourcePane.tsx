import { Bold, Code, Image as ImageIcon, Italic, Link, Sigma } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { useT, type TFunction } from "../i18n";
import { cx, IconButton, inputClass, type IconType } from "../ui";
import { indent, insertBlock, replace, wrap, type Selection } from "./insert";

/*
 * The MARKDOWN SOURCE half of the rich text field: a textarea over the very
 * string that is stored, with a caret-level toolbar.
 *
 * It is exactly what `MarkdownField` shipped before Tiptap landed — the same
 * `insert.ts` edits, the same Ctrl+B / Ctrl+I, the same Tab that indents
 * instead of leaving the field. What changed is WHO owns it: the pane now
 * belongs to `RichText`, which swaps between the two surfaces from one toggle
 * in its toolbar, so every rich field in the app (a statement, an
 * explanation, a choice that asks for it) gets the source view for free and
 * `MarkdownField` is left with the label and the hint line.
 */

interface ToolbarAction {
  key: string;
  icon: IconType;
  /** i18n key of the accessible name. */
  labelKey: "md.bold" | "md.italic" | "md.code" | "md.math" | "md.image" | "md.link";
  /** Keyboard hint appended to the tooltip, if the action has one. */
  shortcut?: string;
  apply?: (sel: Selection, t: TFunction) => Selection;
}

/*
 * Six actions, in the order a prompt gets written: emphasis, then code, then
 * the two things a physics or an electronics prompt actually needs (a
 * formula and a figure), then a link. A seventh would start a second row on a
 * phone, and a toolbar that wraps is a toolbar nobody scans.
 *
 * These belong to the SOURCE pane: they edit characters around a caret. The
 * rich pane has its own, which edits the document.
 */
const ACTIONS: ToolbarAction[] = [
  { key: "bold", icon: Bold, labelKey: "md.bold", shortcut: "Ctrl+B",
    apply: (s, t) => wrap(s, "**", "**", t("md.placeholder.bold")) },
  { key: "italic", icon: Italic, labelKey: "md.italic", shortcut: "Ctrl+I",
    apply: (s, t) => wrap(s, "*", "*", t("md.placeholder.italic")) },
  { key: "code", icon: Code, labelKey: "md.code",
    apply: (s, t) =>
      s.value.slice(s.start, s.end).includes("\n")
        ? insertBlock(s, "```c\n" + s.value.slice(s.start, s.end) + "\n```", s.value.slice(s.start, s.end))
        : wrap(s, "`", "`", t("md.placeholder.code")) },
  { key: "math", icon: Sigma, labelKey: "md.math",
    apply: (s, t) => wrap(s, "$", "$", t("md.placeholder.math")) },
  { key: "image", icon: ImageIcon, labelKey: "md.image" },
  { key: "link", icon: Link, labelKey: "md.link",
    apply: (s, t) => {
      const selected = s.value.slice(s.start, s.end);
      const text = selected || t("md.placeholder.link");
      const next = replace(s, `[${text}](https://)`);
      // Caret inside the parentheses: the text is the part already written,
      // the URL is the part that is not.
      const at = next.start - 1;
      return { value: next.value, start: at, end: at };
    } },
];

export function SourcePane({
  value,
  onChange,
  id,
  label,
  placeholder,
  disabled = false,
  rows = 8,
  uploadImage,
  trailing,
}: {
  value: string;
  onChange: (value: string) => void;
  id: string;
  /** Accessible name of the textarea. */
  label: string;
  placeholder: string;
  disabled?: boolean;
  rows?: number;
  /** Uploads an image and returns `asset:<id>`; the affordances hide without it. */
  uploadImage?: (file: File) => Promise<string>;
  /** The pane toggle of `RichText`, at the end of the toolbar. */
  trailing?: ReactNode;
}) {
  const t = useT();
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  /** Applies a pure edit to the textarea and puts the caret back where it belongs. */
  const edit = useCallback(
    (fn: (sel: Selection) => Selection) => {
      const el = area.current;
      const sel: Selection = el
        ? { value, start: el.selectionStart, end: el.selectionEnd }
        : { value, start: value.length, end: value.length };
      const next = fn(sel);
      onChange(next.value);
      // After React has written the new value: setting it first would move
      // the caret to the end of the field on every insertion.
      requestAnimationFrame(() => {
        const node = area.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(next.start, next.end);
      });
    },
    [value, onChange],
  );

  const upload = useCallback(
    async (files: File[]) => {
      if (!uploadImage) return;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      setUploading((n) => n + images.length);
      try {
        for (const image of images) {
          const ref = await uploadImage(image);
          const alt = image.name.replace(/\.[^.]+$/, "");
          edit((sel) => insertBlock(sel, `![${alt}](${ref})`));
        }
      } finally {
        setUploading((n) => Math.max(0, n - images.length));
      }
    },
    [uploadImage, edit],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      edit((sel) => indent(sel, e.shiftKey));
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key !== "b" && key !== "i") return;
    e.preventDefault();
    const action = ACTIONS.find((a) => a.key === (key === "b" ? "bold" : "italic"))!;
    edit((sel) => action.apply!(sel, t));
  };

  const showImage = uploadImage !== undefined;
  const actions = ACTIONS.filter((a) => a.key !== "image" || showImage);

  return (
    <>
      <div
        role="toolbar"
        aria-label={t("md.toolbar")}
        aria-controls={id}
        className="flex flex-wrap items-center gap-0.5"
      >
        {actions.map((a) => (
          <IconButton
            key={a.key}
            size="sm"
            label={a.shortcut ? `${t(a.labelKey)} (${a.shortcut})` : t(a.labelKey)}
            disabled={disabled}
            onClick={() => (a.apply ? edit((sel) => a.apply!(sel, t)) : file.current?.click())}
          >
            <a.icon />
          </IconButton>
        ))}
        {trailing}
        {uploading > 0 ? (
          <span role="status" className="ml-1 text-xs text-fg-muted">
            {t("md.uploading")}
          </span>
        ) : null}
      </div>

      <textarea
        ref={area}
        id={id}
        value={value}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          if (!showImage) return;
          const files = Array.from(e.clipboardData.files);
          if (files.some((f) => f.type.startsWith("image/"))) {
            e.preventDefault();
            void upload(files);
          }
        }}
        onDragOver={(e) => {
          if (!showImage) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (!showImage) return;
          const files = Array.from(e.dataTransfer.files);
          if (files.some((f) => f.type.startsWith("image/"))) {
            e.preventDefault();
            void upload(files);
          }
        }}
        className={cx(
          inputClass,
          "w-full resize-y py-2 font-mono text-[13px] leading-relaxed",
          dragging && "border-accent",
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
            void upload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      ) : null}
    </>
  );
}
