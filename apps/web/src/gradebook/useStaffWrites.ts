/*
 * The staff's gradebook writes as a screen runs them (F-GBOOK-06, ADR-074):
 * a refusal becomes a toast in words; a mark over a real grade, which the
 * server refuses with `409 grade_exists`, asks the teacher before it is sent
 * again with `override: true`; a column's setting that moves the means
 * students read now asks first (ADR-131 §14). The gradebook's matrix, the
 * results page's excuse (#969) and an activity's Gradebook row
 * (`GradebookSettingRow`) share it, so all ask the same questions.
 */
import type { GradebookColumnPatch, GradebookMarkPut } from "@quiz/contracts";
import { countsInMean } from "@quiz/domain";

import { refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { gradebookRefusalMessage, useGradebookWrites, type ColumnRef } from "./api";
import type { ColumnSettings } from "./ColumnSettingsFields";

/** A column as a mark names it: its address, and its title for the question. */
export type MarkColumn = ColumnRef & { title: string };

/** A column as its settings' write weighs it: where it counts now, and whether it is released. */
type SettingsColumn = MarkColumn & Pick<ColumnSettings, "counts" | "componentId"> & { released: boolean };

/** What a column's write weighs of its classroom: whether students see their mean, whether the course has components. */
interface MeanFacts {
  meanPublished: boolean;
  hasComponents: boolean;
}

/** A roster line as a mark names it: its id, and the student's name for the question. */
export interface MarkStudent {
  enrollmentId: string;
  name: string;
}

export function useStaffWrites(classroomId: string) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const writes = useGradebookWrites(classroomId);

  /**
   * Runs one write; a refusal is a toast, in words. True when it went through.
   * `onExists` takes over a `409 grade_exists` instead (the override's question).
   */
  const attempt = async (write: () => Promise<unknown>, onExists?: () => Promise<boolean>): Promise<boolean> => {
    try {
      await write();
      return true;
    } catch (error) {
      if (onExists && refusedWith(error, "grade_exists")) return onExists();
      toast(gradebookRefusalMessage(error, t), "error");
      return false;
    }
  };

  /** A mark; over a real grade the server asks for `override`, and so do we. */
  const putMark = (column: MarkColumn, student: MarkStudent, mark: GradebookMarkPut): Promise<boolean> =>
    attempt(
      () => writes.setMark(column, student.enrollmentId, mark),
      async () =>
        (await confirm({
          title: t("gbook.override.title"),
          message: t("gbook.override.body", { student: student.name, column: column.title }),
          confirmLabel: t("gbook.override.confirm"),
          danger: true,
        })) && attempt(() => writes.setMark(column, student.enrollmentId, { ...mark, override: true })),
    );

  /**
   * A column's settings. One that moves the means students read now — a
   * released column that counts before or after it, the mean published —
   * asks first; nothing else does. False when declined or refused.
   */
  const patchColumn = async (column: SettingsColumn, patch: GradebookColumnPatch, book: MeanFacts): Promise<boolean> => {
    const after = { counts: patch.counts ?? column.counts, componentId: patch.componentId === undefined ? column.componentId : patch.componentId };
    const live =
      column.released &&
      book.meanPublished &&
      (countsInMean(column.counts, column.componentId, book.hasComponents) ||
        countsInMean(after.counts, after.componentId, book.hasComponents));
    if (
      live &&
      !(await confirm({
        title: t("gbook.liveMean.title"),
        message: t("gbook.liveMean.body", { column: column.title }),
        confirmLabel: t("gbook.liveMean.confirm"),
      }))
    ) {
      return false;
    }
    return attempt(() => writes.patchColumn(column, patch));
  };

  return { writes, attempt, putMark, patchColumn };
}
