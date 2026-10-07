import { useQuery } from "@tanstack/react-query";
import { Archive, EyeOff, School } from "lucide-react";
import { useState } from "react";

import type { CourseCondition, CourseDetail, CourseSummary } from "@quiz/contracts";
import { courseRoleAllows } from "@quiz/domain";

import { api } from "../api";
import { useT } from "../i18n";
import type { Route } from "../router";
import { Badge, cx, ToggleChip } from "../ui";
import { courseConditionsAllKey, courseConditionsKey, courseKey, coursesKey } from "../queryKeys";

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
export function useCourses() {
  return useQuery<CourseSummary[]>({
    queryKey: coursesKey,
    queryFn: () => api("/app/api/courses"),
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
  const role = useCourses().data?.find((c) => c.id === courseId)?.myRole ?? null;
  return courseRoleAllows(role, "owner");
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
 * The course's catalog of conditions (F-ORG-16): its active entries, which
 * the evaluation editor picks from, and the archived ones too with
 * `archived`, for the course's Conditions tab.
 */
export function useCourseConditions(courseId: string, { archived = false }: { archived?: boolean } = {}) {
  return useQuery<CourseCondition[]>({
    queryKey: archived ? courseConditionsAllKey(courseId) : courseConditionsKey(courseId),
    queryFn: () => api(`/app/api/courses/${courseId}/conditions${archived ? "?archived=1" : ""}`),
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
