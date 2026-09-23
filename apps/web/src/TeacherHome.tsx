import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FolderTree,
  LayoutGrid,
  Library,
  Link2,
  List,
  Plus,
  School,
  Trash2,
  Unlink,
  UserPlus,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { CourseDetail, CourseSummary, PoolSummary } from "@quiz/contracts";

import { api } from "./api";
import { useConfirm } from "./confirm";
import { useT } from "./i18n";
import { useErrorToast } from "./notify";
import type { Route } from "./router";
import {
  Button,
  Card,
  EmptyState,
  Field,
  FormDialog,
  FormError,
  Menu,
  type MenuItem,
  PageHeader,
  PersonAvatar,
  QueryError,
  SectionHeading,
  Segmented,
  Skeleton,
  Spinner,
  T,
} from "./ui";
import { courseKey, coursesKey, poolsKey } from "./queryKeys";

/**
 * Teacher home: the courses.
 *
 * The ONE primary action of this page is "New course"; everything a course
 * card offers (a classroom, a colleague, deletion) is secondary, because a
 * teacher arriving here with nothing must be shown one door, not five.
 *
 * Two readings of the same list: cards, which give each course room for its
 * classrooms and its pools, and a table, which answers "which classroom, in
 * which course" in one scan once a teacher has a dozen of them. The choice is
 * the reader's and is remembered, because it is a habit and not a state of
 * the data.
 */

type CoursesView = "cards" | "list";

const VIEW_KEY = "quiz-courses-view";

function useCoursesView(): [CoursesView, (v: CoursesView) => void] {
  const [view, setView] = useState<CoursesView>(() =>
    localStorage.getItem(VIEW_KEY) === "list" ? "list" : "cards",
  );
  return [
    view,
    (v) => {
      localStorage.setItem(VIEW_KEY, v);
      setView(v);
    },
  ];
}

function NewCourseModal({ onClose }: { onClose: () => void }) {
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
        value={form.code}
        onChange={(e) => setForm({ ...form, code: e.target.value })}
      />
    </FormDialog>
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
      canSubmit={form.name.trim() !== ""}
      error={<FormError error={create.error} fallback={t("courses.createFailed")} />}
    >
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
    </FormDialog>
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
  const toastError = useErrorToast();

  const detail = useQuery<CourseDetail>({
    queryKey: courseKey(course.id),
    queryFn: () => api(`/app/api/courses/${course.id}`),
  });
  const pools = useQuery<PoolSummary[]>({
    queryKey: poolsKey,
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
      await qc.invalidateQueries({ queryKey: courseKey(course.id) });
    },
    // The menu is closed by the time the call answers, so the failure has
    // nowhere to render but a toast (DESIGN.md › Menu).
    onError: toastError("pools.linkSaveFailed"),
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
        {/* One click, no dialog: linking a pool is picking a name out of a
            short list, and a modal with a select and two buttons was three
            interactions for one decision. */}
        <div className="ml-auto">
          <Menu
            label={t("pools.linkAction")}
            trigger={
              <Button size="sm" variant="ghost">
                <Link2 /> {t("pools.linkAction")}
              </Button>
            }
            items={
              available.length > 0
                ? available.map((pool) => ({
                    label: pool.name,
                    icon: FolderTree,
                    onSelect: () => setLinks.mutate([...linked.map((l) => l.id), pool.id]),
                  }))
                : [{ label: t("pools.linkEmpty"), disabled: true }]
            }
          />
        </div>
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

    </div>
  );
}

/**
 * What a course offers beyond being opened: a classroom, a colleague, its own
 * deletion. The card and the table row of the list view share this ONE copy,
 * so the two readings of the same list cannot offer different things; the
 * hook owns the two dialogs those items open as well.
 */
