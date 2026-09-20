import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Library, Link2, Plus, School, Trash2, Unlink, UserPlus, Users } from "lucide-react";
import { useState } from "react";

import type { CourseDetail, CourseSummary, PoolSummary } from "@quiz/contracts";

import { api, apiErrorMessage } from "./api";
import { useConfirm } from "./confirm";
import { useT } from "./i18n";
import type { Route } from "./router";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Initials,
  Menu,
  Modal,
  PageHeader,
  Select,
  QueryError,
  SectionHeading,
  Skeleton,
  Spinner,
} from "./ui";

/**
 * Teacher home: the courses.
 *
 * The ONE primary action of this page is "New course"; everything a course
 * card offers (a classroom, a colleague, deletion) is secondary, because a
 * teacher arriving here with nothing must be shown one door, not five.
 */

function NewCourseModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", code: "" });
  const create = useMutation({
    mutationFn: () =>
      api("/app/api/courses", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["courses"] });
      onClose();
    },
  });
  return (
    <Modal
      title={t("courses.new")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={form.name.trim() === "" || form.code.trim() === ""}
          >
            {t("courses.newAction")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
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
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
        />
        {create.isError ? (
          <p className="text-[13px] text-danger">
            {apiErrorMessage(create.error, t("courses.createFailed"))}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function NewClassroomModal({ course, onClose }: { course: CourseSummary; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", period: "" });
  const create = useMutation({
    mutationFn: () =>
      api(`/app/api/courses/${course.id}/classrooms`, {
        method: "POST",
        body: JSON.stringify(form),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["courses"] });
      onClose();
    },
  });
  return (
    <Modal
      title={t("classrooms.new")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={form.name.trim() === ""}
          >
            {t("common.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label={t("classrooms.name")}
          required
          fullWidth
          autoFocus
          placeholder={t("classrooms.namePlaceholder")}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Field
          label={t("classrooms.period")}
          fullWidth
          placeholder={t("classrooms.periodPlaceholder")}
          value={form.period}
          onChange={(e) => setForm({ ...form, period: e.target.value })}
        />
        {create.isError ? (
          <p className="text-[13px] text-danger">
            {apiErrorMessage(create.error, t("courses.createFailed"))}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function AddStaffModal({ course, onClose }: { course: CourseSummary; onClose: () => void }) {
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
      await qc.invalidateQueries({ queryKey: ["courses"] });
      onClose();
    },
  });
  return (
    <Modal
      title={t("courses.staffAdd")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => add.mutate()} loading={add.isPending} disabled={email.trim() === ""}>
            {t("import.add")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
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
        {add.isError ? (
          <p className="text-[13px] text-danger">
            {apiErrorMessage(add.error, t("courses.staffUnknown"))}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * The pools a course draws from (F-POOL-05). `PUT /courses/:id/pools`
 * replaces the WHOLE set in one call, so both the link and the unlink send
 * the list the course should end up with — there is no add/remove route, and
 * inventing one on the client would be a second way to do one thing.
 */
function CoursePools({
  course,
  navigate,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [linking, setLinking] = useState(false);
  const [poolId, setPoolId] = useState("");

  const detail = useQuery<CourseDetail>({
    queryKey: ["course", course.id],
    queryFn: () => api(`/app/api/courses/${course.id}`),
  });
  const pools = useQuery<PoolSummary[]>({
    queryKey: ["pools"],
    queryFn: () => api("/app/api/pools"),
  });

  const linked = detail.data?.pools ?? [];
  const available = (pools.data ?? []).filter((p) => !linked.some((l) => l.id === p.id));

  const setLinks = useMutation({
    mutationFn: (poolIds: string[]) =>
      api(`/app/api/courses/${course.id}/pools`, {
        method: "PUT",
        body: JSON.stringify({ poolIds }),
      }),
    onSuccess: async () => {
      setLinking(false);
      setPoolId("");
      await qc.invalidateQueries({ queryKey: ["course", course.id] });
    },
  });

  const unlink = async (pool: { id: string; name: string }) => {
    const ok = await confirm({
      title: t("pools.unlink"),
      message: t("pools.unlinkConfirm", { name: pool.name, course: course.name }),
      confirmLabel: t("pools.unlink"),
      cancelLabel: t("common.cancel"),
    });
    if (ok) setLinks.mutate(linked.filter((l) => l.id !== pool.id).map((l) => l.id));
  };

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
          {t("pools.link")}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setLinking(true)}>
          <Link2 /> {t("pools.linkAction")}
        </Button>
      </div>
      {detail.isLoading ? (
        <Skeleton className="mt-2 h-6 w-48" />
      ) : linked.length === 0 ? (
        <p className="mt-1 text-[13px] text-fg-muted">{t("pools.linkNone")}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {linked.map((pool) => (
            <li key={pool.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigate({ view: "pool", id: pool.id })}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2 py-1 text-left text-[13px] transition-colors hover:bg-surface-2"
              >
                <FolderTree className="size-3.5 shrink-0 text-fg-faint" />
                <span className="min-w-0 flex-1 truncate font-medium">{pool.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                  {t(pool.questionCount === 1 ? "pools.questions.one" : "pools.questions", {
                    n: pool.questionCount,
                  })}
                </span>
              </button>
              <Menu
                label={t("common.actions")}
                items={[
                  { label: t("pools.unlink"), icon: Unlink, danger: true, onSelect: () => void unlink(pool) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}

      {linking ? (
        <Modal
          title={t("pools.linkAction")}
          onClose={() => setLinking(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setLinking(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                loading={setLinks.isPending}
                disabled={poolId === ""}
                onClick={() => setLinks.mutate([...linked.map((l) => l.id), poolId])}
              >
                {t("pools.linkAction")}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <Select
              label={t("pools.linkPick")}
              value={poolId}
              onChange={(e) => setPoolId(e.target.value)}
            >
              <option value="">—</option>
              {available.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.name}
                </option>
              ))}
            </Select>
            {setLinks.isError ? (
              <p className="text-[13px] text-danger">
                {apiErrorMessage(setLinks.error, t("pools.linkSaveFailed"))}
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function CourseCard({
  course,
  navigate,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [newRoom, setNewRoom] = useState(false);
  const [newStaff, setNewStaff] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["courses"] });
  const removeCourse = useMutation({
    mutationFn: () => api(`/app/api/courses/${course.id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const removeStaff = useMutation({
    mutationFn: (userId: string) =>
      api(`/app/api/courses/${course.id}/staff/${userId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  return (
    <Card className="p-5">
      <SectionHeading
        icon={Library}
        title={
          <span className="flex items-baseline gap-2">
            {course.name}
            <span className="text-[13px] font-normal text-fg-faint">{course.code}</span>
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setNewRoom(true)}>
              <Plus /> {t("classrooms.new")}
            </Button>
            <Menu
              label={t("common.actions")}
              items={[
                {
                  label: t("courses.staffAdd"),
                  icon: UserPlus,
                  onSelect: () => setNewStaff(true),
                },
                ...course.staff.map((s) => ({
                  label: t("courses.staffRemove") + ` — ${s.givenName} ${s.familyName}`,
                  icon: Users,
                  onSelect: async () => {
                    if (
                      await confirm({
                        title: t("courses.staffRemoveConfirm", {
                          name: `${s.givenName} ${s.familyName}`,
                          course: course.name,
                        }),
                        confirmLabel: t("courses.staffRemove"),
                        cancelLabel: t("common.cancel"),
                      })
                    ) {
                      removeStaff.mutate(s.userId);
                    }
                  },
                })),
                {
                  label: t("courses.delete"),
                  icon: Trash2,
                  danger: true,
                  separator: true,
                  onSelect: async () => {
                    if (
                      await confirm({
                        title: t("courses.deleteConfirm", { name: course.name }),
                        confirmLabel: t("common.delete"),
                        cancelLabel: t("common.cancel"),
                        danger: true,
                      })
                    ) {
                      removeCourse.mutate();
                    }
                  },
                },
              ]}
            />
          </>
        }
      />

      <div className="mt-4 space-y-1.5">
        {course.classrooms.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("classrooms.empty")}</p>
        ) : (
          course.classrooms.map((room) => (
            <button
              key={room.id}
              type="button"
              onClick={() => navigate({ view: "classroom", id: room.id })}
              className="flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
            >
              <School className="size-4 shrink-0 text-fg-faint" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{room.name}</span>
              {room.period ? (
                <span className="shrink-0 text-xs text-fg-faint">{room.period}</span>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                {t(room.students === 1 ? "classrooms.students.one" : "classrooms.students", {
                  n: room.students,
                })}
              </span>
            </button>
          ))
        )}
      </div>

      {course.staff.length > 0 ? (
        <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            {t("courses.staff")}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {course.staff.map((s) =>
              s.avatarUrl ? (
                <img
                  key={s.userId}
                  src={s.avatarUrl}
                  alt={`${s.givenName} ${s.familyName}`}
                  title={`${s.givenName} ${s.familyName}`}
                  className="size-6 rounded-full object-cover"
                />
              ) : (
                <span key={s.userId} title={`${s.givenName} ${s.familyName}`}>
                  <Initials name={[s.givenName, s.familyName]} className="size-6 text-[10px]" />
                </span>
              ),
            )}
          </div>
        </div>
      ) : null}

      <CoursePools course={course} navigate={navigate} />

      {newRoom ? <NewClassroomModal course={course} onClose={() => setNewRoom(false)} /> : null}
      {newStaff ? <AddStaffModal course={course} onClose={() => setNewStaff(false)} /> : null}
    </Card>
  );
}

export function TeacherHome({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const courses = useQuery<CourseSummary[]>({
    queryKey: ["courses"],
    queryFn: () => api("/app/api/courses"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("courses.title")}
        description={t("courses.subtitle")}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> {t("courses.new")}
          </Button>
        }
      />

      {courses.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : courses.isError ? (
        <QueryError
          title={t("courses.title")}
          error={courses.error}
          onRetry={() => void courses.refetch()}
          retrying={courses.isFetching}
          fallback={t("error.server")}
        />
      ) : (courses.data ?? []).length === 0 ? (
        <EmptyState
          icon={Library}
          title={t("courses.empty.title")}
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("courses.new")}
            </Button>
          }
        >
          {t("courses.empty.body")}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {courses.data!.map((c) => (
            <CourseCard key={c.id} course={c} navigate={navigate} />
          ))}
        </div>
      )}

      {courses.isFetching && !courses.isLoading ? <Spinner className="py-2" /> : null}
      {creating ? <NewCourseModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
