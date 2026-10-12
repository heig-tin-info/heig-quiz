/**
 * The criteria table of the student's own repository (ADR-106 §9, F-PROJ-24;
 * merge task L-02f), under the score on the student's project page — what
 * the ONE exit (`studentView.ts`) sends and nothing it reconstructs:
 * criterion (its description), max, obtained. Obtained is `—` until a pass
 * or the teacher graded it; an `indicative` badge marks every row not yet
 * validated and released (F-PROJ-14); a lock, a row a milestone graded and
 * locked. The rationale, folded under its criterion, exists only after the
 * repository's definitive freeze: the server sends none before. It is plain
 * text — a text node, never markup (N-SEC-14's rule). The table is final
 * once every row is `validated`.
 *
 * No action: the page's primary action is the header's. Three columns on a
 * desktop; under 32 rem of container the rows collapse into a divided list
 * of small cards, the obtained points on the right (DESIGN.md, Tables: a
 * table a STUDENT reads on a phone does not scroll sideways).
 */
import { Lock } from "lucide-react";

import type { StudentCriteriaRow } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { useT } from "../i18n";
import { RationaleFold, RationaleText } from "../project/grading/RationaleFold";
import { Badge, Card, cx, SectionHeading, T, TableHead, Tip, type Column } from "../ui";

export function CriteriaSection({ rows }: { rows: StudentCriteriaRow[] }) {
  const t = useT();
  const final = rows.every((row) => row.state === "validated");
  return (
    <section className="space-y-3" data-testid="sproj-criteria">
      <SectionHeading title={t("sproj.criteria")} description={t(final ? "sproj.criteria.final" : "sproj.criteria.provisional")} />
      <Card className={cx(T.container, "overflow-hidden")}>
        <CriteriaTable rows={rows} />
        <CriteriaList rows={rows} />
      </Card>
    </section>
  );
}

function CriteriaTable({ rows }: { rows: StudentCriteriaRow[] }) {
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
        {rows.map((row) => (
          <tr key={row.criterionId} className={cx(T.row, "align-top")}>
            <td className={cx(T.td, "whitespace-normal")}>
              <Criterion row={row} />
            </td>
            <td className={cx(T.td, "text-right tabular-nums text-fg-muted")}>
              <Max row={row} />
            </td>
            <td className={cx(T.td, "text-right")}>
              <Obtained row={row} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The same rows on a phone: a small card each, obtained over max on the right, the marks under them. */
function CriteriaList({ rows }: { rows: StudentCriteriaRow[] }) {
  return (
    <ul className="divide-y divide-line @lg:hidden">
      {rows.map((row) => (
        <li key={row.criterionId} className="flex items-start gap-3 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <Criterion row={row} />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <p className="text-sm tabular-nums">
              <Points row={row} /> <span className="text-[13px] text-fg-muted">/ <Max row={row} /></span>
            </p>
            <Marks row={row} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The criterion's description, and its rationale folded under it when the server sent one. */
const Criterion = ({ row }: { row: StudentCriteriaRow }) => (
  <span className="flex flex-col gap-0.5">
    <span className="text-sm font-semibold leading-snug text-fg">{row.description}</span>
    {row.rationale !== undefined ? (
      <RationaleFold>
        <RationaleText>{row.rationale}</RationaleText>
      </RationaleFold>
    ) : null}
  </span>
);

/** A bonus criterion's points ride on top of the maximum. */
const Max = ({ row }: { row: StudentCriteriaRow }) => <>{row.bonus !== undefined ? `+${formatPoints(row.bonus)}` : formatPoints(row.max)}</>;

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
