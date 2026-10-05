/**
 * The student's Grades tab of a classroom (F-GBOOK-05, F-RES-04, ADR-074,
 * M5-04): their own cells, one row per column of the gradebook. The server
 * narrows everything (`GET /student/classrooms/:id/gradebook`, the gradebook's
 * student exit): this tab filters and computes nothing, and a field the
 * payload lacks — the mean, a weight — is a thing the teacher has not
 * published, so nothing is drawn for it.
 *
 * The four decisions:
 *   - Type: the activity is the bold 14 px identity, kind and date under it
 *     in 13 px muted; the grade the one number, semibold on the right.
 *   - Color: no accent, no primary — a page you read, not act on (invariant 2).
 *     Grades wear their band's colour; the absence its own `info` sigil.
 *   - Space: one card, hairline rows, the same on a phone and on a desktop
 *     (a list never needs the sideways scroll of the staff's matrix).
 *   - Finish: a cell that has no grade says why, in words — "grade not
 *     shared", "indicative" — never an empty box.
 *
 * Not `StudentGrades`' table (the global `/grades` page): that one is fed by
 * rows that carry a status and a feedback link, which the gradebook's cells
 * do not (and must not) carry.
 */
import { Trophy } from "lucide-react";

import { formatPoints } from "@quiz/domain";
import type { GradebookStudent, GradebookStudentCell, GradebookStudentColumn } from "@quiz/contracts";

import { useT, type TFunction } from "../i18n";
import { Badge, Card, EmptyState, isoDateParts, QueryError, Skeleton } from "../ui";
import { useStudentGradebook } from "./api";
import { AbsentSigil, Dash, GradeOrDash, MODE_LABEL } from "./cells";

export function StudentGradebook({ classroomId }: { classroomId: string }) {
  const t = useT();
  const book = useStudentGradebook(classroomId);

  if (book.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (book.isError || !book.data) {
    return (
      <QueryError
        title={t("gbook.loadError")}
        error={book.error}
        onRetry={() => void book.refetch()}
        retrying={book.isFetching}
        fallback={t("error.server")}
      />
    );
  }
  const data = book.data;
  if (data.columns.length === 0) {
    return (
      <Card>
        <EmptyState icon={Trophy} title={t("sgrades.empty.title")}>
          {t("sgrades.empty.body")}
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card>
      <ul className="divide-y divide-line">
        {data.columns.map((column) => (
          <li key={column.activityId} className="flex items-start gap-3 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-snug">{column.title}</p>
              <p className="mt-0.5 text-[13px] text-fg-muted">{caption(column, t)}</p>
            </div>
            <div className="shrink-0 text-right text-[17px] font-semibold leading-snug tabular-nums">
              <CellFace cell={data.cells[column.activityId]} t={t} />
            </div>
          </li>
        ))}
        <Mean data={data} />
      </ul>
    </Card>
  );
}

/** Kind and date, then the weight once the teacher publishes the mean (the payload carries it only then). */
function caption(column: GradebookStudentColumn, t: TFunction): string {
  const parts = [t(MODE_LABEL[column.mode]), isoDateParts(column.date).date];
  if (column.counts === false) parts.push(t("gbook.notCounted"));
  else if (column.weight !== undefined) parts.push(t("gbook.weight", { weight: String(column.weight) }));
  return parts.join(" · ");
}

/** The mean, last, only when the payload has it: published by the teacher (`null`: nothing to average yet). */
function Mean({ data }: { data: GradebookStudent }) {
  const t = useT();
  if (data.mean === undefined) return null;
  return (
    <li className="flex items-start gap-3 bg-surface-2/50 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug">{t("gbook.col.mean")}</p>
        <p className="mt-0.5 text-[13px] text-fg-muted">{t("gbook.mean.studentHelp")}</p>
      </div>
      <div className="shrink-0 text-right text-[17px] font-semibold leading-snug tabular-nums">
        <GradeOrDash value={data.mean} />
      </div>
    </li>
  );
}

/** A student cell: the grade, the absence, or in words why there is none. */
function CellFace({ cell, t }: { cell: GradebookStudentCell | undefined; t: TFunction }) {
  switch (cell?.kind) {
    case "grade":
      return <GradeOrDash value={cell.grade} />;
    case "absent":
      return <AbsentSigil why={t("gbook.absent.student")} />;
    case "withheld":
      return <Badge tone="zinc">{t("sgrades.status.withheld")}</Badge>;
    case "indicative":
      return (
        <>
          {cell.points !== null && cell.max !== null ? (
            <p className="text-[13px] font-normal text-fg-muted">
              {formatPoints(cell.points)} / {formatPoints(cell.max)}
            </p>
          ) : null}
          <Badge tone="zinc">{t("sgrades.indicative")}</Badge>
        </>
      );
    default:
      return <Dash />;
  }
}
