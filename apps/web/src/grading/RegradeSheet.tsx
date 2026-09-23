import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { GradingQueueItem } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Field, FormError, Textarea } from "../ui";
import { useGradingInvalidate } from "./useGradingInvalidate";
import { ValidatedSheet } from "./ValidatedSheet";

/**
 * F-GRADE-06: one question, graded again across every attempt, optionally
 * against a newer published version. The note is mandatory because it is
 * what every new grading carries in its `regradeNote`, and what the history
 * shows a month later when someone asks why a grade moved.
 */
export function RegradeSheet({
  evaluationId,
  item,
  onClose,
}: {
  evaluationId: string;
  item: GradingQueueItem;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const invalidateGrading = useGradingInvalidate(evaluationId);
  const [note, setNote] = useState("");
  const [version, setVersion] = useState("");
  const noteInvalid = note.trim() === "";

  const run = useMutation({
    mutationFn: () =>
      api(`/app/api/evaluations/${evaluationId}/items/${item.id}/regrade`, {
        method: "POST",
        body: JSON.stringify({
          note: note.trim(),
          ...(version.trim() === "" ? {} : { toVersionNumber: Number(version) }),
        }),
      }),
    onSuccess: () => {
      invalidateGrading();
      toast(t("grading.regrade.started"), "progress");
      onClose();
    },
  });

  return (
    <ValidatedSheet
      title={t("grading.regrade.title")}
      subtitle={t("grading.regrade.subtitle")}
      onClose={onClose}
      submitLabel={t("grading.regrade.action")}
      submitting={run.isPending}
      invalid={noteInvalid}
      onSubmit={() => run.mutate()}
      error={<FormError error={run.error} title={t("grading.regrade.failed")} />}
    >
      {(touched) => (
        <>
          <p className="text-sm text-fg-muted">
            {/* 0-based on the wire; every screen numbers questions from 1. */}
            {item.position + 1}. {item.internalName}
          </p>
          <div className="space-y-1.5">
            <Textarea
              label={t("grading.regrade.note")}
              placeholder={t("grading.regrade.notePlaceholder")}
              value={note}
              required
              autoFocus
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={touched && noteInvalid}
            />
            {touched && noteInvalid ? (
              <p className="text-[13px] text-danger">{t("grading.regrade.noteRequired")}</p>
            ) : null}
          </div>
          {/* The explanation is a line of its own, not the field's `hint`: the
              hint shares the label row, and a label row 128 px wide turns a
              sentence into one word per line. */}
          <div className="space-y-1.5">
            <Field
              label={t("grading.regrade.version")}
              type="number"
              min={1}
              step="1"
              width="w-32"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
            <p className="text-xs text-fg-muted">{t("grading.regrade.versionHint")}</p>
          </div>
        </>
      )}
    </ValidatedSheet>
  );
}
