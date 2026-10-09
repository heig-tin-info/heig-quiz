import { Library, School } from "lucide-react";

import type { ClassroomSummary } from "@quiz/contracts";

import { rightNowClassrooms } from "../CourseNav";
import { useT } from "../i18n";
import type { Route } from "../router";
import { Button, Card, EmptyState, PageHeader, QueryError, Skeleton } from "../ui";
import { ClassroomRow, useCourses } from "./parts";

const ROUTE: Route = { view: "classrooms" };

/**
 * The teacher's "right now" classrooms as a page (#449): the list the
 * sidebar holds under its Classrooms heading (`rightNowClassrooms`), for the
 * phone, whose bottom bar leaves no drawer to hold it. Each course is a card
 * of its classrooms, the rows of the course cards (`ClassroomRow`). Nothing
 * else: every classroom of a course, the archived included, is on its page.
 */
export function ClassroomsPage({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const courses = useCourses();
  const rooms = rightNowClassrooms(courses.data ?? [], ROUTE);
  const byCourse = new Map<string, ClassroomSummary[]>();
  for (const room of rooms) byCourse.set(room.courseId, [...(byCourse.get(room.courseId) ?? []), room]);

  return (
    <div className="space-y-6">
      <PageHeader title={t("classrooms.title")} description={t("classrooms.rightNow")} />
      {courses.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : courses.isError ? (
        <QueryError title={t("classrooms.title")} query={courses} />
      ) : rooms.length === 0 ? (
        <EmptyState
          icon={School}
          title={t("classrooms.rightNowEmpty")}
          action={
            <Button variant="secondary" onClick={() => navigate({ view: "home" })}>
              <Library /> {t("classrooms.openCourses")}
            </Button>
          }
        >
          {t("classrooms.rightNowEmptyBody")}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {[...byCourse.values()].map((list) => (
            <Card key={list[0]!.courseId} className="p-3">
              <p className="px-2.5 pb-1.5 pt-1 text-[13px] text-fg-muted">
                {t("nav.classroomCourse", { code: list[0]!.courseCode, name: list[0]!.courseName })}
              </p>
              <div className="space-y-0.5">
                {list.map((room) => (
                  <ClassroomRow key={room.id} room={room} students={room.students} navigate={navigate} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
