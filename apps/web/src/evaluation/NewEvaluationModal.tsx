import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { EvaluationSummary } from "@quiz/contracts";

import { api } from "../api";
import { useClassroom } from "../course/parts";
import { useT } from "../i18n";
import { evaluationsKey } from "../queryKeys";
import { Field, FormDialog, FormError, Select } from "../ui";
import { ModeChoice, type CreatedMode } from "./ModeChoice";
import { InstantiateError, useCourseTemplates, useInstantiate } from "./templates";

/**
 * The "New evaluation" dialog of a classroom, opened by the page header's
 * "New ▾" and by the Activities tab's empty state: a title and a mode, or a
 * template of the course to start from (ADR-031).
 */
export function NewEvaluationModal({
  classroomId,
  onClose,
  onCreated,
}: {
  classroomId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<CreatedMode>("exam");
  /*
   * "Start from a template" (ADR-031) exists only when the course has one:
   * the classroom names its course, the course lists its templates, and a
   * course with none leaves this dialog exactly as it was (08, novice path).
   */
  const classroom = useClassroom(classroomId);
  const templates = useCourseTemplates(classroom.data?.course.id ?? null).data ?? [];
  const [templateId, setTemplateId] = useState("");
  const template = templates.find((x) => x.id === templateId) ?? null;

  const create = useMutation({
    mutationFn: () =>
      api<EvaluationSummary>(`/app/api/classrooms/${classroomId}/evaluations`, {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), mode, preset: mode }),
      }),
    onSuccess: async (row) => {
      await qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) });
      onCreated(row.id);
    },
  });
  const instantiate = useInstantiate(onCreated);
  return (
    <FormDialog
      title={t("eval.new")}
      onClose={onClose}
      onSubmit={() =>
        template ? instantiate.mutate({ template, classroomId, title }) : create.mutate()
      }
      submitLabel={t("eval.create")}
      submitting={create.isPending || instantiate.isPending}
      canSubmit={title.trim() !== ""}
      error={
        template ? (
          <InstantiateError error={instantiate.error} />
        ) : (
          <FormError error={create.error} title={t("eval.createFailed")} />
        )
      }
    >
      {templates.length > 0 ? (
        <Select
          label={t("templates.startFrom")}
          value={templateId}
          onChange={(e) => {
            const next = templates.find((x) => x.id === e.target.value);
            setTemplateId(e.target.value);
            // The template's title is the obvious name; one typed already stays.
            if (next && title.trim() === "") setTitle(next.title);
          }}
        >
          <option value="">{t("templates.blank")}</option>
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </Select>
      ) : null}
      <Field
        label={t("eval.titleLabel")}
        placeholder={t("eval.titlePlaceholder")}
        required
        fullWidth
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      {template ? (
        <p className="text-[13px] text-fg-muted">{t("templates.useHelp", { mode: t(`eval.mode.${template.mode}`) })}</p>
      ) : (
        <ModeChoice value={mode} onChange={setMode} />
      )}
    </FormDialog>
  );
}

