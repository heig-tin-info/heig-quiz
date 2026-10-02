/**
 * The student's Grades (F-ORG-14, F-RES-04, `docs/merge/05-web.md` §5.2):
 * their finished work, one table per classroom, the classroom of the newest
 * row first, archived classrooms included and marked. The server decides
 * everything a row says (`GET /app/api/student/results`): its status, whether
 * it carries points and a grade (never under the feedback policy `none`,
 * never a grade before the release: an `available` row carries its points
 * alone, marked indicative), and whether it opens a feedback page. This page
 * computes nothing; it draws.
 *
 * The four decisions:
 *   - Type: the classroom's name is the 16 px title of its group; inside a
 *     row the activity is the bold 13 px identity, the grade the one number
 *     set in semibold.
 *   - Color: no accent and no primary — a page you read, not act on
 *     (invariant 2). The grade wears its band's colour (`Grade`), the status
 *     its badge's tone.
 *   - Space: 24 under the header, 32 between classrooms, 12 between a
 *     classroom's heading and its table.
 *   - Finish: a card per classroom, hairline rows, the hover of a row that
 *     opens something and of no other.
 *
 * Under 32 rem of card (a phone) the table gives way to a list of the same
 * rows as small cards: grade on the right, kind and date under the title.
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Trophy } from "lucide-react";

import { formatPoints } from "@quiz/domain";
import type { GradeGroup, GradeRow, GradeStatus, StudentGrades as StudentGradesData } from "@quiz/contracts";

import { api } from "../api";
import { Grade } from "../Grade";
import { feedbackLink } from "../grading";
import { useT, type Dict, type TFunction } from "../i18n";
import { studentGradesKey } from "../queryKeys";
import type { Route } from "../router";
import {
  Badge,
  Card,
  cx,
  EmptyState,
  isoDateParts,
  PageHeader,
  PageSkeleton,
  pressable,
  QueryError,
  SectionHeading,
  T,
  TableHead,
  type Column,
  type Tone,
} from "../ui";
import { MODE_KEY, PendingLine } from "./cards";

const STATUS: Record<GradeStatus, { label: keyof Dict; tone: Tone }> = {
  released: { label: "sgrades.status.released", tone: "green" },
  withheld: { label: "sgrades.status.withheld", tone: "zinc" },
  available: { label: "sgrades.status.available", tone: "green" },
  pending: { label: "sgrades.status.pending", tone: "amber" },
  submitted: { label: "sgrades.status.submitted", tone: "zinc" },
  missed: { label: "sgrades.status.missed", tone: "zinc" },
};


export function StudentGrades({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const grades = useQuery<StudentGradesData>({
    queryKey: studentGradesKey,
    queryFn: () => api("/app/api/student/results"),
  });
  if (grades.isLoading) return <PageSkeleton />;

  const groups = grades.data ?? [];
  return (
    <div className="space-y-6">
      <PageHeader title={t("bnav.grades")} description={t("sgrades.subtitle")} />
      {grades.isError ? (
        <QueryError
          title={t("bnav.grades")}
          error={grades.error}
          onRetry={() => void grades.refetch()}
          retrying={grades.isFetching}
          fallback={t("error.server")}
        />
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState icon={Trophy} title={t("sgrades.empty.title")}>
            {t("sgrades.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <ClassroomGrades key={group.classroom.id} group={group} navigate={navigate} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One classroom: its heading (name, archived, course, period) over its rows. */
function ClassroomGrades({ group, navigate }: { group: GradeGroup; navigate: (r: Route) => void }) {
  const t = useT();
  const room = group.classroom;
  // A project's row opens nothing: its score lives on the project's page (F-PROJ-15).
  const open = (row: GradeRow) =>
    row.kind === "evaluation" && row.feedbackAttemptId !== null
      ? () => navigate(feedbackLink(row.feedbackAttemptId!).route)
      : null;
  return (
    <section className="space-y-3">
      <SectionHeading
        title={
          <span className="flex flex-wrap items-baseline gap-2">
            {room.name}
            {room.archived ? <Badge tone="zinc">{t("classrooms.archived")}</Badge> : null}
          </span>
        }
        description={`${room.courseCode} — ${room.courseName}${room.period ? ` · ${room.period}` : ""}`}
      />
      <Card className={cx(T.container, "overflow-hidden")}>
        <GradeTable rows={group.rows} open={open} />
        <GradeList rows={group.rows} open={open} />
      </Card>
    </section>
  );
}

type Opener = (row: GradeRow) => (() => void) | null;

