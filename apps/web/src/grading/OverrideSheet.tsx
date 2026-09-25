import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { Grading, GradingEntry } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Field, FormError, Textarea } from "../ui";
import { useGradingInvalidate } from "./useGradingInvalidate";
import { ValidatedSheet } from "./ValidatedSheet";

/**
 * F-GRADE-05: the teacher's own grading, with its MANDATORY comment. The
 * grading it replaces is not deleted — the server supersedes it, and the
 * history popover next to this button is where it goes on living.
 *
 * Two addresses for one operation: a cell with an answer is addressed by
 * that answer, a cell with none — an absent student, still graded zero
 * (F-GRADE-01) — by the grading itself (deviation W6-3). The form is the
 * same, so the caller never has to know which one it is looking at.
 */
export function OverrideSheet({
  evaluationId,
  entry,
  maxPoints,
  minPoints = 0,
  onClose,
}: {
  evaluationId: string;
  entry: GradingEntry;
  maxPoints: number;
  /**
   * The lowest score the server takes (`GradingQueueItem.minPoints`): 0, or
   * `-maxPoints` for a choice question under negative marking (ADR-026).
   */
  minPoints?: number;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const invalidateGrading = useGradingInvalidate(evaluationId);
  const [points, setPoints] = useState(() =>
    entry.grading ? formatPoints(entry.grading.points) : "0",
  );
  const [comment, setComment] = useState(entry.grading?.comment ?? "");

  const value = Number(points.replace(",", "."));
  const pointsInvalid = !Number.isFinite(value) || value < minPoints || value > maxPoints;
  const commentInvalid = comment.trim() === "";

  const path = entry.grading
    ? `/app/api/gradings/${entry.grading.id}/override`
    : entry.answerId
      ? `/app/api/answers/${entry.answerId}/gradings`
      : null;

  const save = useMutation<Grading>({
    mutationFn: () =>
      api(path!, {
        method: "POST",
        body: JSON.stringify({ points: value, comment: comment.trim() }),
      }),
    onSuccess: () => {
      invalidateGrading();
      toast(t("grading.override.done"), "success");
      onClose();
    },
  });

  return (
    <ValidatedSheet
      title={t("grading.override.title")}
      subtitle={t("grading.override.subtitle")}
      onClose={onClose}
      submitLabel={t("grading.override.save")}
      submitting={save.isPending}
      invalid={pointsInvalid || commentInvalid || path === null}
      onSubmit={() => save.mutate()}
      error={<FormError error={save.error} title={t("grading.override.failed")} />}
    >
      {(touched) => (
        <>
          <p className="text-sm text-fg-muted">{entry.label}</p>
          <Field
            label={t("grading.override.points")}
            hint={
              minPoints < 0
                ? t("grading.override.range", {
                    min: formatPoints(minPoints),
                    max: formatPoints(maxPoints),
                  })
                : t("grading.override.max", { max: formatPoints(maxPoints) })
            }
            type="number"
            step="0.5"
            min={minPoints}
            max={maxPoints}
            autoFocus
            width="w-32"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            aria-invalid={touched && pointsInvalid}
          />
          {touched && pointsInvalid ? (
            <p className="text-[13px] text-danger">
              {t("grading.override.pointsInvalid", {
                min: formatPoints(minPoints),
                max: formatPoints(maxPoints),
              })}
            </p>
          ) : null}
          <div className="space-y-1.5">
            <Textarea
              label={t("grading.override.comment")}
              placeholder={t("grading.override.commentPlaceholder")}
              value={comment}
              required
              onChange={(e) => setComment(e.target.value)}
              aria-invalid={touched && commentInvalid}
            />
            {touched && commentInvalid ? (
              <p className="text-[13px] text-danger">{t("grading.override.commentRequired")}</p>
            ) : null}
          </div>
        </>
      )}
    </ValidatedSheet>
  );
}
