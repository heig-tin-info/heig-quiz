/*
 * The two dialogs of the staff's matrix (F-GBOOK-02, F-GBOOK-06, M5-04): the
 * teacher's own score for one cell, and a column's weight. Each validates what
 * it can before sending (the server decides, with `score_above_max` and its
 * weight range), and hands the body to the matrix, which owns the write.
 */
import { useState } from "react";

import { validWeight } from "@quiz/domain";
import type { GradebookColumn, GradebookMarkPut, GradebookStaffCell, GradebookStaffRow } from "@quiz/contracts";

import { useT } from "../i18n";
import { Field, FormDialog, Textarea } from "../ui";
import { fullName } from "./cells";

/** Parses what a person typed in a number field: a comma is a decimal point; anything else is NaN. */
const numberOf = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text.trim().replace(",", ".")));

/** The teacher's own score for one student of one column: points out of a maximum, and a staff-only comment. */
export function ScoreDialog({
  row,
  column,
  cell,
  submitting,
  onClose,
  onSubmit,
}: {
  row: GradebookStaffRow;
  column: GradebookColumn;
  cell: GradebookStaffCell | undefined;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (mark: GradebookMarkPut) => void;
}) {
  const t = useT();
  const [points, setPoints] = useState(cell?.points == null ? "" : String(cell.points));
  const [max, setMax] = useState(cell?.max == null ? "" : String(cell.max));
  const [comment, setComment] = useState(cell?.mark?.comment ?? "");
  const p = numberOf(points);
  const m = numberOf(max);
  const valid = p >= 0 && m > 0 && p <= m;
  return (
    <FormDialog
      title={t("gbook.score.title", { student: fullName(row) })}
      onClose={onClose}
      submitLabel={t("gbook.score.submit")}
      submitting={submitting}
      canSubmit={valid}
      onSubmit={() => onSubmit({ kind: "score", points: p, max: m, comment: comment.trim() || null })}
    >
      <p className="text-sm text-fg-muted">{column.title}</p>
      <div className="flex gap-3">
        <Field
          label={t("gbook.score.points")}
          inputMode="decimal"
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          autoFocus
          width="w-28"
        />
        <Field
          label={t("gbook.score.max")}
          inputMode="decimal"
          value={max}
          onChange={(e) => setMax(e.target.value)}
          width="w-28"
        />
      </div>
      <Textarea
        label={t("gbook.score.comment")}
        value={comment}
        maxLength={2000}
        onChange={(e) => setComment(e.target.value)}
      />
    </FormDialog>
  );
}

/** A column's weight in the mean: 0 to 10, at the tenth. */
export function WeightDialog({
  column,
  submitting,
  onClose,
  onSubmit,
}: {
  column: GradebookColumn;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (weight: number) => void;
}) {
  const t = useT();
  const [text, setText] = useState(String(column.weight));
  const weight = numberOf(text);
  return (
    <FormDialog
      title={t("gbook.weight.title", { column: column.title })}
      onClose={onClose}
      submitLabel={t("common.save")}
      submitting={submitting}
      canSubmit={validWeight(weight)}
      dense
      onSubmit={() => onSubmit(weight)}
    >
      <Field
        label={t("gbook.weight.label")}
        description={t("gbook.weight.hint")}
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        width="w-28"
      />
    </FormDialog>
  );
}
