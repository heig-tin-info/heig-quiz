import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, FileStack, Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { EvaluationPatch, type EvaluationSummary } from "@quiz/contracts";
import { courseRoleAllows } from "@quiz/domain";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useClassroom, useCourseRole } from "../course/parts";
import { useT } from "../i18n";
import { evaluationsKey } from "../queryKeys";
import type { Route } from "../router";
import { TextFieldDialog, type MenuItem } from "../ui";
import { evaluationLinkItems } from "./common";
import { SaveAsTemplateDialog, useDuplicateErrorToast } from "./templates";
import { PullTemplateDialog } from "./templatePull";
import { useRenameEvaluation } from "./usePatch";

/**
 * "Rename" from a row's menu (#804): the title alone, without opening the
 * evaluation. The heading's own rename (`useRenameEvaluation`), so the same
 * schema, the same toast, and any state — a running exam's title changes for
 * its students as it does from the heading.
 */
function RenameEvaluationDialog({
  evaluation,
  classroomId,
  onClose,
}: {
  evaluation: Pick<EvaluationSummary, "id" | "title">;
  classroomId: string;
  onClose: () => void;
}) {
  const t = useT();
  const { rename, pending } = useRenameEvaluation(evaluation.id, classroomId);
  return (
    <TextFieldDialog
      title={t("eval.rename.of", { title: evaluation.title })}
      label={t("eval.titleLabel")}
      initial={evaluation.title}
      submitLabel={t("common.rename")}
      valid={(title) => EvaluationPatch.safeParse({ title }).success}
      submitting={pending}
      onSubmit={(title) => rename(title, onClose)}
      onClose={onClose}
    />
  );
}

/**
 * What an evaluation row of the classroom's Activities tab does besides
 * opening (`ClassroomActivities`): its overflow menu, the template pull its
 * badge opens (F-EVAL-26), and the dialogs those lead to (`layers`, drawn
 * once beside the tables). The menu is the same whichever table holds the
 * row: where else it leads, Rename (#804), Duplicate, Save as template
 * (never a poll's, `422 template_poll`) and Delete, greyed out with its
 * reason where the course role does not allow it (ADR-068 §3).
 */
export interface EvaluationRowActions {
  /** The row's overflow menu. */
  menuItems: (row: EvaluationSummary) => MenuItem[];
  /** Opens the template pull of the row of this id (its badge's door). */
  pull: (id: string) => void;
  /** The dialogs, drawn once beside the tables. */
  layers: ReactNode;
}

export function useEvaluationRowActions(classroomId: string, navigate: (r: Route) => void): EvaluationRowActions {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  /** The row whose template pull is being confirmed (F-EVAL-26). */
  const [pulling, setPulling] = useState<string | null>(null);
  /** The row being saved as a template of the course (ADR-031). */
  const [savingTemplate, setSavingTemplate] = useState<EvaluationSummary | null>(null);
  /** The row being renamed (#804). */
  const [renaming, setRenaming] = useState<EvaluationSummary | null>(null);
  const classroom = useClassroom(classroomId);
  const myRole = useCourseRole(classroom.data?.course.id);

  const invalidate = () => qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) });
  const duplicateFailed = useDuplicateErrorToast();
  const duplicate = useMutation({
    mutationFn: (row: EvaluationSummary) =>
      api(`/app/api/evaluations/${row.id}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ title: t("eval.duplicateTitle", { title: row.title }) }),
      }),
    onSuccess: invalidate,
    onError: duplicateFailed,
  });
  const remove = useMutation({
    mutationFn: (row: EvaluationSummary) =>
      api(`/app/api/evaluations/${row.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmTitle: row.title }),
      }),
    onSuccess: invalidate,
  });

  const menuItems = (row: EvaluationSummary): MenuItem[] => [
    ...evaluationLinkItems(row, t, navigate),
    { label: t("common.rename"), icon: Pencil, onSelect: () => setRenaming(row) },
    { label: t("eval.duplicate"), icon: Copy, onSelect: () => duplicate.mutate(row) },
    ...(row.mode === "poll" || !classroom.data
      ? []
      : [{ label: t("templates.save"), icon: FileStack, onSelect: () => setSavingTemplate(row) }]),
    {
      label: t("eval.delete"),
      icon: Trash2,
      danger: true,
      separator: true,
      ...(courseRoleAllows(myRole, row.deletionRole)
        ? {}
        : { disabled: true, description: t("eval.delete.ownerOnly") }),
      onSelect: async () => {
        if (
          await confirm({
            title: t("eval.deleteConfirm", { name: row.title }),
            confirmLabel: t("common.delete"),
            danger: true,
          })
        ) {
          remove.mutate(row);
        }
      },
    },
  ];

  const layers = (
    <>
      {savingTemplate && classroom.data ? (
        <SaveAsTemplateDialog
          evaluationId={savingTemplate.id}
          classroomId={classroomId}
          title={savingTemplate.title}
          course={classroom.data.course}
          onClose={() => setSavingTemplate(null)}
        />
      ) : null}
      {renaming ? (
        <RenameEvaluationDialog evaluation={renaming} classroomId={classroomId} onClose={() => setRenaming(null)} />
      ) : null}
      {pulling ? (
        <PullTemplateDialog evaluationId={pulling} classroomId={classroomId} onClose={() => setPulling(null)} />
      ) : null}
    </>
  );

  return { menuItems, pull: setPulling, layers };
}
