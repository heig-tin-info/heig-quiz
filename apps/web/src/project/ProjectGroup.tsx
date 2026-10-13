import { useQuery } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import { useState } from "react";

import { ProjectPatch, type ProjectActivitySummary } from "@quiz/contracts";

import { ActivityMenu } from "../activities/actions";
import { isScheduled } from "../activities/model";
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
  SectionHeading,
  T,
  TableHead,
  TextFieldDialog,
  useSortableTable,
} from "../ui";
import { useRenameProject } from "./useProjectPatch";

type SortKey = "title" | "start" | "deadline";

/** What the rename dialog reads of a row. */
type Renamed = Pick<ProjectActivitySummary, "id" | "title">;

/** `GET /classrooms/:id/projects` (M3-02), archived ones excepted. */
export function useClassroomProjects(classroomId: string) {
  return useQuery<ProjectActivitySummary[]>({
    queryKey: classroomProjectsKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}/projects`),
  });
}

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
 * GitHub, as links in sight (M3-14a, M3-14h), and a Rename button (#804).
 */
export function ProjectGroup({
  classroomId,
  navigate,
  scheduledOnly = false,
}: {
  classroomId: string;
  navigate: (r: Route) => void;
  /** The classroom's "Scheduled" filter (#787): only the projects in their scheduled phase. */
  scheduledOnly?: boolean;
}) {
  const t = useT();
  /** The row being renamed (#804). */
  const [renaming, setRenaming] = useState<Renamed | null>(null);
  const list = useClassroomProjects(classroomId);
  const rows = scheduledOnly ? (list.data ?? []).filter(isScheduled) : (list.data ?? []);
  // An empty date (null) sorts last, whichever way the column goes (`useSortableTable`).
  const { sorted, sort, toggle } = useSortableTable<ProjectActivitySummary, SortKey>(
    rows,
    (row, key) => (key === "start" ? row.startAt : key === "deadline" ? row.deadlineAt : row.title),
    null,
  );

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
            {sorted.map((row) => {
              return (
                <tr
                  key={row.id}
                  className={`${T.row} ${T.rowHover} cursor-pointer`}
                  {...openProps(row, navigate, "row")}
                >
                  <td className={T.td}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{row.title}</span>
                      {/* The time left rides in the badge (`projectTimerAt`, ADR-104); the deadline cell keeps the date alone. */}
                      <StateBadge row={row} timer />
                    </span>
                  </td>
                  <td className={`${T.td} ${T.colHigh} tabular-nums text-fg-muted`}>{row.startAt === null ? <Dash /> : isoDateTime(row.startAt)}</td>
                  <td className={`${T.td} tabular-nums text-fg-muted`}>
                    {row.deadlineAt === null ? <Dash /> : isoDateTime(row.deadlineAt)}
                  </td>
                  <td className={`${T.td} text-right`} onClick={(e) => e.stopPropagation()}>
                    <ActivityMenu row={row} navigate={navigate} onRename={setRenaming} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      {renaming ? (
        <RenameProjectDialog project={renaming} classroomId={classroomId} onClose={() => setRenaming(null)} />
      ) : null}
    </section>
  );
}

/**
 * "Rename" from a row (#804): the page's own rename (`useRenameProject`), so
 * the same route, schema, refresh and toasts as the name renamed in place.
 */
function RenameProjectDialog({
  project,
  classroomId,
  onClose,
}: {
  project: Renamed;
  classroomId: string;
  onClose: () => void;
}) {
  const t = useT();
  const { rename, pending } = useRenameProject(project.id, classroomId);
  return (
    <TextFieldDialog
      title={t("project.rename", { name: project.title })}
      label={t("project.name")}
      initial={project.title}
      submitLabel={t("common.rename")}
      valid={(name) => ProjectPatch.safeParse({ name }).success}
      submitting={pending}
      onSubmit={(name) => rename(name, onClose)}
      onClose={onClose}
    />
  );
}
