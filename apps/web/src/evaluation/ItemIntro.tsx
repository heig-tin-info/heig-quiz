import { BookOpen, ChevronDown, Pencil, X } from "lucide-react";
import { useState, type MouseEvent } from "react";

import { ITEM_INTRO_MAX } from "@quiz/contracts";

import { useT, type TFunction } from "../i18n";
import { MarkdownField } from "../markdown/MarkdownField";
import { MarkdownView } from "../markdown/MarkdownView";
import { markdownLead, markdownTitle } from "../markdown/outline";
import { Button, Card, cx, FormError, IconButton, Modal } from "../ui";

/**
 * The text a student reads before an item (ADR-084), as the builder shows it:
 * a recessed band ABOVE the row of the item it precedes — the reverse of the
 * milestone band, which closes the row above it. Recessed and muted like the
 * milestone band: the accent of the screen stays on "Add questions".
 *
 * Folded, it says which text it is: its title (the first heading) and its
 * first paragraph, two lines at most, never its code. A click on the band
 * unfolds it to the whole text as the student reads it (`MarkdownView` in a
 * card, as on the passage screen), and folds it back; the toggle is one
 * button with `aria-expanded`, the chevron at its end, the pencil and the ×
 * beside it and outside it. Folded by default and never remembered, like a
 * `Disclosure`.
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
  const [open, setOpen] = useState(false);
  const title = markdownTitle(intro);
  const lead = markdownLead(intro);
  return (
    <div className="border-b border-dashed border-line-strong bg-surface-2">
      <div className="flex items-start gap-2 py-2 pr-3 pl-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
        >
          <BookOpen className="mt-0.5 size-3.5 shrink-0 text-fg-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium tracking-wide text-fg-muted uppercase">
              {t("eval.questions.intro.label")}
            </span>
            {/* Folded: which text, not the text. Unfolded, the text follows. */}
            {open || (title === null && lead === "") ? null : (
              <span className="line-clamp-2 text-[13px] text-fg">
                {title === null ? null : <span className="font-semibold">{title}</span>}
                {title !== null && lead !== "" ? " · " : null}
                {lead}
              </span>
            )}
          </span>
          <ChevronDown
            aria-hidden
            className={cx(
              "mt-1.5 size-4 shrink-0 text-fg-faint transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
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
      {open ? (
        // A click on the text folds it too, except one that selects words or
        // follows a link. The keyboard has the button above.
        <div
          className="px-4 pb-3"
          onClick={(e: MouseEvent) => {
            if ((e.target as Element).closest("a")) return;
            if ((window.getSelection()?.toString() ?? "") !== "") return;
            setOpen(false);
          }}
        >
          <Card className="p-4 sm:p-5">
            <MarkdownView source={intro} />
          </Card>
        </div>
      ) : null}
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
