/**
 * The criteria table of the student's own repository (ADR-106 §9, F-PROJ-24;
 * merge task L-02f), under the score on the student's project page — what
 * the ONE exit (`studentView.ts`) sends and nothing it reconstructs:
 * criterion (its description), max, obtained. Obtained is `—` until a pass
 * or the teacher graded it; an `indicative` badge marks every row not yet
 * validated and released (F-PROJ-14); a lock, a row a milestone graded and
 * locked. The rationale, shown unfolded under its criterion (product owner,
 * 2026-11-06: the student reads why, without a click; the staff's table keeps
 * its fold), exists only after the repository's definitive freeze: the
 * server sends none before. It is plain
 * text — a text node, never markup (N-SEC-14's rule). The table is final
 * once every row is `validated`.
 *
 * No primary action: the page's is the header's. ADR-139 §13: once released,
 * a criterion the server says `contestable` carries a SECONDARY "Contest"
 * under its description; a contested one, the shared record (its state, the
 * reason, the reply) under its row — a group's repository's, which every
 * member reads. A contestation whose criterion left the snapshot keeps its
 * record after the table, named as it read when contested. Three columns on
 * a desktop; under 32 rem of container the rows collapse into a divided list
 * of small cards, the obtained points on the right (DESIGN.md, Tables: a
 * table a STUDENT reads on a phone does not scroll sideways).
 */
import { Lock, MessageSquareWarning } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import type { ProjectStudentContestation, StudentCriteriaRow } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { ContestationRecord, ContestedCriterionHeading, ContestWindowLine } from "../contestation/Contestation";
import { useT } from "../i18n";
import { RationaleText } from "../project/grading/RationaleFold";
import { Badge, Button, Card, cx, pointsBounds, pointsMax, SectionHeading, T, TableHead, Tip, type Column } from "../ui";

/** ADR-139 §13: the repository's contestations, the window, and the act (null when the reader may not file). */
export interface CriteriaContest {
  contestations: readonly ProjectStudentContestation[];
  closesAt: string | null;
  onContest: ((row: StudentCriteriaRow) => void) | null;
  /** The criterion just contested: its record takes the focus the button had. */
  filed: string | null;
}

const NO_CONTEST: CriteriaContest = { contestations: [], closesAt: null, onContest: null, filed: null };

/** What a row draws of its contestation: the act under the criterion, the record under the row. */
interface RowContest {
  action: ReactNode;
  record: ReactNode;
}

export function CriteriaSection({ rows, contest = NO_CONTEST }: { rows: StudentCriteriaRow[]; contest?: CriteriaContest }) {
  const t = useT();
  const final = rows.every((row) => row.state === "validated");
  const byCriterion = new Map(contest.contestations.map((c) => [c.criterionId, c]));
  const offered = (row: StudentCriteriaRow) => contest.onContest !== null && row.contestable && !byCriterion.has(row.criterionId);
  const contestOf = (row: StudentCriteriaRow): RowContest => {
    const contestation = byCriterion.get(row.criterionId);
    return {
      action: offered(row) ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-1.5 self-start"
          aria-label={t("sproj.contest.title", { criterion: row.description })}
          onClick={() => contest.onContest?.(row)}
        >
          <MessageSquareWarning /> {t("contest.action")}
        </Button>
      ) : null,
      record: contestation ? <ProjectContestationRecord contestation={contestation} focus={contest.filed === row.criterionId} /> : null,
    };
  };
  const ids = new Set(rows.map((row) => row.criterionId));
  const removed = contest.contestations.filter((c) => !ids.has(c.criterionId));
  return (
    <section id="criteria" className="scroll-mt-20 space-y-3" data-testid="sproj-criteria">
      <SectionHeading title={t("sproj.criteria")} description={t(final ? "sproj.criteria.final" : "sproj.criteria.provisional")} />
      <ContestWindowLine closesAt={contest.closesAt} contested={contest.contestations.length > 0} offered={rows.some(offered)} />
      <Card className={cx(T.container, "overflow-hidden")}>
        <CriteriaTable rows={rows} contestOf={contestOf} />
        <CriteriaList rows={rows} contestOf={contestOf} />
      </Card>
      {removed.length > 0 ? <RemovedContestations contestations={removed} /> : null}
    </section>
  );
}

/**
 * A criterion's contestation as its members read it: the shared record and,
 * once accepted, that new points stay indicative until the teacher publishes
 * again (decision 9) — the acceptance itself promises no grade.
 */
function ProjectContestationRecord({ contestation, focus = false, children }: { contestation: ProjectStudentContestation; focus?: boolean; children?: ReactNode }) {
  const t = useT();
  return (
    <ContestationRecord contestation={contestation} audience="student" focus={focus}>
      {children}
      {contestation.state === "accepted" ? <p className="text-[13px] text-fg-muted">{t("sproj.contest.indicative")}</p> : null}
    </ContestationRecord>
  );
}

