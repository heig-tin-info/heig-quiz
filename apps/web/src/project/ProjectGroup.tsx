import { useQuery } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";

import type { ProjectActivitySummary } from "@quiz/contracts";

import { ActivityMenu } from "../activities/actions";
import { openProps, StateBadge } from "../activities/views";
import { api } from "../api";
import { githubAbsent } from "../github/api";
import { useT } from "../i18n";
import { classroomProjectsKey } from "../queryKeys";
import type { Route } from "../router";
import {
  Card,
  type Column,
  Dash,
  isoDateTime,
  QueryError,
  RelativeTime,
  SectionHeading,
  T,
  TableHead,
  useSortableTable,
} from "../ui";

type SortKey = "title" | "start" | "deadline";

/**
 * The classroom's projects (F-PROJ-01, M3-10), a section under the evaluations'
 * on the Activities tab (#683): this one only exists while the classroom HAS a project. A classroom that never used
 * GitHub — most of them — reads exactly as before, and so does a platform
 * without the App (the route answers 404). For the same reason nothing is
 * drawn while the list loads: the group's very existence is what is not
 * known yet, and a skeleton that collapses to nothing on most classrooms is
 * a jump on every visit. A failure says so, with a retry.
 *
 * Its heading is the sibling of the evaluations' (`EvaluationList`): each
 * list names itself and carries its own count.
 *
 * No button: "New ▾ › Project" is in the page header, the tab's one primary.
 * A row is a title, its state, its start and its deadline, and opens the
 * project where its page parses (`KIND`'s `home`, M3-12); elsewhere it is
 * not clickable. Its counts come with M3-08. A date that is not fixed yet (a
 * draft published by hand) is a dash and sorts last; a published project's
 * deadline says how far it is. The row ends with its two repositories on
 * GitHub, as links in sight (M3-14a, M3-14h).
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
    (row, key) => (key === "start" ? row.startAt : key === "deadline" ? row.deadlineAt : row.title) ?? "",
    null,
  );
  // An empty date sorts last, whichever way the column goes.
  const dateOf = (row: ProjectActivitySummary) => (sort?.key === "start" ? row.startAt : sort?.key === "deadline" ? row.deadlineAt : "");
  const ordered = [...sorted.filter((r) => dateOf(r) !== null), ...sorted.filter((r) => dateOf(r) === null)];

  if (list.isError && !githubAbsent(list.error)) {
    return (
      <QueryError title={t("project.loadFailed")} query={list} />
    );
  }
  if (rows.length === 0) return null;

  const columns: Column<SortKey>[] = [
    { key: "title", label: t("eval.titleLabel") },
    { key: "start", label: t("project.start"), className: T.colHigh },
    { key: "deadline", label: t("project.deadline") },
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true, className: "w-10" },
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
            {ordered.map((row) => {
              return (
                <tr
                  key={row.id}
                  className={`${T.row} ${T.rowHover} cursor-pointer`}
                  {...openProps(row, navigate, "row")}
                >
                  <td className={T.td}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{row.title}</span>
                      <StateBadge row={row} />
                    </span>
                  </td>
                  <td className={`${T.td} ${T.colHigh} tabular-nums text-fg-muted`}>{row.startAt === null ? <Dash /> : isoDateTime(row.startAt)}</td>
                  <td className={`${T.td} tabular-nums text-fg-muted`}>
                    {row.deadlineAt === null ? (
                      <Dash />
                    ) : (
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        {isoDateTime(row.deadlineAt)}
                        {row.state === "published" ? <RelativeTime iso={row.deadlineAt} className="text-fg-faint" /> : null}
                      </span>
                    )}
                  </td>
                  <td className={`${T.td} text-right`} onClick={(e) => e.stopPropagation()}>
                    <ActivityMenu row={row} navigate={navigate} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </section>
  );
}
