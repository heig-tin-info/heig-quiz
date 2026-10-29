/*
 * The staff's gradebook writes as a screen runs them (F-GBOOK-06, ADR-074):
 * a refusal becomes a toast in words, and a mark over a real grade, which
 * the server refuses with `409 grade_exists`, asks the teacher before it is
 * sent again with `override: true`. The gradebook's matrix and the results
 * page's excuse (#969) share it, so the two ask the same question.
 */
import type { GradebookMarkPut } from "@quiz/contracts";

import { refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { gradebookRefusalMessage, useGradebookWrites, type ColumnRef } from "./api";

/** A column as a mark names it: its address, and its title for the question. */
export type MarkColumn = ColumnRef & { title: string };

/** A roster line as a mark names it: its id, and the student's name for the question. */
export interface MarkStudent {
  enrollmentId: string;
  name: string;
}

export function useMarkWrites(classroomId: string) {
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

  return { writes, attempt, putMark };
}
