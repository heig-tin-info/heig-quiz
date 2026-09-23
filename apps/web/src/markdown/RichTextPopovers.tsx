import type { Editor } from "@tiptap/core";
import { Check, Table as TableIcon } from "lucide-react";
import { useId, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import { Button, cx, IconButton, inputClass, Menu, Z } from "../ui";
import type { HolePreview } from "./useClozeHole";

/*
 * What the rich text field opens over or beside itself: the link prompt, the
 * table menu, and the read-only list under a multi-answer hole. The formula
 * dialog (FormulaDialog.tsx) and the blank card (BlankPopover.tsx) have files
 * of their own; their state lives in useFormulaTarget.ts and useClozeHole.ts.
 */

/**
 * The link prompt, prefilled with the address under the caret. Applying an
 * empty address removes the link; either way `onClose` is called and the
 * caret goes back to the field.
 */
export function LinkPrompt({
  editor,
  initial,
  onClose,
}: {
  editor: Editor | null;
  initial: string;
  onClose: () => void;
}) {
  const t = useT();

  /** Applies what the link prompt collected, then gives the caret back. */
  function applyAsked(text: string) {
    if (!editor) return;
    const chain = editor.chain().focus();
    if (text.trim() === "") chain.unsetLink().run();
    else chain.extendMarkRange("link").setLink({ href: text.trim() }).run();
    onClose();
  }

  return (
    <AskBar
      label={t("md.url")}
      initial={initial}
      apply={t("common.save")}
      cancel={t("common.cancel")}
      onSubmit={applyAsked}
      onCancel={() => {
        onClose();
        editor?.commands.focus();
      }}
    />
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

/*
 * What can be done to the TABLE the caret is in. A menu and not seven more
 * icons in the row: they only exist while the caret is in a table, and a
 * strip that grows by seven buttons under the teacher's hand is the row of
 * icon buttons DESIGN.md sends to a menu. It is drawn only when there is a
 * table to act on, so nothing is reserved for it either.
 */
export function TableMenu({ editor }: { editor: Editor }) {
  const t = useT();
  return (
    <Menu
      label={t("md.table.menu")}
      align="start"
      trigger={
        <IconButton size="sm" label={t("md.table.menu")} onMouseDown={(e) => e.preventDefault()}>
          <TableIcon />
        </IconButton>
      }
      items={[
        { label: t("md.table.rowBefore"), onSelect: () => editor.chain().focus().addRowBefore().run() },
        { label: t("md.table.rowAfter"), onSelect: () => editor.chain().focus().addRowAfter().run() },
        { label: t("md.table.columnBefore"), onSelect: () => editor.chain().focus().addColumnBefore().run() },
        { label: t("md.table.columnAfter"), onSelect: () => editor.chain().focus().addColumnAfter().run() },
        { label: t("md.table.deleteRow"), separator: true, danger: true, onSelect: () => editor.chain().focus().deleteRow().run() },
        { label: t("md.table.deleteColumn"), danger: true, onSelect: () => editor.chain().focus().deleteColumn().run() },
        { label: t("md.table.deleteTable"), danger: true, onSelect: () => editor.chain().focus().deleteTable().run() },
      ]}
    />
  );
}

/**
 * The read-only list of what a multi-answer hole accepts, hung under its
 * chip. A portal, so that the field's own box does not clip it.
 */
export function HolePreviewPopover({ preview }: { preview: HolePreview }) {
  return createPortal(
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
  );
}
