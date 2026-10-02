import { useQuery } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";

import type { ProjectActivitySummary } from "@quiz/contracts";

import { kindOf } from "../activities/model";
import { openProps, StateBadge } from "../activities/views";
import { api } from "../api";
import { githubAbsent } from "../github/api";
import { useT } from "../i18n";
import { classroomProjectsKey } from "../queryKeys";
import type { Route } from "../router";
import {
  Card,
  isoDateTime,
  QueryError,
  SectionHeading,
  T,
  TableHead,
  useSortableTable,
  type Column,
} from "../ui";

type SortKey = "title" | "start" | "deadline";

/**
 * The classroom's projects (F-PROJ-01, M3-10), a group under its evaluations
 * on the same tab: the Evaluations table stays as it was, and this one only
 * exists while the classroom HAS a project. A classroom that never used
 * GitHub — most of them — reads exactly as before, and so does a platform
 * without the App (the route answers 404). For the same reason nothing is
 * drawn while the list loads: the group's very existence is what is not
 * known yet, and a skeleton that collapses to nothing on most classrooms is
 * a jump on every visit. A failure says so, with a retry.
 *
 * It carries a heading and the evaluations do not: the tab already names
 * the evaluations, and the projects are the second thing on it.
 *
 * No button: "New ▾ › Project" is in the page header, the tab's one primary.
 * A row is a title, its state, its start and its deadline, and opens the
 * project where its page parses (`KIND`'s `home`, M3-12); elsewhere it is
 * not clickable. Its counts come with M3-08.
 */
export function ProjectGroup({
  classroomId,
  navigate,
}: {
  classroomId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  // `GET /classrooms/:id/projects` (M3-02), archived ones excepted.
  const list = useQuery<ProjectActivitySummary[]>({
    queryKey: classroomProjectsKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}/projects`),
  });
  const rows = list.data ?? [];
  const { sorted, sort, toggle } = useSortableTable<ProjectActivitySummary, SortKey>(
    rows,
    (row, key) => (key === "start" ? row.startAt : key === "deadline" ? row.deadlineAt : row.title),
    null,
  );

  if (list.isError && !githubAbsent(list.error)) {
    return (
      <QueryError
        title={t("project.loadFailed")}
        error={list.error}
        onRetry={() => void list.refetch()}
        retrying={list.isFetching}
        fallback={t("error.server")}
      />
    );
  }
  if (rows.length === 0) return null;

  const columns: Column<SortKey>[] = [
    { key: "title", label: t("eval.titleLabel") },
    { key: "start", label: t("project.start"), className: T.colHigh },
    { key: "deadline", label: t("project.deadline") },
  ];
  return (
    <section aria-labelledby="classroom-projects" className="space-y-3">
      <SectionHeading
        icon={FolderGit2}
        title={<span id="classroom-projects">{t("project.group")}</span>}
        count={rows.length}
      />
      <Card className={`${T.container} overflow-hidden`}>
        <table className={T.table}>
          <TableHead columns={columns} sort={sort} onToggle={toggle} />
          <tbody>
            {sorted.map((row) => {
              const opens = kindOf(row).home(row) !== null;
              return (
                <tr
                  key={row.id}
                  className={opens ? `${T.row} ${T.rowHover} cursor-pointer` : T.row}
                  {...openProps(row, navigate, "row")}
                >
                  <td className={T.td}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{row.title}</span>
                      <StateBadge row={row} />
                    </span>
                  </td>
                  <td className={`${T.td} ${T.colHigh} tabular-nums text-fg-muted`}>{isoDateTime(row.startAt)}</td>
                  <td className={`${T.td} tabular-nums text-fg-muted`}>{isoDateTime(row.deadlineAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </section>
  );
}
