import { Library, Plus, School } from "lucide-react";

import type { CourseSummary } from "@quiz/contracts";

import { CourseTemplates } from "../evaluation/templates";
import { useT } from "../i18n";
import type { Route } from "../router";
import {
  Actions,
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  ParentLink,
  PeopleStack,
  SectionHeading,
  Skeleton,
} from "../ui";
import { ArchivedClassrooms, ClassroomRow, CoursePools, HiddenBadge, useCourseActions, useCourses } from "./parts";

/**
 * The page of one course (F-ORG-12): what the course holds, in the order a
 * teacher reaches for it — its classrooms, the pools it draws from, and its
 * evaluation templates, which live here and nowhere else (ADR-031).
 *
 * The ONE primary action is "New classroom": a course exists to hold
 * classrooms, and the pools and templates are sections to read and tend, not
 * the reason the page was opened. The course's own actions (a colleague,
 * hiding it, deletion) sit in the header's menu, the staff on the title line
 * — the same `useCourseActions` as the card, so the two cannot drift.
 *
 * The course comes from the course LIST (`GET /courses`), not from its
 * detail: the list is what carries `hidden`, the staff and the headcounts the
 * actions and the rows need, the sidebar already holds it, and an id missing
 * from it is a course the caller does not reach — said as such, never a
 * crash. The detail (`GET /courses/:id`) brings the pools and the archived
 * classrooms, inside the sections that show them.
 */
export function CoursePage({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const courses = useCourses();

  if (courses.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (courses.isError) {
    return (
      <PageError
        title={t("courses.title")}
        error={courses.error}
        onRetry={() => void courses.refetch()}
        retrying={courses.isFetching}
      />
    );
  }
  const course = courses.data?.find((c) => c.id === id);
  if (!course) {
    return (
      <EmptyState
        icon={Library}
        titleAs="h1"
        title={t("courses.notFound")}
        action={
          <Button variant="secondary" onClick={() => navigate({ view: "home" })}>
            {t("courses.backToList")}
          </Button>
        }
      />
    );
  }
  // Keyed on the id: a move from one course page to another (the sidebar,
  // the palette) starts the next one with its own dialogs and toggles closed.
  return <Course key={course.id} course={course} navigate={navigate} />;
}

function Course({ course, navigate }: { course: CourseSummary; navigate: (r: Route) => void }) {
  const t = useT();
  const { items, staffActions, newClassroom, dialogs } = useCourseActions(course, {
    onDeleted: () => navigate({ view: "home" }),
  });

  return (
    <div className="space-y-8">
      <PageHeader
        help="courses"
        eyebrow={
          <ParentLink onClick={() => navigate({ view: "home" })}>{t("courses.title")}</ParentLink>
        }
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {course.name}
            <span className="text-base font-normal text-fg-muted">{course.code}</span>
            <HiddenBadge course={course} />
            <PeopleStack people={course.staff} actions={staffActions} />
          </span>
        }
        actions={
          <>
            <Button onClick={newClassroom}>
              <Plus /> {t("classrooms.new")}
            </Button>
            <Actions items={items} label={t("common.actions")} />
          </>
        }
      />

      <section className="space-y-3">
        <SectionHeading icon={School} title={t("classrooms.title")} count={course.classrooms.length} />
        <Card className="space-y-1 p-3">
          {course.classrooms.length === 0 ? (
            // Words, not a second button: "New classroom" is in the header,
            // and two accent fills of the same action is noise (W19).
            <p className="px-2.5 py-2 text-sm text-fg-muted">{t("classrooms.empty")}</p>
          ) : (
            course.classrooms.map((room) => (
              <ClassroomRow key={room.id} room={room} students={room.students} navigate={navigate} />
            ))
          )}
          <ArchivedClassrooms course={course} navigate={navigate} />
        </Card>
      </section>

      <CoursePools course={course} navigate={navigate} page />
      <CourseTemplates courseId={course.id} classrooms={course.classrooms} navigate={navigate} />

      {dialogs}
    </div>
  );
}
