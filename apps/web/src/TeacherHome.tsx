import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Eye,
  EyeOff,
  FolderTree,
  LayoutGrid,
  Library,
  Link2,
  List,
  Plus,
  School,
  Trash2,
  Unlink,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  ClassroomCreate,
  type CourseDetail,
  type CourseSummary,
  type EvaluationTemplate,
  type PoolSummary,
} from "@quiz/contracts";

import { api } from "./api";
import { newPeriodDraft, PeriodFields, periodBody, periodInvalid } from "./ClassroomPeriod";
import { useConfirm } from "./confirm";
import { inNavigation } from "./CourseNav";
import { useT } from "./i18n";
import { useErrorToast, useToast } from "./notify";
import type { Route } from "./router";
import {
  Actions,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  FormDialog,
  FormError,
  Menu,
  type MenuItem,
  PageHeader,
  PeopleStack,
  type Person,
  QueryError,
  SectionHeading,
  Segmented,
  Skeleton,
  Spinner,
  T,
  TableHead,
  ToggleChip,
  type Column,
  usePersistentChoice,
  useSortableTable,
} from "./ui";
import { courseKey, coursesKey, courseTemplatesKey, poolsKey } from "./queryKeys";
import { CourseTemplates } from "./evaluation/templates";

/**
 * Teacher home: the courses.
 *
 * The ONE primary action of this page is "New course"; everything a course
 * card offers (a classroom, a colleague, deletion) is secondary, because a
 * teacher arriving here with nothing must be shown one door, not five.
 *
 * Two readings of the same list: cards, which give each course room for its
 * classrooms and its pools, and a table, which answers "which classroom, in
 * which course" in one scan once a teacher has a dozen of them and sorts by
 * any of its three columns. The choice is the reader's and is remembered,
 * because it is a habit and not a state of the data.
 *
 * The staff is read on the title line, as a row of discs, and everything
 * about ONE colleague — their address, their seat — waits inside the disc's
 * card. The course itself offers three things (a colleague, hiding it,
 * deletion), so they sit in a menu; `Actions` is what decides that.
 *
 * A course the teacher no longer teaches can be hidden (#155, ADR-032): for
 * them alone, out of this list, the sidebar and the palette. "Show hidden"
 * brings those courses back here, each one badged and with "Show again" in
 * its menu. The toggle is not remembered — hidden is meant to stay out of
 * sight — and it only exists while something is hidden.
 */

const VIEW_KEY = "quiz-courses-view";
const VIEWS = ["cards", "list"] as const;

/** What the table may be sorted on: the identity column and the two counts. */
type CourseSortKey = "name" | "classrooms" | "staff";

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
 * The course detail (`GET /courses/:id`): its pools for `CoursePools`, its
 * archived classrooms for `ArchivedClassrooms`. One query key, one request.
 */
function useCourseDetail(courseId: string) {
  return useQuery<CourseDetail>({
    queryKey: courseKey(courseId),
    queryFn: () => api(`/app/api/courses/${courseId}`),
  });
}

/** The badge of a course the caller hid (#155), on its card and its table row. */
function HiddenBadge({ course }: { course: CourseSummary }) {
  const t = useT();
  return course.hidden ? (
    <Badge tone="zinc" icon={EyeOff}>
      {t("courses.hidden")}
    </Badge>
  ) : null;
}

/**
 * One classroom of a course card, live or archived: it opens the classroom.
 * An archived one is muted, wears the archive icon and has no headcount; it
 * is restored from its own page, which already offers that.
 */
