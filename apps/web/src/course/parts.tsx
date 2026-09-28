import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Eye, EyeOff, FolderTree, Link2, School, Trash2, Unlink, UserMinus, UserPlus } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  ClassroomCreate,
  type CourseDetail,
  type CourseSummary,
  type EvaluationTemplate,
  type PoolSummary,
} from "@quiz/contracts";
import { poolRoleAllows } from "@quiz/domain";

import { api } from "../api";
import { newPeriodDraft, PeriodFields, periodBody, periodInvalid } from "../ClassroomPeriod";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import {
  Actions,
  Badge,
  Button,
  Card,
  cx,
  Field,
  FormDialog,
  FormError,
  Menu,
  type IconType,
  type MenuItem,
  type Person,
  QueryError,
  SectionHeading,
  Skeleton,
  ToggleChip,
} from "../ui";
import { courseKey, coursesKey, courseTemplatesKey, poolsKey } from "../queryKeys";

/**
 * The pieces of a course that its two readings share: the card on the
 * Courses home (TeacherHome.tsx) and the course page (CoursePage.tsx). One
 * copy each, so the summary and the page cannot offer a course different
 * things.
 */

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
 * The caller's courses (`GET /courses`): every course of their staff, each
 * with its staff, its classrooms and whether they hid it. The key and the URL
 * in one place, for the pages that read the list.
 */
export function useCourses() {
  return useQuery<CourseSummary[]>({
    queryKey: coursesKey,
    queryFn: () => api("/app/api/courses"),
  });
}

/**
 * The course detail (`GET /courses/:id`): its pools for `CoursePools`, its
 * archived classrooms for `ArchivedClassrooms`. One query key, one request.
 */
export function useCourseDetail(courseId: string) {
  return useQuery<CourseDetail>({
    queryKey: courseKey(courseId),
    queryFn: () => api(`/app/api/courses/${courseId}`),
  });
}

/** The badge of a course the caller hid (#155), on its card, its table row and its page. */
export function HiddenBadge({ course }: { course: CourseSummary }) {
  const t = useT();
  return course.hidden ? (
    <Badge tone="zinc" icon={EyeOff}>
      {t("courses.hidden")}
    </Badge>
  ) : null;
}

/**
 * One classroom of a course, live or archived: it opens the classroom.
 * An archived one is muted, wears the archive icon and has no headcount; it
 * is restored from its own page, which already offers that.
 */
export function ClassroomRow({
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
 * The frame of one part of a course (its pools, its templates) in the two
 * places a course is read. On the card it is an eyebrow under the
 * classrooms, because the card is a summary among others; on the course page
 * it is a section of its own, an `h2` over a card, because there it IS the
 * page and a reader moves through it by its headings.
 */
export function CoursePart({
  page,
  icon,
  title,
  action,
  children,
}: {
  page: boolean;
  icon: IconType;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  if (page) {
    return (
      <section className="space-y-3">
        <SectionHeading icon={icon} title={title} actions={action} />
        <Card className="p-3">{children}</Card>
      </section>
    );
  }
  return (
    <div className="mt-4">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
          {title}
        </span>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * The pools a course draws from (F-POOL-05). `PUT /courses/:id/pools`
 * replaces the WHOLE set in one call, so both the link and the unlink send
 * the list the course should end up with — there is no add/remove route, and
 * inventing one on the client would be a second way to do one thing.
 */
export function CoursePools({
  course,
  navigate,
  page = false,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
  /** Drawn as a section of the course page rather than a part of its card. */
  page?: boolean;
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
  // Linking makes the whole staff contributors of the pool, so the server
  // refuses a pool the caller only reads (ADR-013): it is not offered.
  const available = (pools.data ?? []).filter(
    (p) => poolRoleAllows(p.role, "contributor") && !linked.some((l) => l.id === p.id),
  );

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
    <CoursePart
      page={page}
      icon={FolderTree}
      title={t("pools.link")}
      action={
        // One click, no dialog: linking a pool is picking a name out of a
        // short list, and a modal with a select and two buttons was three
        // interactions for one decision.
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
      }
    >
      {detail.isLoading ? (
        <Skeleton className="mt-2 h-6 w-48" />
      ) : detail.isError ? (
        <div className="mt-2">
          <QueryError
            title={t("pools.link")}
            error={detail.error}
            onRetry={() => void detail.refetch()}
            retrying={detail.isFetching}
          />
        </div>
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
    </CoursePart>
  );
}

/**
 * What a course offers beyond being opened: a classroom, a colleague, its own
 * deletion. The card, the table row of the list view and the course page
 * share this ONE copy, so the readings of the same course cannot offer
 * different things; the hook owns the two dialogs those items open as well.
 *
 * `items` are the actions of the COURSE and `staffActions` those of one
 * person, because that is where each is read: the two icon buttons sit beside
 * the title, and "remove from the staff" waits inside the card of the
 * colleague it is about, where the name is already written.
 *
 * `onDeleted` runs once the course is gone: the course page leaves for the
 * Courses home rather than stay on a course that no longer exists.
 */
export function useCourseActions(
  course: CourseSummary,
  { onDeleted }: { onDeleted?: () => void } = {},
): {
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
    // Away first, then the list: the page would otherwise redraw once as
    // "this course does not exist" on its way out.
    onSuccess: async () => {
      onDeleted?.();
      await invalidate();
    },
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
          // templates cascade with it, and neither the card nor the table row
          // lists them. A count that could not be read is not confirmed as
          // zero.
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
 * the card view and from the course page.
 */
export function ArchivedClassrooms({
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
