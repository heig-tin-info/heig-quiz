import { useQuery } from "@tanstack/react-query";
import { Archive, BookOpen, CalendarClock, EyeOff, School, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import type {
  ActivitySummary,
  ClassroomDetail,
  ClassroomSummary,
  CourseCondition,
  CourseDetail,
  CourseRole,
  CourseSummary,
} from "@quiz/contracts";
import { courseRoleAllows } from "@quiz/domain";

import { api, type ReadOptions } from "../api";
import { useI18n, useT } from "../i18n";
import type { Route } from "../router";
import { Badge, cx, relativeTime, ToggleChip, useNow } from "../ui";
import { activitiesKey, classroomKey, courseConditionsKey, courseKey, coursesKey } from "../queryKeys";
import { classroomSignals, type ClassroomSignals } from "./classroomSignals";

/**
 * The pieces of a course that its two readings share: the card on the
 * Courses home (TeacherHome.tsx) and the course page (CoursePage.tsx). One
 * copy each, so the summary and the page cannot offer a course different
 * things. The larger ones have files of their own beside this one:
 * `CoursePools`, `useCourseActions` and the dialogs of `modals`.
 */

/**
 * The caller's courses (`GET /courses`): every course of their staff, each
 * with its staff, its classrooms and whether they hid it. The key and the URL
 * in one place, for the pages that read the list.
 */
export function useCourses(options: ReadOptions = {}) {
  return useQuery<CourseSummary[]>({
    queryKey: coursesKey,
    queryFn: () => api("/app/api/courses"),
    ...options,
  });
}

/**
 * A classroom as its staff read it (`GET /classrooms/:id`): its course,
 * roster and settings. `null` while the id is not known yet: the query waits.
 * The student's reading is `studentClassroomKey`'s, never this one.
 */
export function useClassroom(id: string | null, options: ReadOptions = {}) {
  return useQuery<ClassroomDetail>({
    queryKey: classroomKey(id),
    queryFn: () => api(`/app/api/classrooms/${id}`),
    ...options,
    enabled: id !== null && (options.enabled ?? true),
  });
}

/**
 * THE client decision of "may the caller do what only an owner of this
 * course may" (ADR-068): their `myRole` in the course list, which holds
 * every course they reach — hidden ones, and every course under Super
 * Powers. False while the list loads, and for a course it does not hold:
 * an owner's action is never offered on a guess. The server refuses anyway
 * (`owner_required`).
 */
export function useIsCourseOwner(courseId: string | null | undefined): boolean {
  return courseRoleAllows(useCourseRole(courseId), "owner");
}

/**
 * The caller's role on the course, from the same list (null while it loads
 * or without a seat): for an action whose needed role depends on its target
 * (`courseRoleAllows(role, row.deletionRole)`, ADR-068 §3).
 */
export function useCourseRole(courseId: string | null | undefined): CourseRole | null {
  return useCourses().data?.find((c) => c.id === courseId)?.myRole ?? null;
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

/**
 * The course's catalog of conditions (F-ORG-16): every entry, the active
 * ones first; a reader filters on `archivedAt` (the editor offers the
 * active ones, the course's settings show both).
 */
export function useCourseConditions(courseId: string) {
  return useQuery<CourseCondition[]>({
    queryKey: courseConditionsKey(courseId),
    queryFn: () => api(`/app/api/courses/${courseId}/conditions`),
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
 * The signals of the caller's classroom rows (#805), from `GET /activities`
 * (the list the Activities page reads, same key) and the room's own summary.
 * Undefined while the activities load or when they failed: the row then
 * keeps its first line alone — never a "0" that means "not known yet".
 */
export function useClassroomSignals(): (room: ClassroomSummary) => ClassroomSignals | undefined {
  const activities = useQuery<ActivitySummary[]>({
    queryKey: activitiesKey,
    queryFn: () => api("/app/api/activities"),
  });
  // "Live" and "next" move with the clock, not only with the list.
  const now = useNow(30_000);
  const rows = activities.data;
  return (room) => (rows === undefined || activities.isError ? undefined : classroomSignals(rows, room, now));
}

/**
 * One classroom of a course, live or archived: it opens the classroom.
 * An archived one is muted, wears the archive icon and has no headcount; it
 * is restored from its own page, which already offers that. `signals` adds a
 * second, muted line of what is happening in it (#805).
 */
export function ClassroomRow({
  room,
  archived = false,
  students,
  signals,
  navigate,
}: {
  room: { id: string; name: string; period: string };
  archived?: boolean;
  students?: number;
  signals?: ClassroomSignals;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const Icon = archived ? Archive : School;
  return (
    <button
      type="button"
      onClick={() => navigate({ view: "classroom", id: room.id })}
      className={cx(
        "flex w-full items-start gap-3 rounded-field px-2.5 py-2 text-left transition-colors hover:bg-surface-2",
        archived && "text-fg-muted hover:text-fg",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-fg-faint" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{room.name}</span>
          {room.period ? <span className="shrink-0 text-xs text-fg-faint">{room.period}</span> : null}
          {students !== undefined ? (
            <span className="shrink-0 text-xs tabular-nums text-fg-muted">
              {t(students === 1 ? "classrooms.students.one" : "classrooms.students", { n: students })}
            </span>
          ) : null}
        </span>
        {signals ? <SignalLine signals={signals} /> : null}
      </span>
    </button>
  );
}

/** A count in words, its singular apart: `{n} things` / `1 thing`. */
function counted(t: ReturnType<typeof useT>, n: number, key: "evaluations" | "projects" | "live" | "toGrade"): string {
  return t(n === 1 ? (`classrooms.signal.${key}.one` as const) : (`classrooms.signal.${key}` as const), { n });
}

/**
 * The row's second line: only what applies, never a zero. What is live and
 * what waits on the staff are badges in ADR-104's tones (green open, amber
 * awaited); everything else is muted text, so the row stays one link.
 */
function SignalLine({ signals }: { signals: ClassroomSignals }) {
  const t = useT();
  const { locale } = useI18n();
  const now = useNow(30_000);
  const when = (iso: string) => relativeTime(iso, now, locale, t);
  const { live, toGrade, next, journal, enrollment, evaluations, projects } = signals;
  const items: { key: string; node: ReactNode }[] = [];
  if (live > 0) items.push({ key: "live", node: <Badge tone="green">{counted(t, live, "live")}</Badge> });
  if (toGrade > 0) items.push({ key: "grade", node: <Badge tone="amber">{counted(t, toGrade, "toGrade")}</Badge> });
  if (next) {
    items.push({
      key: "next",
      node: (
        <Signal icon={CalendarClock}>
          {next.row.title}{" "}
          {t(next.what === "opens" ? "activities.summary.opens" : "activities.summary.closes")} {when(next.at)}
        </Signal>
      ),
    });
  }
  const journalText = journal?.lastPage
    ? [
        t("classrooms.signal.journal.last", { title: journal.lastPage.title }),
        journal.nextPage ? t("classrooms.signal.journal.next", { when: when(journal.nextPage.at) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : journal?.nextPage
      ? t("classrooms.signal.journal.nextOnly", { when: when(journal.nextPage.at) })
      : null;
  if (journalText) items.push({ key: "journal", node: <Signal icon={BookOpen}>{journalText}</Signal> });
  if (enrollment) {
    items.push({
      key: "enrollment",
      node: <Signal icon={Users}>{t("classrooms.signal.enrollment", { claimed: enrollment.claimed, students: enrollment.students })}</Signal>,
    });
  }
  const counts = [
    evaluations > 0 ? counted(t, evaluations, "evaluations") : null,
    projects > 0 ? counted(t, projects, "projects") : null,
  ].filter(Boolean);
  if (counts.length > 0) items.push({ key: "counts", node: <span className="tabular-nums">{counts.join(" · ")}</span> });
  if (items.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      {items.map((item) => (
        <span key={item.key} className="min-w-0 max-w-full">
          {item.node}
        </span>
      ))}
    </span>
  );
}

function Signal({ icon: Icon, children }: { icon: typeof BookOpen; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Icon className="size-3.5 shrink-0 text-fg-faint" />
      <span className="truncate">{children}</span>
    </span>
  );
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
