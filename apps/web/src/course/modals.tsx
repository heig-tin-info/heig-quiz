import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ClassroomCreate, type CourseSummary } from "@quiz/contracts";

import { api } from "../api";
import { newPeriodDraft, PeriodFields, periodBody, periodInvalid } from "../ClassroomPeriod";
import { useT } from "../i18n";
import { Field, FormDialog, FormError } from "../ui";
import { coursesKey } from "../queryKeys";

/**
 * The three short forms around a course, each in a `Modal` because none has
 * more than three fields: a new course (the Courses home's one primary
 * action), a new classroom in a course, and a colleague on its staff. All
 * three refresh the course list, which is where their result is read.
 */

export function NewCourseModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", code: "" });
  const create = useMutation({
    mutationFn: () =>
      api("/app/api/courses", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: coursesKey });
      onClose();
    },
  });
  return (
    <FormDialog
      title={t("courses.new")}
      onClose={onClose}
      onSubmit={() => create.mutate()}
      submitLabel={t("courses.newAction")}
      submitting={create.isPending}
      canSubmit={form.name.trim() !== "" && form.code.trim() !== ""}
      error={<FormError error={create.error} fallback={t("courses.createFailed")} />}
    >
      <Field
        label={t("courses.name")}
        required
        fullWidth
        autoFocus
        placeholder={t("courses.namePlaceholder")}
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <Field
        label={t("courses.code")}
        required
        fullWidth
        placeholder={t("courses.codePlaceholder")}
        description={t("courses.codeHint")}
        value={form.code}
        onChange={(e) => setForm({ ...form, code: e.target.value })}
      />
    </FormDialog>
  );
}

export function NewClassroomModal({ course, onClose }: { course: CourseSummary; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [period, setPeriod] = useState(() => newPeriodDraft(new Date(), t));
  const body = ClassroomCreate.safeParse({ name: name.trim(), ...periodBody(period) });
  const create = useMutation({
    mutationFn: () =>
      api(`/app/api/courses/${course.id}/classrooms`, {
        method: "POST",
        body: JSON.stringify(body.data),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: coursesKey });
      onClose();
    },
  });
  return (
    <FormDialog
      title={t("classrooms.new")}
      onClose={onClose}
      onSubmit={() => create.mutate()}
      submitLabel={t("common.create")}
      submitting={create.isPending}
      canSubmit={body.success}
      error={<FormError error={create.error} fallback={t("courses.createFailed")} />}
    >
      <Field
        label={t("classrooms.name")}
        required
        fullWidth
        autoFocus
        placeholder={t("classrooms.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <PeriodFields value={period} onChange={setPeriod} invalid={periodInvalid(body)} />
    </FormDialog>
  );
}

export function AddStaffModal({ course, onClose }: { course: CourseSummary; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api(`/app/api/courses/${course.id}/staff`, {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: coursesKey });
      onClose();
    },
  });
  return (
    <FormDialog
      title={t("courses.staffAdd")}
      onClose={onClose}
      onSubmit={() => add.mutate()}
      submitLabel={t("import.add")}
      submitting={add.isPending}
      canSubmit={email.trim() !== ""}
      dense
      error={<FormError error={add.error} fallback={t("courses.staffUnknown")} />}
    >
      <Field
        label={t("courses.staffEmail")}
        required
        type="email"
        fullWidth
        autoFocus
        placeholder="prenom.nom@heig-vd.ch"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
    </FormDialog>
  );
}