function ClassroomRow({
  room,
  archived = false,
  students,
  navigate,
}: {
  room: { id: string; name: string; period: string };
  archived?: boolean;
  students?: number;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const Icon = archived ? Archive : School;
  return (
    <button
      type="button"
      onClick={() => navigate({ view: "classroom", id: room.id })}
      className={cx(
        "flex w-full items-center gap-3 rounded-field px-2.5 py-2 text-left transition-colors hover:bg-surface-2",
        archived && "text-fg-muted hover:text-fg",
      )}
    >
      <Icon className="size-4 shrink-0 text-fg-faint" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{room.name}</span>
      {room.period ? <span className="shrink-0 text-xs text-fg-faint">{room.period}</span> : null}
      {students !== undefined ? (
        <span className="shrink-0 text-xs tabular-nums text-fg-muted">
          {t(students === 1 ? "classrooms.students.one" : "classrooms.students", { n: students })}
        </span>
      ) : null}
    </button>
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

  const detail = useCourseDetail(course.id);
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
    <div className="mt-4">
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
                className="flex min-w-0 flex-1 items-center gap-2 rounded-field px-2 py-1 text-left text-[13px] transition-colors hover:bg-surface-2"
              >
                <FolderTree className="size-3.5 shrink-0 text-fg-faint" />
                <span className="min-w-0 flex-1 truncate font-medium">{pool.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                  {t(pool.questionCount === 1 ? "pools.questions.one" : "pools.questions", {
                    n: pool.questionCount,
                  })}
                </span>
              </button>
              <Actions
                label={t("common.actions")}
                size="sm"
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
 *
 * `items` are the actions of the COURSE and `staffActions` those of one
 * person, because that is where each is read: the two icon buttons sit beside
 * the title, and "remove from the staff" waits inside the card of the
 * colleague it is about, where the name is already written.
 */
function useCourseActions(course: CourseSummary): {
  items: MenuItem[];
  staffActions: (person: Person) => MenuItem[];
  newClassroom: () => void;
  dialogs: ReactNode;
} {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toastError = useErrorToast();
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
  const toast = useToast();
  // A hidden course leaves the list at once, so the toast says where it went.
  const setHidden = useMutation({
    mutationFn: (hidden: boolean) =>
      api(`/app/api/courses/${course.id}/${hidden ? "hide" : "unhide"}`, { method: "POST" }),
    onSuccess: async (_data, hidden) => {
      await invalidate();
      if (hidden) toast(t("courses.hiddenToast", { code: course.code }), "success");
    },
    onError: toastError("error.save"),
  });

  return {
    newClassroom: () => setNewRoom(true),
    // The server refuses to empty a staff (409 `last_staff`); an action that
    // can only fail is not offered at all, so the last colleague standing has
    // a card with nothing in it but their address.
    staffActions: (person) =>
      course.staff.length <= 1
        ? []
        : [
            {
              label: t("courses.staffRemove"),
              icon: UserMinus,
              danger: true,
              onSelect: async () => {
                if (
                  await confirm({
                    title: t("courses.staffRemoveConfirm", {
                      name: `${person.givenName} ${person.familyName}`,
                      course: course.name,
                    }),
                    confirmLabel: t("courses.staffRemove"),
                    cancelLabel: t("common.cancel"),
                  })
                ) {
                  removeStaff.mutate(person.userId);
                }
              },
            },
          ],
    items: [
      {
        label: t("courses.staffAdd"),
        icon: UserPlus,
        onSelect: () => setNewStaff(true),
      },
      course.hidden
        ? { label: t("courses.unhide"), icon: Eye, onSelect: () => setHidden.mutate(false) }
        : {
            label: t("courses.hide"),
            description: t("courses.hideHint"),
            icon: EyeOff,
            onSelect: () => setHidden.mutate(true),
          },
      {
        label: t("courses.delete"),
        icon: Trash2,
        danger: true,
        separator: true,
        onSelect: async () => {
          // The confirmation names what else goes (ADR-031): the course's
          // templates cascade with it, and nothing else on this card says so.
          // A count that could not be read is not confirmed as zero.
          let templates: number;
          try {
            templates = (
              await qc.fetchQuery<EvaluationTemplate[]>({
                queryKey: courseTemplatesKey(course.id),
                queryFn: () => api(`/app/api/courses/${course.id}/templates`),
              })
            ).length;
          } catch (error) {
            toastError("error.server")(error);
            return;
          }
          if (
            await confirm({
              title:
                templates === 0
                  ? t("courses.deleteConfirm", { name: course.name })
                  : t(
                      templates === 1
                        ? "courses.deleteConfirmTemplates.one"
                        : "courses.deleteConfirmTemplates",
                      { name: course.name, n: templates },
                    ),
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

/**
 * The archived classrooms of a course (#155): the course list leaves them
 * out, so they would be reachable by URL alone. They come from the course
 * detail (`useCourseDetail`), behind a "Show archived" toggle that exists
 * only when there is one — a past year is looked up, not read every day.
 * The table view has no such toggle: archived classrooms are reached from
 * the card view.
 */
function ArchivedClassrooms({
  course,
  navigate,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const detail = useCourseDetail(course.id);
  const archived = (detail.data?.classrooms ?? []).filter((r) => r.archivedAt !== null);
  if (archived.length === 0) return null;

  return (
    <>
      <div className="flex justify-end pt-1">
        <ToggleChip
          icon={Archive}
          tone="neutral"
          label={t("classrooms.showArchived", { n: archived.length })}
          pressed={shown}
          onToggle={() => setShown((v) => !v)}
        />
      </div>
      {shown
        ? archived.map((room) => (
            <ClassroomRow key={room.id} room={room} archived navigate={navigate} />
          ))
        : null}
    </>
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
  const { items, staffActions, newClassroom, dialogs } = useCourseActions(course);

  return (
    <Card className="p-5">
      {/* The staff belongs to the title line and not to a row of its own: who
          teaches a course is part of naming it, and the hairline-separated
          strip it used to live in said "STAFF" to announce three discs. */}
      <SectionHeading
        icon={Library}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {course.name}
            <span className="text-[13px] font-normal text-fg-faint">{course.code}</span>
            <HiddenBadge course={course} />
            <PeopleStack people={course.staff} actions={staffActions} className="ml-2" />
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={newClassroom}>
              <Plus /> {t("classrooms.new")}
            </Button>
            <Actions items={items} label={t("common.actions")} />
          </>
        }
      />

      <div className="mt-4 space-y-1.5">
        {course.classrooms.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("classrooms.empty")}</p>
        ) : (
          course.classrooms.map((room) => (
            <ClassroomRow key={room.id} room={room} students={room.students} navigate={navigate} />
          ))
        )}
        <ArchivedClassrooms course={course} navigate={navigate} />
      </div>

      <CoursePools course={course} navigate={navigate} />
      <CourseTemplates courseId={course.id} classrooms={course.classrooms} navigate={navigate} />

      {dialogs}
    </Card>
  );
}

/**
 * One course as a table row: its identity, the classrooms it holds — each a
 * link, because that is what a teacher came for — and its staff. The pools of
 * a course are a card affair, and so are its archived classrooms ("Show
 * archived" on the card); the table answers "which live classroom, where".
 */
function CourseRow({
  course,
  navigate,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const { items, staffActions, dialogs } = useCourseActions(course);
  return (
    <tr className={T.row}>
      <td className={T.td}>
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold">{course.name}</span>
          <span className="text-xs text-fg-faint">{course.code}</span>
          <HiddenBadge course={course} />
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
                className="rounded-field px-1.5 py-0.5 font-medium transition-colors hover:bg-surface-2 hover:underline"
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
          <PeopleStack people={course.staff} actions={staffActions} />
        )}
      </td>
      <td className={`${T.td} w-10 text-right`}>
        <Actions items={items} label={t("common.actions")} />
        {dialogs}
      </td>
    </tr>
  );
}

export function TeacherHome({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "cards");
  const [showHidden, setShowHidden] = useState(false);
  const courses = useQuery<CourseSummary[]>({
    queryKey: coursesKey,
    queryFn: () => api("/app/api/courses"),
  });
  const all = courses.data ?? [];
  const hiddenCount = all.filter((c) => c.hidden).length;
  const rows = showHidden ? all : all.filter((c) => inNavigation(c));
  /**
   * The table sorts, the cards do not: a card list is read in the order it
   * was given, while a table is scanned down one column. Three keys, the
   * three things a column can be worth here — the name, and the two counts.
   */
  const { sorted, sort, toggle } = useSortableTable<CourseSummary, CourseSortKey>(
    rows,
    (course, key) =>
      key === "classrooms"
        ? course.classrooms.length
        : key === "staff"
          ? course.staff.length
          : course.name,
    { key: "name", dir: 1 },
  );
  const columns: Column<CourseSortKey>[] = [
    { key: "name", label: t("courses.name") },
    { key: "classrooms", label: t("classrooms.title") },
    { key: "staff", label: t("courses.staff") },
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true, className: "w-10" },
  ];

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
          all.length > 0 ? (
            <Button data-coach="home.new-course" onClick={() => setCreating(true)}>
              <Plus /> {t("courses.new")}
            </Button>
          ) : undefined
        }
      />

      {/* Under the header and hard right: it changes how the list below is
          drawn, so it belongs to the list, not to the title. */}
      {all.length > 0 && !courses.isError ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Not while every course is hidden: the empty state below carries
              the same action, once. */}
          {hiddenCount > 0 && rows.length > 0 ? (
            <ToggleChip
              icon={EyeOff}
              tone="neutral"
              label={t("courses.showHidden", { n: hiddenCount })}
              pressed={showHidden}
              onToggle={() => setShowHidden((v) => !v)}
            />
          ) : null}
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
      ) : all.length > 0 && rows.length === 0 ? (
        // Every course is hidden: the list is not empty, it is folded away.
        <EmptyState
          icon={EyeOff}
          title={t("courses.allHidden")}
          action={
            <Button variant="secondary" onClick={() => setShowHidden(true)}>
              <Eye /> {t("courses.showHidden", { n: hiddenCount })}
            </Button>
          }
        >
          {t("courses.allHiddenBody")}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Library}
          title={t("courses.empty.title")}
          action={
            <Button data-coach="home.new-course" onClick={() => setCreating(true)}>
              <Plus /> {t("courses.new")}
            </Button>
          }
        >
          {t("courses.empty.body")}
        </EmptyState>
      ) : view === "list" ? (
        <Card className="overflow-hidden">
          <table className={T.table}>
            <TableHead columns={columns} sort={sort} onToggle={toggle} />
            <tbody>
              {sorted.map((c) => (
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
