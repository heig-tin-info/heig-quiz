import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  ClassroomCreate,
  CourseCreate,
  type CoursePatch,
  type CourseRole,
  type CourseSummary,
  type StaffAdd,
} from "@quiz/contracts";

import { api } from "../api";
import { newPeriodDraft, PeriodFields, periodBody, periodInvalid } from "../ClassroomPeriod";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { invalidateHint } from "../realtime/hints";
import { Field, FieldLabel, FormDialog, FormError, Segmented } from "../ui";
import { coursesKey } from "../queryKeys";

/**
 * The short forms around a course, each in a `Modal` because none has more
 * than three fields: a new course (the Courses home's one primary action),
 * its name and code (its Settings tab), a new classroom in a course, and a
 * colleague on its staff. All refresh the course list, which is where their
 * result is read.
 */

export function NewCourseModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <CourseFormModal
      title={t("courses.new")}
      submitLabel={t("courses.newAction")}
      fallback={t("courses.createFailed")}
      initial={{ name: "", code: "" }}
      save={(course) => api("/app/api/courses", { method: "POST", body: JSON.stringify(course) })}
      onClose={onClose}
    />
  );
}

/**
 * The course's name and code, from its Settings tab. The code is unique
 * across the instance and printed in the exports, so a code another course
 * holds is refused (409 `duplicate_code`) and said here; only what changed is
 * sent.
 */
export function EditCourseModal({ course, onClose }: { course: CourseSummary; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  return (
    <CourseFormModal
      title={t("courses.settings.editTitle")}
      submitLabel={t("common.save")}
      fallback={t("error.save")}
      initial={course}
      changed={(next) => next.name !== course.name || next.code !== course.code}
      save={(next) =>
        api(`/app/api/courses/${course.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...(next.name !== course.name ? { name: next.name } : {}),
            ...(next.code !== course.code ? { code: next.code } : {}),
          } satisfies CoursePatch),
        })
      }
      onSaved={() => toast(t("courses.settings.saved"), "success")}
      onClose={onClose}
    />
  );
}

/**
 * The one form of a course, its name and its code, for its creation and its
 * edit. `CourseCreate` trims and upper-cases the code, so what `changed` and
 * `save` receive is what the server will store.
 */
function CourseFormModal({
  title,
  submitLabel,
  fallback,
  initial,
  changed = () => true,
  save,
  onSaved,
  onClose,
}: {
  title: string;
  submitLabel: string;
  fallback: string;
  initial: { name: string; code: string };
  changed?: (course: CourseCreate) => boolean;
  save: (course: CourseCreate) => Promise<unknown>;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: initial.name, code: initial.code });
  const parsed = CourseCreate.safeParse(form);
  const mutation = useMutation({
    mutationFn: () => save(parsed.data!),
    // The name and the code are in the sidebar, on the course cards and in
    // every classroom's eyebrow: every family a `courses` hint refreshes.
    onSuccess: async () => {
      await invalidateHint(qc, ["courses"]);
      onSaved?.();
      onClose();
    },
  });
  return (
    <FormDialog
      title={title}
      onClose={onClose}
      onSubmit={() => mutation.mutate()}
      submitLabel={submitLabel}
      submitting={mutation.isPending}
      canSubmit={parsed.success && changed(parsed.data)}
      error={<FormError error={mutation.error} fallback={fallback} />}
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

/**
 * A colleague named by the address they sign in with, and their role
 * (ADR-068): an assistant unless the owner says otherwise — the weaker role
 * is the one a slip of the hand can give.
 */
export function AddStaffModal({ course, onClose }: { course: CourseSummary; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CourseRole>("assistant");
  const add = useMutation({
    mutationFn: () => {
      const body: StaffAdd = { email: email.trim(), role };
      return api(`/app/api/courses/${course.id}/staff`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
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
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5">
          <FieldLabel>{t("courses.staffRole")}</FieldLabel>
        </legend>
        <Segmented
          name="staff-role"
          label={t("courses.staffRole")}
          value={role}
          onChange={setRole}
          options={[
            { value: "assistant", label: t("courses.role.assistant") },
            { value: "owner", label: t("courses.role.owner") },
          ]}
        />
        <p className="text-xs text-fg-muted">{t(`courses.role.desc.${role}`)}</p>
      </fieldset>
    </FormDialog>
  );
}
