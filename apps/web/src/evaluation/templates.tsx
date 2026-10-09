import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyPlus, FileStack, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  TemplatePoolUnlinked,
  type ClassroomSummary,
  type EvaluationTemplate,
  type TemplateCreate,
  type TemplateInstance,
  type TemplateInstantiate,
  type TemplateItemRef,
  type TemplateNew,
} from "@quiz/contracts";

import { api, ApiError, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT, type TFunction } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import {
  Actions,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Field,
  FormDialog,
  FormError,
  QueryError,
  Select,
  Skeleton,
} from "../ui";
import { ModeChoice, TemplateModeLine, type CreatedMode } from "./ModeChoice";
import { coursesKey, courseTemplatesKey, evaluationKey, evaluationsKey } from "../queryKeys";

/**
 * Evaluation templates of a course (ADR-031): the section of the course page,
 * the dialog that makes a classroom's evaluation from one, and the dialog
 * that saves an evaluation as one.
 *
 * The course page is the ONE surface that lists them, and there the section
 * shows even while it is empty (ADR-031, addendum of 2026-09-28): a teacher
 * who opened a course has asked to see all of it, and the empty state is
 * where they learn the two doors in — "New template" here (F-EVAL-24), and
 * "Save as template" in an evaluation's menu. The novice home is spared: the
 * course card lists no template, it counts them.
 */

export function useCourseTemplates(courseId: string | null) {
  return useQuery<EvaluationTemplate[]>({
    queryKey: courseTemplatesKey(courseId),
    enabled: courseId !== null,
    queryFn: () => api(`/app/api/courses/${courseId}/templates`),
  });
}

/** After a template is made or deleted: the course's list, and the count on its card. */
const templatesChanged = (qc: QueryClient, courseId: string | null) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: courseTemplatesKey(courseId) }),
    qc.invalidateQueries({ queryKey: coursesKey }),
  ]);

/** The names of the items a refusal or a warning is about, in order. */
export const itemNames = (items: readonly TemplateItemRef[]) =>
  items.map((i) => i.internalName).join(", ");

/**
 * What a copy refused for its unlinked pools says (`422 template_pool_unlinked`),
 * translated from its machine half — an "Instantiate" or a "Duplicate".
 */
export function instantiateError(error: unknown, t: TFunction): string | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = TemplatePoolUnlinked.safeParse(error.body);
  return parsed.success ? t("templates.unlinked", { names: itemNames(parsed.data.items) }) : null;
}

/**
 * The one mutation "Instantiate" is, shared by the course card and the
 * creation dialog of a classroom: the same call, the same refusal, the same
 * warning, and the same landing on the new evaluation.
 */
export function useInstantiate(onCreated: (evaluationId: string) => void) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { template: EvaluationTemplate; classroomId: string; title: string }) =>
      api<TemplateInstance>(`/app/api/templates/${input.template.id}/instances`, {
        method: "POST",
        body: JSON.stringify({
          classroomId: input.classroomId,
          title: input.title.trim(),
        } satisfies TemplateInstantiate),
      }),
    onSuccess: async (made, input) => {
      await qc.invalidateQueries({ queryKey: evaluationsKey(input.classroomId) });
      if (made.deprecatedItems.length > 0) {
        toast(t("templates.deprecated", { names: itemNames(made.deprecatedItems) }), "warning");
      }
      onCreated(made.evaluation.id);
    },
  });
}

/**
 * The toast of a "Duplicate" that failed. The menu that started it is closed
 * by then, so the refusal has nowhere else to render.
 */
export function useDuplicateErrorToast(): (error: unknown) => void {
  const t = useT();
  const toast = useToast();
  return (error) =>
    toast(instantiateError(error, t) ?? apiErrorMessage(error, t("eval.duplicateFailed")), "error");
}

