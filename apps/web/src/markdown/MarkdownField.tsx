import { Bold, Code, Image as ImageIcon, Italic, Link, Sigma } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";

import { useT, type TFunction } from "../i18n";
import { cx, IconButton, inputClass, Segmented, type IconType } from "../ui";
import { assetMarkdown } from "./render";
import { indent, insertBlock, replace, wrap, type Selection } from "./insert";
import { MarkdownView } from "./MarkdownView";

/*
 * The markdown field a teacher writes a prompt in (PLAN-MVP §6.7, decision
 * D11). The MVP deliberately ships a textarea and not a WYSIWYG: markdown is
 * the single source of truth either way (docs/05 §5.10), so the "Write" pane
 * can be swapped for a Tiptap surface later without touching the stored value
 * or migrating a single row. The segmented control already names the three
 * panes that split will need, which is why "Source" exists today even though
 * it shows the same textarea: the day Tiptap lands, "Write" changes and
 * "Source" does not.
 *
 * Everything the profane path needs is here and costs hours, not days: six
 * toolbar buttons that insert markdown at the caret, Ctrl+B / Ctrl+I, Tab as
 * two spaces, and an image pasted or dropped into the field going through
 * `onUploadImage` and coming back as `![](asset:<id>)`.
 */

export type MarkdownMode = "write" | "preview" | "source";

export interface MarkdownFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the textarea; also the visible label when `label` is set. */
  label?: string;
  placeholder?: string;
  /** Rows of the textarea at rest; it grows with the content. */
  rows?: number;
  disabled?: boolean;
  id?: string;
  /**
   * Uploads a pasted or dropped image and returns its asset id. Without it
   * the image affordances are hidden rather than shown broken: a button that
   * cannot work is worse than one that is not there.
   */
  onUploadImage?: (file: File) => Promise<{ id: string }>;
  /** Starting pane; the field owns the choice afterwards. */
  defaultMode?: MarkdownMode;
  className?: string;
}

interface ToolbarAction {
  key: string;
  icon: IconType;
  /** i18n key of the accessible name. */
  labelKey:
    | "md.bold"
    | "md.italic"
    | "md.code"
    | "md.math"
    | "md.image"
    | "md.link";
  /** Keyboard hint appended to the tooltip, if the action has one. */
  shortcut?: string;
  apply?: (sel: Selection, t: TFunction) => Selection;
}

/*
 * Six actions, in the order a prompt gets written: emphasis, then code, then
 * the two things a physics or an electronics prompt actually needs (a
 * formula and a figure), then a link. A seventh would start a second row on a
 * phone, and a toolbar that wraps is a toolbar nobody scans.
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

export function MarkdownField({
  value,
  onChange,
  label,
  placeholder,
  rows = 8,
  disabled,
  id,
  onUploadImage,
  defaultMode = "write",
  className = "",
}: MarkdownFieldProps) {
  const t = useT();
  const auto = useId();
  const fieldId = id ?? auto;
  const [mode, setMode] = useState<MarkdownMode>(defaultMode);
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
      if (!onUploadImage) return;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      setUploading((n) => n + images.length);
      try {
        for (const image of images) {
          const { id: assetId } = await onUploadImage(image);
          const alt = image.name.replace(/\.[^.]+$/, "");
          edit((sel) => insertBlock(sel, assetMarkdown(assetId, alt)));
        }
      } finally {
        setUploading((n) => Math.max(0, n - images.length));
      }
    },
    [onUploadImage, edit],
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

  const showImage = onUploadImage != null;
  const actions = ACTIONS.filter((a) => a.key !== "image" || showImage);
  const editing = mode !== "preview";

  const textarea = (
    <textarea
      ref={area}
      id={fieldId}
      value={value}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder ?? t("md.placeholder.body")}
      aria-label={label ?? t("md.label")}
      aria-describedby={`${fieldId}-hint`}
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
  );

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {label ? (
          <label htmlFor={fieldId} className="text-[13px] font-medium text-fg">
            {label}
          </label>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {uploading > 0 ? (
            <span role="status" className="text-xs text-fg-muted">
              {t("md.uploading")}
            </span>
          ) : null}
          <Segmented
            name={`${fieldId}-mode`}
            size="sm"
            value={mode}
            disabled={disabled}
            onChange={setMode}
            options={[
              { value: "write", label: t("md.mode.write") },
              { value: "preview", label: t("md.mode.preview") },
              { value: "source", label: t("md.mode.source") },
            ]}
          />
        </div>
      </div>

      {mode === "write" ? (
        <div role="toolbar" aria-label={t("md.toolbar")} aria-controls={fieldId} className="flex flex-wrap items-center gap-0.5">
          {actions.map((a) => (
            <IconButton
              key={a.key}
              label={a.shortcut ? `${t(a.labelKey)} (${a.shortcut})` : t(a.labelKey)}
              disabled={disabled}
              onClick={() => (a.apply ? edit((sel) => a.apply!(sel, t)) : file.current?.click())}
            >
              <a.icon />
            </IconButton>
          ))}
        </div>
      ) : null}

      {editing ? (
        textarea
      ) : (
        <div className="min-h-24 rounded-field border border-line bg-surface-2 px-3 py-2">
          {value.trim() ? (
            <MarkdownView source={value} />
          ) : (
            <p className="text-sm text-fg-faint">{t("md.previewEmpty")}</p>
          )}
        </div>
      )}

      <p id={`${fieldId}-hint`} className="text-xs text-fg-faint">
        {showImage ? t("md.hint.withImages") : t("md.hint")}
      </p>

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
    </div>
  );
}