function useCourseActions(course: CourseSummary): {
  items: MenuItem[];
  newClassroom: () => void;
  dialogs: ReactNode;
} {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [newRoom, setNewRoom] = useState(false);
  const [newStaff, setNewStaff] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: coursesKey });
  const removeCourse = useMutation({
    mutationFn: () => api(`/app/api/courses/${course.id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const removeStaff = useMutation({
    mutationFn: (userId: string) =>
      api(`/app/api/courses/${course.id}/staff/${userId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  return {
    newClassroom: () => setNewRoom(true),
    items: [
      {
        label: t("courses.staffAdd"),
        icon: UserPlus,
        onSelect: () => setNewStaff(true),
      },
      // The server refuses to empty a staff (409 `last_staff`); a menu item
      // that can only fail is not offered at all.
      ...(course.staff.length <= 1 ? [] : course.staff).map((s) => ({
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
    ],
    dialogs: (
      <>
        {newRoom ? <NewClassroomModal course={course} onClose={() => setNewRoom(false)} /> : null}
        {newStaff ? <AddStaffModal course={course} onClose={() => setNewStaff(false)} /> : null}
      </>
    ),
  };
}

/** The staff of a course as a row of avatars, the same in both views. */
function StaffAvatars({ course }: { course: CourseSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {course.staff.map((s) => (
        <PersonAvatar
          key={s.userId}
          name={[s.givenName, s.familyName]}
          src={s.avatarUrl}
          label={`${s.givenName} ${s.familyName}`}
          className="size-6 text-[10px]"
        />
      ))}
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
  const { items, newClassroom, dialogs } = useCourseActions(course);

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
            <Button size="sm" variant="secondary" onClick={newClassroom}>
              <Plus /> {t("classrooms.new")}
            </Button>
            <Menu label={t("common.actions")} items={items} />
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
          <StaffAvatars course={course} />
        </div>
      ) : null}

      <CoursePools course={course} navigate={navigate} />

      {dialogs}
    </Card>
  );
}

/**
 * One course as a table row: its identity, the classrooms it holds — each a
 * link, because that is what a teacher came for — and its staff. The pools of
 * a course are a card affair; the table answers "which classroom, where".
 */
function CourseRow({
  course,
  navigate,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const { items, dialogs } = useCourseActions(course);
  return (
    <tr className={T.row}>
      <td className={T.td}>
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold">{course.name}</span>
          <span className="text-xs text-fg-faint">{course.code}</span>
        </span>
      </td>
      <td className={T.td}>
        {course.classrooms.length === 0 ? (
          <span className="text-fg-faint">—</span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {course.classrooms.map((room) => (
              <button
                key={room.id}
                type="button"
                onClick={() => navigate({ view: "classroom", id: room.id })}
                className="rounded-[10px] px-1.5 py-0.5 font-medium transition-colors hover:bg-surface-2 hover:underline"
              >
                <School className="mr-1 inline size-3.5 text-fg-faint" />
                {room.name}
              </button>
            ))}
          </span>
        )}
      </td>
      <td className={T.td}>
        {course.staff.length === 0 ? (
          <span className="text-fg-faint">—</span>
        ) : (
          <StaffAvatars course={course} />
        )}
      </td>
      <td className={`${T.td} w-10 text-right`}>
        <Menu label={t("common.actions")} items={items} />
        {dialogs}
      </td>
    </tr>
  );
}

export function TeacherHome({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [view, setView] = useCoursesView();
  const courses = useQuery<CourseSummary[]>({
    queryKey: coursesKey,
    queryFn: () => api("/app/api/courses"),
  });
  const rows = courses.data ?? [];

  /**
   * Two icons and no words: the choice is between two pictures of the same
   * list, and a pair of labels beside them would weigh more than the switch
   * itself. The name stays, for the pointer and for the screen reader.
   */
  const viewOption = (value: "cards" | "list", icon: ReactNode, label: string) => ({
    value,
    label: (
      <span title={label} className="flex items-center">
        {icon}
        <span className="sr-only">{label}</span>
      </span>
    ),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("courses.title")}
        description={t("courses.subtitle")}
        help="courses"
        actions={
          // Not while the list is empty: the empty state below carries the
          // same action, and two accent fills of the SAME action on one
          // screen is noise, not emphasis (W19). One button, in the place
          // the reader is already looking.
          rows.length > 0 ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("courses.new")}
            </Button>
          ) : undefined
        }
      />

      {/* Under the header and hard right: it changes how the list below is
          drawn, so it belongs to the list, not to the title. */}
      {rows.length > 0 && !courses.isError ? (
        <div className="flex justify-end">
          <Segmented
            name="courses-view"
            value={view}
            onChange={setView}
            options={[
              viewOption("cards", <LayoutGrid className="size-4" />, t("view.cards")),
              viewOption("list", <List className="size-4" />, t("view.list")),
            ]}
          />
        </div>
      ) : null}

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
      ) : rows.length === 0 ? (
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
      ) : view === "list" ? (
        <Card className="overflow-hidden">
          <table className={T.table}>
            <thead className={T.head}>
              <tr>
                <th className={T.th}>{t("courses.name")}</th>
                <th className={T.th}>{t("classrooms.title")}</th>
                <th className={T.th}>{t("courses.staff")}</th>
                <th className={`${T.th} w-10`}>
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <CourseRow key={c.id} course={c} navigate={navigate} />
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((c) => (
            <CourseCard key={c.id} course={c} navigate={navigate} />
          ))}
        </div>
      )}

      {courses.isFetching && !courses.isLoading ? <Spinner className="py-2" /> : null}
      {creating ? <NewCourseModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
