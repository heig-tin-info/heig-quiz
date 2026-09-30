/**
 * The student's Courses (F-ORG-14, D07): the classrooms where they hold a
 * claimed seat, archived ones excepted, each card opening the classroom's
 * page. The same cards as the home's "My classrooms", and the same join card
 * under them, since joining a classroom is what an empty list asks for.
 *
 * The four decisions:
 *   - Type: the classroom's name is the 15 px line of each card; the course
 *     and the teachers are 13–14 px under it.
 *   - Color: no primary. The page is a list of doors; a card is pressed, and
 *     the time bonus is the one accent (a soft badge, as on the home).
 *   - Space: 24 under the header, 12 between cards.
 *   - Finish: cards on the canvas, hairlines, the hover of an interactive card.
 */
import { useQuery } from "@tanstack/react-query";
import { GraduationCap } from "lucide-react";

import type { StudentClassroom } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { studentClassroomsKey } from "../queryKeys";
import type { Route } from "../router";
import { Card, EmptyState, PageHeader, QueryError, Skeleton } from "../ui";
import { ClassroomCard, JoinCard } from "./cards";

export function StudentCourses({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const rooms = useQuery<StudentClassroom[]>({
    queryKey: studentClassroomsKey,
    queryFn: () => api("/app/api/student/classrooms"),
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t("nav.courses")} description={t("scourses.subtitle")} />
      <div className="space-y-3">
        {rooms.isLoading ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        ) : rooms.isError ? (
          <QueryError
            title={t("shome.classrooms")}
            error={rooms.error}
            onRetry={() => void rooms.refetch()}
            retrying={rooms.isFetching}
          />
        ) : (rooms.data ?? []).length === 0 ? (
          <Card>
            <EmptyState icon={GraduationCap} title={t("shome.rooms.empty.title")}>
              {t("shome.rooms.empty.body")}
            </EmptyState>
          </Card>
        ) : (
          rooms.data!.map((room) => <ClassroomCard key={room.id} room={room} navigate={navigate} />)
        )}
        <JoinCard />
      </div>
    </div>
  );
}