/** The error slot of a dialog that instantiates. */
export function InstantiateError({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  const message = instantiateError(error, t);
  return message ? (
    <ErrorText>{message}</ErrorText>
  ) : (
    <FormError error={error} fallback={t("templates.createFailed")} />
  );
}

/** "Use in a classroom": a draft evaluation of one of the course's classrooms. */
export function UseTemplateDialog({
  template,
  classrooms,
  onClose,
  navigate,
}: {
  template: EvaluationTemplate;
  classrooms: ClassroomSummary[];
  onClose: () => void;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const [classroomId, setClassroomId] = useState(classrooms[0]?.id ?? "");
  const [title, setTitle] = useState(template.title);
  const create = useInstantiate((id) => {
    onClose();
    navigate({ view: "evaluation", id });
  });
  return (
    <FormDialog
      title={t("templates.useTitle", { title: template.title })}
      onClose={onClose}
      onSubmit={() => create.mutate({ template, classroomId, title })}
      submitLabel={t("eval.create")}
      submitting={create.isPending}
      canSubmit={classroomId !== "" && title.trim() !== ""}
      error={<InstantiateError error={create.error} />}
    >
      <Select
        label={t("templates.classroom")}
        value={classroomId}
        onChange={(e) => setClassroomId(e.target.value)}
      >
        {classrooms.map((room) => (
          <option key={room.id} value={room.id}>
            {room.period ? `${room.name} — ${room.period}` : room.name}
          </option>
        ))}
      </Select>
      <Field
        label={t("eval.titleLabel")}
        required
        fullWidth
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        help={t("templates.useHelp")}
      />
      <TemplateModeLine mode={template.mode} />
    </FormDialog>
  );
}

/**
 * The actions of one template, wherever it is shown: the row of the course
 * page and the header of its editor. "Use in a classroom" only exists while
 * the course has one; the deletion asks first.
 */
export function useTemplateActions(
  courseId: string,
  classrooms: ClassroomSummary[],
  options: { onDeleted?: () => void } = {},
) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toastError = useErrorToast();
  const [using, setUsing] = useState<EvaluationTemplate | null>(null);
  const remove = useMutation({
    mutationFn: (template: EvaluationTemplate) =>
      api(`/app/api/templates/${template.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await templatesChanged(qc, courseId);
      options.onDeleted?.();
    },
    onError: toastError("error.save"),
  });
  const canUse = classrooms.length > 0;
  const deleteItem = (template: EvaluationTemplate) => ({
    label: t("templates.delete"),
    icon: Trash2,
    danger: true,
    onSelect: async () => {
      if (
        await confirm({
          title: t("templates.delete"),
          message: t("templates.deleteConfirm", { name: template.title }),
          confirmLabel: t("common.delete"),
          danger: true,
        })
      ) {
        remove.mutate(template);
      }
    },
  });
  const useItem = (template: EvaluationTemplate) => ({
    label: t("templates.use"),
    icon: CopyPlus,
    onSelect: () => setUsing(template),
  });
  return { canUse, use: setUsing, useItem, deleteItem, using, closeUse: () => setUsing(null) };
}

/**
 * "New template" (F-EVAL-24): a title and a mode, exactly as an evaluation's
 * creation asks, in the course rather than in a classroom. The mode names
 * the preset, as there. On success the teacher lands in the new template's
 * editor, since an empty template is only a start.
 */
export function NewTemplateDialog({
  courseId,
  onClose,
  navigate,
}: {
  courseId: string;
  onClose: () => void;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<CreatedMode>("exam");
  const create = useMutation({
    mutationFn: () =>
      api<EvaluationTemplate>(`/app/api/courses/${courseId}/templates`, {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), mode, preset: mode } satisfies TemplateNew),
      }),
    onSuccess: async (made) => {
      await templatesChanged(qc, courseId);
      navigate({ view: "template", id: made.id });
    },
  });
  return (
    <FormDialog
      title={t("templates.new")}
      onClose={onClose}
      onSubmit={() => create.mutate()}
      submitLabel={t("templates.create")}
      submitting={create.isPending}
      canSubmit={title.trim() !== ""}
      error={<FormError error={create.error} fallback={t("templates.newFailed")} />}
    >
      <Field
        label={t("eval.titleLabel")}
        placeholder={t("templates.titlePlaceholder")}
        required
        fullWidth
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <ModeChoice value={mode} onChange={setMode} />
    </FormDialog>
  );
}

/**
 * The templates of one course, the Templates tab of its page. A row opens the
 * template's editor, like a classroom row opens the classroom; beside it sit
 * what a template is for — a new evaluation in one of the course's
 * classrooms — and its deletion; two actions, so two icon buttons
 * (`Actions`). "New template" is the tab's one primary, in the page header,
 * which owns `creating` so the header and the empty state open one dialog.
 */
export function CourseTemplates({
  courseId,
  classrooms,
  navigate,
  creating,
  onCreating,
}: {
  courseId: string;
  classrooms: ClassroomSummary[];
  navigate: (r: Route) => void;
  creating: boolean;
  onCreating: (open: boolean) => void;
}) {
  const t = useT();
  const list = useCourseTemplates(courseId);
  const actions = useTemplateActions(courseId, classrooms);

  const templates = list.data ?? [];
  return (
    <Card className="p-3">
      {list.isLoading ? (
        <Skeleton className="h-6 w-64" />
      ) : list.isError ? (
        <QueryError title={t("templates.title")} query={list} />
      ) : templates.length === 0 ? (
        <EmptyState
          icon={FileStack}
          title={t("templates.empty.title")}
          className="py-8"
          action={
            <Button size="sm" variant="secondary" onClick={() => onCreating(true)}>
              <Plus /> {t("templates.new")}
            </Button>
          }
        >
          {t("templates.empty.body")}
        </EmptyState>
      ) : (
        <ul className="space-y-0.5">
          {templates.map((template) => (
            <li key={template.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => navigate({ view: "template", id: template.id })}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-field px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-2"
              >
                <FileStack className="size-3.5 shrink-0 text-fg-faint" />
                <span className="min-w-0 flex-1 truncate font-medium">{template.title}</span>
                {/* On a phone the title keeps the room: the mode leaves first,
                    the counts stay. */}
                <span className="hidden shrink-0 text-xs text-fg-muted sm:inline">
                  {t(`eval.mode.${template.mode}`)}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                  {t(template.itemCount === 1 ? "templates.meta.one" : "templates.meta", {
                    n: template.itemCount,
                    points: template.totalPoints,
                    revision: template.revision,
                  })}
                </span>
              </button>
              <Actions
                label={t("common.actions")}
                size="sm"
                items={[
                  ...(actions.canUse ? [actions.useItem(template)] : []),
                  actions.deleteItem(template),
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {actions.using ? (
        <UseTemplateDialog
          template={actions.using}
          classrooms={classrooms}
          onClose={actions.closeUse}
          navigate={navigate}
        />
      ) : null}
      {creating ? (
        <NewTemplateDialog courseId={courseId} onClose={() => onCreating(false)} navigate={navigate} />
      ) : null}
    </Card>
  );
}

/** "Save as template", from an evaluation's menu. */
export function SaveAsTemplateDialog({
  evaluationId,
  classroomId,
  title: initialTitle,
  course,
  onClose,
}: {
  evaluationId: string;
  classroomId: string;
  title: string;
  course: { id: string; name: string };
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(initialTitle);
  const save = useMutation({
    mutationFn: () =>
      api<EvaluationTemplate>(`/app/api/evaluations/${evaluationId}/template`, {
        method: "POST",
        body: JSON.stringify({ title: title.trim() } satisfies TemplateCreate),
      }),
    onSuccess: async () => {
      // The source is now linked to the template it gave (F-EVAL-18): its row
      // and its launch checklist read that origin.
      await Promise.all([
        templatesChanged(qc, course.id),
        qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) }),
        qc.invalidateQueries({ queryKey: evaluationKey(evaluationId) }),
      ]);
      toast(t("templates.saved"), "success");
      onClose();
    },
  });
  return (
    <FormDialog
      title={t("templates.saveTitle", { course: course.name })}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitLabel={t("templates.save")}
      submitting={save.isPending}
      canSubmit={title.trim() !== ""}
      dense
      error={<FormError error={save.error} fallback={t("templates.saveFailed")} />}
    >
      <Field
        label={t("eval.titleLabel")}
        required
        fullWidth
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        help={t("templates.saveHelp")}
      />
    </FormDialog>
  );
}
