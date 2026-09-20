import { useMutation } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import type { VersionRow, ZodIssueLite } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { Alert, Button, Modal, Textarea } from "../ui";
import { issueMessage, issuesOfError } from "./issues";

/**
 * Publication (F-QST-03): a change note, and the refusal shown where the
 * decision is made.
 *
 * Publishing is where `configSchema.parse` finally runs (decision D16), so a
 * 422 is a normal answer here, not an error state: the dialog stays open and
 * lists what the schema refused, field path first, so the teacher can go
 * straight to it.
 */
export function PublishDialog({
  questionId,
  draftIssues,
  onClose,
  onPublished,
}: {
  questionId: string;
  /** What the last autosave reported; shown before the first attempt. */
  draftIssues: readonly ZodIssueLite[];
  onClose: () => void;
  onPublished: (version: VersionRow) => void;
}) {
  const t = useT();
  const [note, setNote] = useState("");
  const publish = useMutation({
    mutationFn: () =>
      api<VersionRow>(`/app/api/questions/${questionId}/publish`, {
        method: "POST",
        body: JSON.stringify(note.trim() ? { changeNote: note.trim() } : {}),
      }),
    onSuccess: onPublished,
  });

  const issues = publish.isError ? issuesOfError(publish.error) : draftIssues;
  const blocked = issues.length > 0;

  return (
    <Modal
      title={t("question.publishTitle")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => publish.mutate()} loading={publish.isPending}>
            {t("question.publishAction")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {blocked ? (
          <Alert tone="danger" icon={AlertTriangle} title={t("question.publishIssues")}>
            <p>{t("question.publishIssuesBody")}</p>
            <ul className="mt-2 space-y-1">
              {issues.map((issue, i) => (
                <li key={`${issue.path.join(".")}-${i}`} className="text-[13px]">
                  {issue.path.length > 0 ? (
                    <span className="font-mono text-fg">{issue.path.join(".")} — </span>
                  ) : null}
                  {issueMessage(t, issue.message)}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {publish.isError && !blocked ? (
          <p className="text-[13px] text-danger">
            {apiErrorMessage(publish.error, t("question.publishFailed"))}
          </p>
        ) : null}

        <Textarea
          label={t("question.changeNote")}
          placeholder={t("question.changeNoteHint")}
          rows={3}
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
    </Modal>
  );
}
