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
 * before anything is typed.
 */
import { useState } from "react";

import { useT } from "../i18n";
import { Alert, FormDialog, FormError, Field, Spinner } from "../ui";
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
  /** Opens the entry page for that student, with the exam date chosen. */
  onStart: (examDate: string) => void;
}) {
  const t = useT();
  const paper = usePaperItems(evaluationId, userId);
  const [date, setDate] = useState<string | null>(null);
  const examDate = date ?? paper.data?.examDate ?? "";
  const refusal = paperRefusalOf(paper.error);
  return (
    <FormDialog
      title={t("paper.banner", { name })}
      onClose={onClose}
      submitLabel={t("paper.enter.start")}
      canSubmit={paper.data !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(examDate)}
      onSubmit={() => onStart(examDate)}
      error={
        <FormError
          error={paper.error}
          {...(refusal ? { describe: () => t(REFUSAL_KEYS[refusal]) } : {})}
        />
      }
    >
      <p className="text-sm text-fg-muted">{t("paper.enter.desc")}</p>
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
