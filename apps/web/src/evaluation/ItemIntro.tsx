import { BookOpen, Pencil, X } from "lucide-react";
import { useState } from "react";

import { ITEM_INTRO_MAX } from "@quiz/contracts";

import { useT, type TFunction } from "../i18n";
import { MarkdownField } from "../markdown/MarkdownField";
import { Button, FormError, IconButton, Modal } from "../ui";

/**
 * The words of a markdown text on one line: block markers at the start of a
 * line and inline emphasis dropped. For a preview the teacher recognises,
 * never for rendering (the student reads `MarkdownView`).
 */
export function excerpt(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}|[-*+]|\d+[.)]|>)\s+/, ""))
    .join(" ")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The text a student reads before an item (ADR-084), as the builder shows it:
 * a recessed band ABOVE the row of the item it precedes — the reverse of the
 * milestone band, which closes the row above it. Its first lines, so the
 * teacher recognises which text it is; the whole of it is one click away in
 * the editor. Recessed and muted like the milestone band: the accent of the
 * screen stays on "Add questions".
 */
export function IntroBand({
  intro,
  name,
  locked,
  onEdit,
  onRemove,
  t,
}: {
  intro: string;
  /** The item's internal name, for the controls' accessible names. */
  name: string;
  locked: boolean;
  onEdit: () => void;
  onRemove: () => void;
  t: TFunction;
}) {
  return (
    <div className="flex items-start gap-2 border-b border-dashed border-line-strong bg-surface-2 py-2 pr-3 pl-4">
      <BookOpen className="mt-0.5 size-3.5 shrink-0 text-fg-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">
          {t("eval.questions.intro.label")}
        </span>
        {/* Two lines of its words: a reminder of which text, not the text. */}
        <p className="line-clamp-2 text-[13px] text-fg">{excerpt(intro)}</p>
      </div>
      <IconButton
        size="sm"
        label={t("eval.questions.intro.edit", { name })}
        disabled={locked}
        onClick={onEdit}
      >
        <Pencil />
      </IconButton>
      <IconButton
        size="sm"
        label={t("eval.questions.intro.remove", { name })}
        disabled={locked}
        onClick={onRemove}
      >
        <X />
      </IconButton>
    </div>
  );
}

/**
 * Writing the text before an item: one markdown field, so a modal (quiz-ui
 * rule 4). The field is the question editor's own (`MarkdownField`), without
 * image upload: an intro is text. Save writes the whole text through the
 * item's patch; a blank text removes it, as the server reads it.
 */
export function IntroEditor({
  name,
  initial,
  saving,
  error,
  onSave,
  onClose,
}: {
  name: string;
  initial: string;
  saving: boolean;
  error: unknown;
  onSave: (intro: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const tooLong = value.length > ITEM_INTRO_MAX;
  return (
    <Modal
      title={t("eval.questions.intro.title", { name })}
      size="lg"
      scroll
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={saving}
            disabled={tooLong}
            onClick={() => onSave(value.trim() === "" ? null : value)}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] leading-relaxed text-fg-muted">{t("eval.questions.intro.hint")}</p>
        <MarkdownField label={t("eval.questions.intro.field")} value={value} onChange={setValue} />
        {tooLong ? (
          <p className="text-[13px] text-danger">
            {t("eval.questions.intro.tooLong", { max: ITEM_INTRO_MAX, n: value.length })}
          </p>
        ) : null}
        <FormError error={error} title={t("eval.saveFailed")} />
      </div>
    </Modal>
  );
}
