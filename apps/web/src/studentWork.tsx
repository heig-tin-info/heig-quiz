/**
 * A deletion refused because the entity holds students' work (ADR-141): the
 * `409 holds_student_work` of a course, a classroom, an evaluation or a
 * project, said in plain words, with Archive offered where the entity has an
 * archive (a classroom, a project). An evaluation and a course have none:
 * the dialog says why, and closes.
 */
import { StudentWorkRefusal, type StudentWork } from "@quiz/contracts";

import { ApiError } from "./api";
import { useConfirm } from "./confirm";
import { useT, type TFunction } from "./i18n";

export type StudentWorkKind = "evaluation" | "project" | "classroom" | "course";

/** What blocks a refused deletion, or null for any other error. */
export function studentWorkIn(error: unknown): StudentWork | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = StudentWorkRefusal.safeParse(error.body);
  return parsed.success ? parsed.data.work : null;
}

/** The refusal of a kind, in the reader's words: what blocks, and the way out when there is one. */
export function studentWorkText(t: TFunction, kind: StudentWorkKind, work: StudentWork): string {
  switch (kind) {
    case "evaluation":
      return t("studentWork.evaluation");
    case "project":
      return t("studentWork.project");
    case "classroom":
      return t("studentWork.classroom", { count: work.evaluations + work.projects });
    case "course":
      return t("studentWork.course", { count: work.classrooms });
  }
}

/**
 * The `onError` of a delete: the refusal in a dialog — with Archive when
 * `archive` is given, which runs on confirm — and any other error handed to
 * `otherwise`. It returns at once: the delete's button stops spinning while
 * the dialog is read.
 */
export function useStudentWorkRefusal(): (
  kind: StudentWorkKind,
  handlers: { archive?: (() => void) | undefined; otherwise: (error: unknown) => void },
) => (error: unknown) => void {
  const t = useT();
  const confirm = useConfirm();
  return (kind, { archive, otherwise }) =>
    (error) => {
      const work = studentWorkIn(error);
      if (!work) {
        otherwise(error);
        return;
      }
      void confirm({
        title: t("studentWork.title"),
        message: studentWorkText(t, kind, work),
        ...(archive ? { confirmLabel: t("classrooms.archive") } : { confirmLabel: t("common.close"), acknowledge: true }),
      }).then((ok) => {
        if (ok && archive) archive();
      });
    };
}