/**
 * The contestations of criteria no longer in the project's criteria (a
 * reload took them out): each named as it read when contested, with its
 * points then.
 */
function RemovedContestations({ contestations }: { contestations: readonly ProjectStudentContestation[] }) {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="sproj-contest-removed">
      <h3 className="text-sm font-semibold">{t("sproj.contest.removed")}</h3>
      {contestations.map((c) => (
        <Card key={c.criterionId} className="space-y-3 p-4">
          <ContestedCriterionHeading contestation={c} />
          <ProjectContestationRecord contestation={c} />
        </Card>
      ))}
    </div>
  );
}

function CriteriaTable({ rows, contestOf }: { rows: StudentCriteriaRow[]; contestOf: (row: StudentCriteriaRow) => RowContest }) {
  const t = useT();
  const columns: Column<string>[] = [
    { key: "criterion", label: t("project.grading.col.criterion") },
    { key: "max", label: t("project.grading.col.max"), right: true, className: "w-20" },
    { key: "obtained", label: t("sproj.criteria.col.obtained"), right: true, className: "w-44" },
  ];
  return (
    <table className={cx(T.table, "hidden table-fixed @lg:table")} aria-label={t("sproj.criteria")}>
      <TableHead columns={columns} />
      <tbody>
        {rows.map((row) => {
          const { action, record } = contestOf(row);
          return (
            <Fragment key={row.criterionId}>
              <tr className={cx(T.row, "align-top")}>
                <td className={cx(T.td, "whitespace-normal")}>
                  <Criterion row={row} />
                  {action}
                </td>
                <td className={cx(T.td, "text-right tabular-nums text-fg-muted")}>
                  <Max row={row} />
                </td>
                <td className={cx(T.td, "text-right")}>
                  <Obtained row={row} />
                </td>
              </tr>
              {record ? (
                // The record continues its criterion's row: no rule between them.
                <tr>
                  <td colSpan={3} className={cx(T.td, "whitespace-normal pt-0")}>
                    {record}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/** The same rows on a phone: a small card each, obtained over max on the right, the marks under them, the record below. */
function CriteriaList({ rows, contestOf }: { rows: StudentCriteriaRow[]; contestOf: (row: StudentCriteriaRow) => RowContest }) {
  return (
    <ul className="divide-y divide-line @lg:hidden">
      {rows.map((row) => {
        const { action, record } = contestOf(row);
        return (
          <li key={row.criterionId} className="space-y-3 px-4 py-3.5">
            <div className="flex items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <Criterion row={row} />
                {action}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <p className="text-sm tabular-nums">
                  <Points row={row} /> <span className="text-[13px] text-fg-muted">/ <Max row={row} /></span>
                </p>
                <Marks row={row} />
              </div>
            </div>
            {record}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The criterion's description, and its rationale unfolded under it when the
 * server sent one, held to a reading measure (ADR-106 §9, amended 2026-11-06).
 */
const Criterion = ({ row }: { row: StudentCriteriaRow }) => (
  <span className="flex flex-col gap-0.5">
    <span className="text-sm font-semibold leading-snug text-fg">{row.description}</span>
    {row.rationale !== undefined ? <RationaleText>{row.rationale}</RationaleText> : null}
  </span>
);

/** The maximum: a bonus criterion's points ride on top of it, a penalty's is negative. */
const Max = ({ row }: { row: StudentCriteriaRow }) => <>{pointsMax(pointsBounds(row))}</>;

/** The points obtained, `—` until graded. */
const Points = ({ row }: { row: StudentCriteriaRow }) => (
  <span className="font-semibold tabular-nums">{row.points === null ? "—" : formatPoints(row.points)}</span>
);

/** The milestone's lock and the indicative badge until final. */
function Marks({ row }: { row: StudentCriteriaRow }) {
  const t = useT();
  if (!row.locked && row.state !== "indicative") return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {row.locked ? (
        <Tip label={t("sproj.criteria.locked")}>
          <Lock role="img" aria-label={t("sproj.criteria.locked")} className="size-3.5 text-fg-faint" />
        </Tip>
      ) : null}
      {row.state === "indicative" ? <Badge tone="zinc">{t("sgrades.indicative")}</Badge> : null}
    </span>
  );
}

/** The table's obtained cell: the marks, then the points. */
const Obtained = ({ row }: { row: StudentCriteriaRow }) => (
  <span className="inline-flex flex-wrap items-center justify-end gap-1.5 text-sm">
    <Marks row={row} />
    <Points row={row} />
  </span>
);
