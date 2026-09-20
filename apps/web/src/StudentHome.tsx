import { useQuery } from "@tanstack/react-query";
import { Clock, GraduationCap, School } from "lucide-react";

import type { StudentClassroom } from "@quiz/contracts";

import { api } from "./api";
import { useT } from "./i18n";
import { Badge, Card, EmptyState, PageHeader, QueryError, Skeleton } from "./ui";

/**
 * Student home: the classrooms they belong to.
 *
 * A student never sees a course, a roster or anyone else's name beyond the
 * teaching staff: everything on this page is about them.
 */
export function StudentHome() {
  const t = useT();
  const rooms = useQuery<StudentClassroom[]>({
    queryKey: ["student", "classrooms"],
    queryFn: () => api("/app/api/student/classrooms"),
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t("student.title")} description={t("student.subtitle")} />

      {rooms.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : rooms.isError ? (
        <QueryError
          title={t("student.title")}
          error={rooms.error}
          onRetry={() => void rooms.refetch()}
          retrying={rooms.isFetching}
          fallback={t("error.server")}
        />
      ) : (rooms.data ?? []).length === 0 ? (
        <Card>
          <EmptyState icon={GraduationCap} title={t("student.empty.title")}>
            {t("student.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {rooms.data!.map((room) => (
            <Card key={room.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 p-5">
              <School className="size-5 shrink-0 text-fg-faint" />
              <div className="min-w-0 flex-1">
                <p className="text-[17px] font-bold tracking-tight">{room.name}</p>
                <p className="text-sm text-fg-muted">
                  {room.courseCode} — {room.courseName}
                  {room.period ? ` · ${room.period}` : ""}
                </p>
                {room.teachers.length > 0 ? (
                  <p className="mt-1 text-[13px] text-fg-faint">
                    {t("student.teachers", { names: room.teachers.join(", ") })}
                  </p>
                ) : null}
              </div>
              {room.timeBonusPercent > 0 ? (
                <Badge tone="accent" icon={Clock}>
                  {t("student.bonus", { n: room.timeBonusPercent })}
                </Badge>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
