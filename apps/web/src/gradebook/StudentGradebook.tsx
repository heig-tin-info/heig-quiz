/**
 * The student's Grades tab of a classroom (F-GBOOK-05, F-RES-04, ADR-074,
 * M5-04): their own cells, one row per column of the gradebook, in the
 * global Grades page's two groups — what counts, then what does not, its
 * grades indicative (`CountsGroups`, #803). The server
 * narrows everything (`GET /student/classrooms/:id/gradebook`, the gradebook's
 * student exit): this tab filters and computes nothing, and a field the
 * payload lacks — the mean, a weight — is a thing the teacher has not
 * published, so nothing is drawn for it.
 *
 * The four decisions:
 *   - Type: the activity is the bold 14 px identity, kind and date under it
 *     in 13 px muted; the grade the one number, semibold on the right.
 *   - Color: no accent, no primary — a page you read, not act on (invariant 2).
 *     Grades that count wear their band's colour, indicative grades the ink;
 *     the absence its own `info` sigil.
 *   - Space: a card per group, hairline rows, the mean last in the group
 *     that counts; the same on a phone and on a desktop
 *     (a list never needs the sideways scroll of the staff's matrix). On a
 *     course with components of the mean (ADR-131), the group that counts
 *     holds a card per component, under its name, each closed by its mean,
 *     then the mean of the means in a card of its own.
 *   - Finish: a cell that has no grade says why, in words — "grade not
 *     shared", "indicative" — never an empty box.
 *
 * Not `StudentGrades`' table (the global `/grades` page): that one is fed by
 * rows that carry a status and a feedback link, which the gradebook's cells
 * do not (and must not) carry.
 */
import { Trophy } from "lucide-react";
import { useId, type ReactNode } from "react";

import { formatPoints } from "@quiz/domain";
import type { GradebookStudentCell, GradebookStudentColumn, GradebookStudentComponent } from "@quiz/contracts";

import { useT, type TFunction } from "../i18n";
import { Badge, Card, Dash, EmptyState, isoDateParts, QueryError, Skeleton } from "../ui";
import { useStudentGradebook } from "./api";
import { AbsentSigil, GradeOrDash, MODE_LABEL } from "./cells";
import { CountsGroups } from "./groups";

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
      <QueryError title={t("gbook.loadError")} query={book} />
    );
  }
  const data = book.data;
  if (data.columns.length === 0) {
    return (
      <Card>
        <EmptyState icon={Trophy} title={t("sgrades.empty.title")} />
      </Card>
    );
  }
  const rows = (columns: GradebookStudentColumn[], counts: boolean) =>
    columns.map((column) => (
      <li key={column.activityId} className="flex items-start gap-3 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug">{column.title}</p>
          <p className="mt-0.5 text-[13px] text-fg-muted">{caption(column, t)}</p>
        </div>
        <div className="shrink-0 text-right text-[17px] font-semibold leading-snug tabular-nums">
          <CellFace cell={data.cells[column.activityId]} neutral={!counts} t={t} />
        </div>
      </li>
    ));
  return (
    <CountsGroups rows={data.columns}>
      {(columns, counts) =>
        counts && data.components.length > 0 ? (
          // With components (ADR-131): a card per component, closed by its mean; the mean of the means last, alone.
          <div className="space-y-4">
            {data.components.map((component) => (
              <ComponentGroup key={component.id} component={component}>
                {rows(columns.filter((column) => column.componentId === component.id), true)}
                <MeanRow mean={component.mean} help={t("gbook.componentMean.studentHelp")} />
              </ComponentGroup>
            ))}
            {data.mean === undefined ? null : (
              <Card>
                <ul>
                  <MeanRow mean={data.mean} help={t("gbook.mean.componentsStudentHelp")} />
                </ul>
              </Card>
            )}
          </div>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {rows(columns, counts)}
              {/* The mean is of the columns that count: it closes their group. */}
              {counts ? <MeanRow mean={data.mean} help={t("gbook.mean.studentHelp")} /> : null}
            </ul>
          </Card>
        )
      }
    </CountsGroups>
  );
}

/**
 * One component of the mean inside "Count toward your average": its name as
 * a sub-heading, with its weight once the mean is published (the payload
 * carries it only then), over a card of its columns.
 */
function ComponentGroup({ component, children }: { component: GradebookStudentComponent; children: ReactNode }) {
  const t = useT();
  const id = useId();
  return (
    <section className="space-y-1.5" aria-labelledby={id}>
      <h4 id={id} className="text-[13px] font-semibold text-fg-muted">
        {component.name}
        {component.weight === undefined ? null : (
          <span className="font-normal"> · {t("gbook.weight", { weight: String(component.weight) })}</span>
        )}
      </h4>
      <Card>
        <ul className="divide-y divide-line">{children}</ul>
      </Card>
    </section>
  );
}

/** Kind and date, then the weight of a column that counts once the teacher publishes the mean (the payload carries it only then). */
function caption(column: GradebookStudentColumn, t: TFunction): string {
  const parts = [t(MODE_LABEL[column.mode]), isoDateParts(column.date).date];
  if (column.counts && column.weight !== undefined) parts.push(t("gbook.weight", { weight: String(column.weight) }));
  return parts.join(" · ");
}

/**
 * A mean, last of what it averages, only when the payload has it: published
 * by the teacher (`null`: nothing to average yet) — the mean of the group
 * that counts, or of one component. With no column that counts, there is no
 * such group and nothing to average: no mean drawn.
 */
function MeanRow({ mean, help }: { mean: number | null | undefined; help: string }) {
  const t = useT();
  if (mean === undefined) return null;
  return (
    <li className="flex items-start gap-3 bg-surface-2/50 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug">{t("gbook.col.mean")}</p>
        <p className="mt-0.5 text-[13px] text-fg-muted">{help}</p>
      </div>
      <div className="shrink-0 text-right text-[17px] font-semibold leading-snug tabular-nums">
        <GradeOrDash value={mean} />
      </div>
    </li>
  );
}

/** A student cell: the grade, the absence, the excuse in words, or in words why there is none; `neutral`, an indicative grade (it does not count) in the ink. */
function CellFace({ cell, neutral, t }: { cell: GradebookStudentCell | undefined; neutral: boolean; t: TFunction }) {
  switch (cell?.kind) {
    case "grade":
      return <GradeOrDash value={cell.grade} neutral={neutral} />;
    case "absent":
      return <AbsentSigil why={t("gbook.absent.student")} />;
    case "excused":
      return <Badge tone="zinc">{t("gbook.excused.student")}</Badge>;
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
