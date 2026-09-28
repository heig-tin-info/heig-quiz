import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyPlus, FileStack, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  TemplatePoolUnlinked,
  type ClassroomSummary,
  type EvaluationTemplate,
  type TemplateCreate,
  type TemplateInstance,
  type TemplateInstantiate,
  type TemplateItemRef,
} from "@quiz/contracts";

import { api, ApiError, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT, type TFunction } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import { CoursePart } from "../course/parts";
import { Actions, EmptyState, Field, FormDialog, FormError, QueryError, Select, Skeleton } from "../ui";
import { courseTemplatesKey, evaluationsKey } from "../queryKeys";

/**
 * Evaluation templates of a course (ADR-031): the section of the course page,
 * the dialog that makes a classroom's evaluation from one, and the dialog
 * that saves an evaluation as one.
 *
 * The course page is the ONE surface that lists them, and there the section
 * shows even while it is empty (ADR-031, addendum of 2026-09-28): a teacher
 * who opened a course has asked to see all of it, and the empty state is
 * where they learn that "Save as template", in an evaluation's menu, is the
 * door in. The novice home is spared: the course card lists no template.
 */

export function useCourseTemplates(courseId: string | null) {
  return useQuery<EvaluationTemplate[]>({
    queryKey: courseTemplatesKey(courseId),
    enabled: courseId !== null,
    queryFn: () => api(`/app/api/courses/${courseId}/templates`),
  });
}

/** The names of the items a refusal or a warning is about, in order. */
const itemNames = (items: readonly TemplateItemRef[]) =>
  items.map((i) => i.internalName).join(", ");

/**
 * What a copy refused for its unlinked pools says (`422 template_pool_unlinked`),
 * translated from its machine half — an "Instantiate" or a "Duplicate".
 */
function instantiateError(error: unknown, t: TFunction): string | null {
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
    <p className="text-[13px] text-danger">{message}</p>
  ) : (
    <FormError error={error} fallback={t("templates.createFailed")} />
  );
}

function UseTemplateDialog({
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
    </FormDialog>
  );
}

/**
 * The templates of one course, as a section of its page. Each row offers
 * what a template is for — a new evaluation in one of the course's classrooms
 * — and its deletion; two actions, so two icon buttons (`Actions`).
 */
export function CourseTemplates({
  courseId,
  classrooms,
  navigate,
}: {
  courseId: string;
  classrooms: ClassroomSummary[];
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toastError = useErrorToast();
  const list = useCourseTemplates(courseId);
  const [using, setUsing] = useState<EvaluationTemplate | null>(null);

  const remove = useMutation({
    mutationFn: (template: EvaluationTemplate) =>
      api(`/app/api/templates/${template.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: courseTemplatesKey(courseId) }),
    onError: toastError("error.save"),
  });

  const templates = list.data ?? [];
  return (
    <CoursePart page icon={FileStack} title={t("templates.title")}>
      {list.isLoading ? (
        <Skeleton className="h-6 w-64" />
      ) : list.isError ? (
        <QueryError
          title={t("templates.title")}
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : templates.length === 0 ? (
        // No button: until a template can be written here (A2), the one door
        // is an evaluation's menu, and the empty state says where it is.
        <EmptyState icon={FileStack} title={t("templates.empty.title")} className="py-8">
          {t("templates.empty.body")}
        </EmptyState>
      ) : (
        <ul className="space-y-0.5">
          {templates.map((template) => (
            <li key={template.id} className="flex items-center gap-2 px-2 py-1 text-[13px]">
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
              <Actions
                label={t("common.actions")}
                size="sm"
                items={[
                  ...(classrooms.length > 0
                    ? [{ label: t("templates.use"), icon: CopyPlus, onSelect: () => setUsing(template) }]
                    : []),
                  {
                    label: t("templates.delete"),
                    icon: Trash2,
                    danger: true,
                    onSelect: async () => {
                      if (
                        await confirm({
                          title: t("templates.delete"),
                          message: t("templates.deleteConfirm", { name: template.title }),
                          confirmLabel: t("common.delete"),
                          cancelLabel: t("common.cancel"),
                          danger: true,
                        })
                      ) {
                        remove.mutate(template);
                      }
                    },
                  },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {using ? (
        <UseTemplateDialog
          template={using}
          classrooms={classrooms}
          onClose={() => setUsing(null)}
          navigate={navigate}
        />
      ) : null}
    </CoursePart>
  );
}

/** "Save as template", from an evaluation's menu. */
export function SaveAsTemplateDialog({
  evaluationId,
  title: initialTitle,
  course,
  onClose,
}: {
  evaluationId: string;
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
      await qc.invalidateQueries({ queryKey: courseTemplatesKey(course.id) });
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