function GradeTable({ rows, open }: { rows: GradeRow[]; open: Opener }) {
  const t = useT();
  // No sorting: the rows come newest first, the one order a student reads
  // finished work in.
  const columns: Column<string>[] = [
    { key: "title", label: t("sgrades.col.activity"), sortable: false },
    { key: "mode", label: t("sgrades.col.kind"), sortable: false, className: cx(T.colMid, "w-32") },
    { key: "date", label: t("sgrades.col.date"), sortable: false, className: cx(T.colHigh, "w-32") },
    { key: "points", label: t("results.col.points"), sortable: false, right: true, className: "w-24" },
    { key: "grade", label: t("results.col.grade"), sortable: false, right: true, className: "w-20" },
    { key: "status", label: t("sgrades.col.status"), sortable: false, className: "w-44" },
    { key: "open", label: t("shome.review"), sortable: false, srOnly: true, className: "w-10" },
  ];
  return (
    <table className={cx(T.table, "hidden table-fixed @lg:table")}>
      <TableHead columns={columns} sort={null} onToggle={() => {}} />
      <tbody>
        {rows.map((row) => {
          const go = open(row);
          return (
            <tr
              key={keyOf(row)}
              className={cx(T.row, go && cx(T.rowHover, "cursor-pointer"))}
              {...(go ? { onClick: go, ...pressable(go, "row") } : {})}
            >
              <td className={T.td}>
                <span className="font-semibold">{row.title}</span>
                {/* Where the kind and the date columns have left, they ride
                    under the title. */}
                <span className="mt-0.5 block text-fg-muted @2xl:hidden">{caption(row, t)}</span>
              </td>
              <td className={cx(T.td, T.colMid, "text-fg-muted")}>{kindOf(row, t)}</td>
              <td className={cx(T.td, T.colHigh, "tabular-nums text-fg-muted")}>{dateOf(row)}</td>
              <td className={cx(T.td, "text-right tabular-nums")}>
                <Points row={row} />
              </td>
              <td className={cx(T.td, "text-right font-semibold tabular-nums")}>
                <GradeCell row={row} />
              </td>
              <td className={T.td}>
                <StatusBadge status={row.status} />
                <Pending row={row} />
              </td>
              <td className={cx(T.td, "text-right")}>
                {go ? <ChevronRight aria-hidden className="ml-auto size-4 text-fg-faint" /> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The same rows on a phone: a small card each, the grade on the right. */
function GradeList({ rows, open }: { rows: GradeRow[]; open: Opener }) {
  const t = useT();
  return (
    <ul className="divide-y divide-line @lg:hidden">
      {rows.map((row) => {
        const go = open(row);
        return (
          <li
            key={keyOf(row)}
            className={cx(
              "flex items-start gap-3 px-4 py-3.5",
              go && "cursor-pointer transition-colors hover:bg-surface-2/70",
            )}
            {...(go ? { onClick: go, ...pressable(go, "link"), "aria-label": row.title } : {})}
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-snug">{row.title}</p>
              <p className="mt-0.5 text-[13px] text-fg-muted">{caption(row, t)}</p>
              <div className="mt-2">
                <StatusBadge status={row.status} />
                <Pending row={row} />
              </div>
            </div>
            <div className="shrink-0 text-right">
              {/* The indicative badge keeps its own size, outside the grade's 17 px line. */}
              {row.score?.grade === null ? (
                <GradeCell row={row} />
              ) : (
                <p className="text-[17px] font-semibold leading-snug tabular-nums">
                  <GradeCell row={row} />
                </p>
              )}
              {/* One dash says "no grade"; a second under it would say nothing more. */}
              {row.score ? (
                <p className="mt-0.5 text-[13px] tabular-nums text-fg-muted">
                  <Points row={row} />
                </p>
              ) : null}
            </div>
            {go ? <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-fg-faint" /> : null}
          </li>
        );
      })}
    </ul>
  );
}

const dateOf = (row: GradeRow) => isoDateParts(row.date).date;

const keyOf = (row: GradeRow) => (row.kind === "evaluation" ? row.evaluationId : row.projectId);

/** An evaluation's mode, or "Project". */
const kindOf = (row: GradeRow, t: TFunction) =>
  t(row.kind === "evaluation" ? MODE_KEY[row.mode] : "sgrades.kind.project");

/** Kind and date, the line under the title where their columns are gone. */
const caption = (row: GradeRow, t: TFunction) => `${kindOf(row, t)} · ${dateOf(row)}`;

function Points({ row }: { row: GradeRow }) {
  return row.score ? (
    <>
      {formatPoints(row.score.points)} / {formatPoints(row.score.totalPoints)}
    </>
  ) : (
    <Dash />
  );
}

/**
 * The grade, or where there is none: "indicative" beside points read before
 * the release (F-RES-04), a dash otherwise.
 */
function GradeCell({ row }: { row: GradeRow }) {
  const t = useT();
  if (!row.score) return <Dash />;
  if (row.score.grade === null) return <Badge tone="zinc">{t("sgrades.indicative")}</Badge>;
  return <Grade value={row.score.grade} />;
}

/** Under the status of points read before the release: the questions still to grade. */
const Pending = ({ row }: { row: GradeRow }) =>
  row.kind === "evaluation" && row.score ? (
    <PendingLine count={row.score.pendingCount} className="mt-1" />
  ) : null;

function StatusBadge({ status }: { status: GradeStatus }) {
  const t = useT();
  return <Badge tone={STATUS[status].tone}>{t(STATUS[status].label)}</Badge>;
}

const Dash = () => <span className="text-fg-faint">—</span>;
