import { FolderGit2 } from "lucide-react";

import type { ProjectActivitySummary } from "@quiz/contracts";

import { githubAbsent } from "../github/api";
import { useT } from "../i18n";
import type { Route } from "../router";
import {
  Badge,
  Card,
  isoDateTime,
  pressable,
  QueryError,
  SectionHeading,
  T,
  TableHead,
  useSortableTable,
  type Column,
} from "../ui";
import { projectStateLabel, projectStateTone, useClassroomProjects } from "./common";

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
 * No button: "New ▾ › Project" is in the page header, the tab's one primary.
 * A row is a title, its state, its start and its deadline, and opens the
 * project (`ComingSoon` until M3-12); its counts come with M3-08.
 */
export function ProjectGroup({
  classroomId,
  navigate,
}: {
  classroomId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const list = useClassroomProjects(classroomId);
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
              const open = () => navigate({ view: "project", id: row.id });
              return (
                <tr
                  key={row.id}
                  className={`${T.row} ${T.rowHover} cursor-pointer`}
                  onClick={open}
                  {...pressable(open, "row")}
                >
                  <td className={T.td}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{row.title}</span>
                      <Badge tone={projectStateTone(row.state)}>{projectStateLabel(row.state, t)}</Badge>
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
