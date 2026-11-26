/**
 * "Enter a paper copy" (ADR-125 §9, §17, F-PAPER-01): the step before the
 * entry page, opened from a student's row of the live dashboard or of the
 * results. The student is the row's; the dialog asks for the one thing the
 * paper says and the platform cannot know, the exam date (the evaluation's
 * opening day by default), and says when the copy will replace the
 * student's current attempt. Its one action opens the entry page.
 *
 * It reads the paper the page will type in, so a refusal of the server (an
 * exam that does not print, a seat that is not a student's) is said here,
 * before anything is typed. Where the paper has several variants (ADR-148)
 * it first asks which one the copy is, by the letter in its page footer:
 * the page renders that variant's paper.
 */
import { useState } from "react";

import { variantLetter } from "@quiz/domain";

import { useEvaluation } from "../evaluation/api";
import { useT } from "../i18n";
import { Alert, FormDialog, FormError, Field, Select, Spinner } from "../ui";
import { paperRefusalOf, REFUSAL_KEYS, usePaperItems } from "./api";

export function PaperEntryDialog({
  evaluationId,
  userId,
  name,
  onClose,
  onStart,
}: {
  evaluationId: string;
  userId: string;
  /** The row's student, as the screen names them. */
  name: string;
  onClose: () => void;
  /** Opens the entry page for that student, with the exam date and the copy's variant chosen. */
  onStart: (examDate: string, variant: number) => void;
}) {
  const t = useT();
  const count = useEvaluation(evaluationId).data?.exports.variants.count ?? null;
  const several = count !== null && count > 1;
  const [variant, setVariant] = useState<number | null>(null);
  // One variant: its paper at once. Several: once the copy's is named.
  const paper = usePaperItems(evaluationId, userId, several ? variant : null, count !== null && (!several || variant !== null));
  const [date, setDate] = useState<string | null>(null);
  const examDate = date ?? paper.data?.examDate ?? "";
  const refusal = paperRefusalOf(paper.error);
  return (
    <FormDialog
      title={t("paper.banner", { name })}
      onClose={onClose}
      submitLabel={t("paper.enter.start")}
      canSubmit={paper.data !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(examDate)}
      onSubmit={() => onStart(examDate, variant ?? 1)}
      error={
        <FormError
          error={paper.error}
          {...(refusal ? { describe: () => t(REFUSAL_KEYS[refusal]) } : {})}
        />
      }
    >
      <p className="text-sm text-fg-muted">{t("paper.enter.desc")}</p>
      {several ? (
        <Select
          label={t("paper.variant")}
          help={t("paper.variant.help")}
          width="w-52"
          value={variant ?? ""}
          required
          onChange={(e) => setVariant(e.target.value === "" ? null : Number(e.target.value))}
        >
          <option value="" disabled>
            {t("paper.variant.pick")}
          </option>
          {Array.from({ length: count }, (_, i) => (
            <option key={i} value={i + 1}>
              {t("paper.variant.one", { letter: variantLetter(i + 1) })}
            </option>
          ))}
        </Select>
      ) : null}
      {paper.isPending && paper.fetchStatus !== "idle" ? (
        <Spinner label={t("paper.loading")} className="py-4" />
      ) : paper.data ? (
        <>
          <Field
            type="date"
            label={t("paper.examDate")}
            value={examDate}
            required
            onChange={(e) => setDate(e.target.value)}
          />
          {paper.data.replaces ? <Alert tone="warning">{t("paper.supersede.warn", { name })}</Alert> : null}
        </>
      ) : null}
    </FormDialog>
  );
}
