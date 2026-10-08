import { FileStack, Library, School } from "lucide-react";

import type { CourseSummary } from "@quiz/contracts";

import { useT } from "../i18n";
import type { Route } from "../router";
import { Actions, Card, cx, PeopleStack, SectionHeading, T } from "../ui";
import { CoursePools } from "./CoursePools";
import { ArchivedClassrooms, ClassroomRow, HiddenBadge } from "./parts";
import { useCourseActions } from "./useCourseActions";

/**
 * A course as the Courses home lists it (TeacherHome.tsx): a card, or a row
 * of the table view. Both are summaries; the name opens the course page.
 */

/**
 * The course's name, as the way into its page: the card and the table row
 * are summaries, the page is where the whole course is read. The name keeps
 * the weight of the heading it sits in and underlines on hover, like a
 * breadcrumb link: the grey of a link at rest is not a signal on its own.
 */
function CourseLink({ course, navigate }: { course: CourseSummary; navigate: (r: Route) => void }) {
  return (
    <button
      type="button"
      onClick={() => navigate({ view: "course", id: course.id })}
      className="text-left transition-colors hover:underline"
    >
      {course.name}
    </button>
  );
}

export function CourseCard({
  course,
  navigate,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const { items, staffActions, dialogs } = useCourseActions(course);

  return (
    <Card className="flex min-w-0 flex-col p-5">
      {/* The staff belongs to the title line and not to a row of its own: who
          teaches a course is part of naming it, and the hairline-separated
          strip it used to live in said "STAFF" to announce three discs. */}
      <SectionHeading
        icon={Library}
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <CourseLink course={course} navigate={navigate} />
            <span className="text-[13px] font-normal text-fg-faint">{course.code}</span>
            <HiddenBadge course={course} />
            <PeopleStack people={course.staff} actions={staffActions} className="ml-2" />
          </span>
        }
        // No "New classroom" here: the card is a summary, and a classroom is
        // made on the course page, whose one primary action it is.
        actions={<Actions items={items} label={t("common.actions")} />}
      />

      <div className="mt-4 flex-1 space-y-1.5">
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

      {/* The templates are counted, not listed: they live on the course page
          (ADR-031), which the count opens. */}
      <button
        type="button"
        onClick={() => navigate({ view: "course", id: course.id })}
        className="mt-4 flex items-center gap-2 self-start rounded-field px-2 py-1 text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <FileStack className="size-3.5 shrink-0 text-fg-faint" />
        {course.templates === 0
          ? t("templates.count.none")
          : t(course.templates === 1 ? "templates.count.one" : "templates.count", { n: course.templates })}
      </button>

      {dialogs}
    </Card>
  );
}

/**
 * One course as a table row: its identity — the name opens the course page,
 * as on the card — the classrooms it holds — each a link, because that is
 * what a teacher came for — and its staff. The pools of a course are a card
 * and page affair, and so are its archived classrooms ("Show archived"); the
 * table answers "which live classroom, where".
 */
export function CourseRow({
  course,
  navigate,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const { items, staffActions, dialogs } = useCourseActions(course);
  return (
    <tr className={cx(T.row, T.stack.row)}>
      <td className={cx(T.td, T.stack.main)}>
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold">
            <CourseLink course={course} navigate={navigate} />
          </span>
          <span className="text-xs text-fg-faint">{course.code}</span>
          <HiddenBadge course={course} />
        </span>
      </td>
      <td className={cx(T.td, T.stack.sub, "@max-md:-ml-1.5")}>
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
      <td className={cx(T.td, T.stack.sub)}>
        {course.staff.length === 0 ? (
          <span className="text-fg-faint">—</span>
        ) : (
          <PeopleStack people={course.staff} actions={staffActions} />
        )}
      </td>
      <td className={cx(T.td, T.stack.end, "w-10 text-right")}>
        <Actions items={items} label={t("common.actions")} />
        {dialogs}
      </td>
    </tr>
  );
}
