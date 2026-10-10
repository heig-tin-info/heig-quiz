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

import { api, wordedRefusal } from "../api";
import { newPeriodDraft, PeriodFields, periodBody, periodInvalid } from "../ClassroomPeriod";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { invalidateHint } from "../realtime/hints";
import { IconField } from "../pool/IconField";
import { PoolIconPicker } from "../pool/PoolIconPicker";
import { DEFAULT_COURSE_ICON } from "../pool/poolIcons";
import { TeacherPicker, useTeacherPick } from "../TeacherPicker";
import { Field, FieldLabel, FormDialog, FormError, Segmented } from "../ui";
import { courseStaffCandidatesKey, coursesKey } from "../queryKeys";
import { CourseIcon } from "./CourseIcon";

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
      initial={{ name: "", code: "", icon: null, color: null }}
      save={(course) => api("/app/api/courses", { method: "POST", body: JSON.stringify(course) })}
      onClose={onClose}
    />
  );
}

/**
 * The course's name, code and icon, from its Settings tab. The code is unique
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
      changed={(next) => Object.keys(patchOf(course, next)).length > 0}
      save={(next) =>
        api(`/app/api/courses/${course.id}`, {
          method: "PATCH",
          body: JSON.stringify(patchOf(course, next)),
        })
      }
      onSaved={() => toast(t("courses.settings.saved"), "success")}
      onClose={onClose}
    />
  );
}

/** What an edit changes, field by field: only that is sent. */
const patchOf = (course: CourseSummary, next: CourseCreate): CoursePatch => {
  const keys = Object.keys(CourseCreate.shape) as (keyof CourseCreate)[];
  return Object.fromEntries(keys.filter((k) => next[k] !== course[k]).map((k) => [k, next[k]])) as CoursePatch;
};

/**
 * The one form of a course, its name, its code and its icon, for its creation
 * and its edit. The icon is picked as a pool's is (`PoolFormModal`): the tile
 * beside the name opens the picker in the same dialog, picking comes back.
 * `CourseCreate` trims and upper-cases the code, so what `changed` and
 * `save` receive is what the server will store, and what the preview shows as
 * the sidebar will.
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
  initial: Pick<CourseSummary, "name" | "code" | "icon" | "color">;
  changed?: (course: CourseCreate) => boolean;
  save: (course: CourseCreate) => Promise<unknown>;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState(initial);
  const [picking, setPicking] = useState(false);
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
  if (picking) {
    return (
      <PoolIconPicker
        value={form.icon}
        color={form.color}
        hint={t("courses.icon.hint")}
        fallback={DEFAULT_COURSE_ICON}
        onColor={(color) => setForm({ ...form, color })}
        onPick={(icon) => {
          setForm({ ...form, icon });
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    );
  }
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
      <IconField onPick={() => setPicking(true)} icon={<CourseIcon course={form} className="size-4.5" />}>
        <Field
          label={t("courses.name")}
          required
          className="min-w-0"
          width="min-w-0 flex-1"
          autoFocus
          placeholder={t("courses.namePlaceholder")}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </IconField>
      <Field
        label={t("courses.code")}
        required
        fullWidth
        placeholder={t("courses.codePlaceholder")}
        description={t("courses.codeHint")}
        value={form.code}
        onChange={(e) => setForm({ ...form, code: e.target.value })}
      />
      {parsed.success && (
        <p className="text-[13px] text-fg-muted">
          {t("courses.codePreview")}{" "}
          <span className="font-medium text-fg">
            {t("nav.classroomCourse", { code: parsed.data.code, name: parsed.data.name })}
          </span>
        </p>
      )}
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

/** The refusals of `POST /courses/:id/staff`, worded for the dialog. */
const STAFF_REFUSALS = {
  unknown_account: "courses.staffUnknown",
  ambiguous_account: "courses.staffAmbiguous",
  already_staff: "error.alreadyStaff",
} as const;

/**
 * A colleague picked by name among the teachers not on the staff yet
 * (`TeacherPicker`), and their role (ADR-068): an assistant unless the
 * owner says otherwise — the weaker role is the one a slip of the hand can
 * give. An address nobody was picked from may still be typed and sent as
 * such, as in a pool's share sheet: the API resolves it over every address
 * of an account (GH-11).
 */
export function AddStaffModal({ course, onClose }: { course: CourseSummary; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const who = useTeacherPick();
  const [role, setRole] = useState<CourseRole>("assistant");
  const add = useMutation({
    mutationFn: () => {
      const body: StaffAdd = { ...who.choice!, role };
      return api(`/app/api/courses/${course.id}/staff`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: coursesKey }),
        // The newcomer leaves the list of who may still be added.
        qc.invalidateQueries({ queryKey: courseStaffCandidatesKey(course.id) }),
      ]);
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
      canSubmit={who.choice !== null}
      dense
      error={<FormError error={add.error} describe={(error) => wordedRefusal(error, STAFF_REFUSALS, t)} />}
    >
      <TeacherPicker
        candidatesKey={courseStaffCandidatesKey(course.id)}
        candidatesUrl={`/app/api/courses/${course.id}/staff/candidates`}
        label={t("courses.staffPerson")}
        everyoneSeated={t("courses.staffEveryoneSeated")}
        disabled={add.isPending}
        autoFocus
        {...who.picker}
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
