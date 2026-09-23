import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { Grading, GradingEntry } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Alert, Button, Field, Sheet, Textarea } from "../ui";
import { useGradingInvalidate } from "./useGradingInvalidate";

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
  onClose,
}: {
  evaluationId: string;
  entry: GradingEntry;
  maxPoints: number;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const invalidateGrading = useGradingInvalidate(evaluationId);
  const [points, setPoints] = useState(() =>
    entry.grading ? formatPoints(entry.grading.points) : "0",
  );
  const [comment, setComment] = useState(entry.grading?.comment ?? "");
  const [touched, setTouched] = useState(false);

  const value = Number(points.replace(",", "."));
  const pointsInvalid = !Number.isFinite(value) || value < 0 || value > maxPoints;
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

  const submit = () => {
    setTouched(true);
    if (pointsInvalid || commentInvalid || path === null) return;
    save.mutate();
  };

  return (
    <Sheet
      title={t("grading.override.title")}
      subtitle={t("grading.override.subtitle")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            {t("grading.override.save")}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-sm text-fg-muted">{entry.label}</p>
        <Field
          label={t("grading.override.points")}
          hint={t("grading.override.max", { max: formatPoints(maxPoints) })}
          type="number"
          step="0.5"
          min={0}
          max={maxPoints}
          autoFocus
          width="w-32"
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          aria-invalid={touched && pointsInvalid}
        />
        {touched && pointsInvalid ? (
          <p className="text-[13px] text-danger">
            {t("grading.override.pointsInvalid", { max: formatPoints(maxPoints) })}
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
        {save.isError ? (
          <Alert tone="danger" title={t("grading.override.failed")}>
            {apiErrorMessage(save.error, t("error.server"))}
          </Alert>
        ) : null}
      </form>
    </Sheet>
  );
}
