/*
 * The dialogs of the staff's matrix (F-GBOOK-02, F-GBOOK-06, M5-04): the
 * teacher's own score for one cell, and a column's settings in the mean. Each
 * validates what it can before sending (the server decides, with
 * `score_above_max` and its weight range), and hands the body to the matrix,
 * which owns the write.
 */
import { useState } from "react";

import {
  GradebookWeight,
  type GradebookColumn,
  type GradebookColumnPatch,
  type GradebookMarkPut,
  type GradebookStaffCell,
  type GradebookStaffRow,
} from "@quiz/contracts";

import { useT } from "../i18n";
import { Field, FormDialog, Textarea } from "../ui";
import { fullName } from "./cells";
import { ColumnSettingsFields, numberOf, settingsPatch, type ColumnSettings, type ComponentChoice } from "./ColumnSettingsFields";

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

/**
 * Excusing one student of one evaluation (#969): what it does in a sentence,
 * and an optional staff-only comment (why: a certificate, an illness). The
 * mark is the gradebook's; the results page asks it from a student's row.
 */
export function ExcuseDialog({
  student,
  comment: initial,
  submitting,
  onClose,
  onSubmit,
}: {
  student: string;
  comment: string | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (mark: GradebookMarkPut) => void;
}) {
  const t = useT();
  const [comment, setComment] = useState(initial ?? "");
  return (
    <FormDialog
      title={t("results.excuse.title", { student })}
      onClose={onClose}
      submitLabel={t("results.excuse.submit")}
      submitting={submitting}
      onSubmit={() => onSubmit({ kind: "excused", comment: comment.trim() || null })}
    >
      <p className="text-sm text-fg-muted">{t("results.excuse.body")}</p>
      <Textarea
        label={t("gbook.score.comment")}
        value={comment}
        maxLength={2000}
        onChange={(e) => setComment(e.target.value)}
        autoFocus
      />
    </FormDialog>
  );
}

/**
 * A column's settings in the mean (`ColumnSettingsFields`): its weight, a
 * whole percentage 0 to 100 checked by the route's own schema (invariant 7),
 * and, on a course with components of the mean, where it counts (ADR-131).
 * Without components it is the column's weight dialog, as it always was.
 * `onSubmit` gets the write, null when nothing changed.
 */
export function ColumnDialog({
  column,
  components,
  submitting,
  onClose,
  onSubmit,
}: {
  column: GradebookColumn;
  components: readonly ComponentChoice[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (patch: GradebookColumnPatch | null) => void;
}) {
  const t = useT();
  const before: ColumnSettings = { counts: column.counts, componentId: column.componentId, weight: column.weight };
  const [settings, setSettings] = useState(before);
  return (
    <FormDialog
      title={t(components.length > 0 ? "gbook.column.menu" : "gbook.weight.title", { column: column.title })}
      onClose={onClose}
      submitLabel={t("common.save")}
      submitting={submitting}
      canSubmit={GradebookWeight.safeParse(settings.weight).success}
      dense
      onSubmit={() => onSubmit(settingsPatch(before, settings))}
    >
      <ColumnSettingsFields value={settings} components={components} onChange={setSettings} />
    </FormDialog>
  );
}
