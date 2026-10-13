import { useQuery } from "@tanstack/react-query";
import { BarChart3, CheckCheck, ChevronDown, ChevronRight, ClipboardCheck, Clock, Table2 } from "lucide-react";
import { useMemo, useState } from "react";

import type { ProjectDetail, ProjectGradingRepo, ProjectGradingView } from "@quiz/contracts";
import { formatPoints, type GradeBand } from "@quiz/domain";

import { api } from "../../api";
import { AppLink } from "../../AppLink";
import { Grade } from "../../Grade";
import { useT } from "../../i18n";
import { projectGradingKey } from "../../queryKeys";
import { GradeStats } from "../../charts/GradeStats";
import { Histogram } from "../../charts/Histogram";
import { Summary } from "../../charts/Summary";
import type { Navigate } from "../../router";
import {
  buttonClass,
  Card,
  cx,
  Dash,
  EmptyState,
  pressable,
  QueryError,
  SectionHeading,
  SegmentedBar,
  Skeleton,
  T,
  type BarTone,
} from "../../ui";
import {
  cellHeat,
  ratioBand,
  cellValue,
  criteriaStats,
  criteriaTree,
  headerRows,
  markStats,
  repoMark,
  rowsById,
  validatedRepos,
  visibleColumns,
  type CellValue,
  type MatrixColumn,
  type MatrixGroup,
} from "./matrix";

/**
 * The Grading tab of a project graded by criteria (ADR-106 §8 as amended
 * 2026-10-13): what the class did, read only. Above, the statistics of the
 * VALIDATED repositories ("n of N validated"): the marks' distribution with
 * the results' `Summary` and `Histogram`, then each criterion's mean share of
 * its maximum, the weakest first, the penalties and bonuses counted apart.
 * Below, the matrix: a row per repository (a student's or a group's), a
 * column per criterion — folded by the snapshot's sections, a section's
 * column its sum, unfolded by its header —, the total of the payload (clamped,
 * never re-summed here) and the mark by the project's scale, both pinned on
 * the right. A row opens the grading screen on its repository. No primary
 * action here: the header's is the page's; the way to the grading screen is
 * a ghost link. The pure rules are `matrix.ts`.
 */
export function GradingTab({ project, navigate }: { project: ProjectDetail; navigate: Navigate }) {
  const t = useT();
  const view = useQuery<ProjectGradingView>({
    queryKey: projectGradingKey(project.id),
    queryFn: () => api(`/app/api/projects/${project.id}/grading`),
  });
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const repos = view.data?.repos ?? [];
  const tree = useMemo(() => criteriaTree(repos[0]?.table ?? []), [repos]);
  const columns = useMemo(() => visibleColumns(tree, open), [tree, open]);
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const link = (
    <AppLink route={{ view: "projectGrading", id: project.id }} navigate={navigate} className={buttonClass("ghost", "sm")}>
      <ClipboardCheck /> {t("project.grading.openLink")}
    </AppLink>
  );

  if (view.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (view.isError) return <QueryError title={t("project.matrix.loadFailed")} query={view} />;
  if (repos.length === 0) {
    return (
      <Card>
        <EmptyState icon={ClipboardCheck} title={t("project.gradingTab.title")} action={link}>
          {t("project.gradingTab.body")}
        </EmptyState>
      </Card>
    );
  }

  const validated = validatedRepos(repos).length;
  return (
    <div className="space-y-8">
      <section aria-labelledby="grading-stats" className="space-y-3">
        <SectionHeading
          icon={BarChart3}
          title={<span id="grading-stats">{t("project.matrix.stats")}</span>}
          description={<span data-testid="grading-validated">{t("project.matrix.validated", { n: validated, total: repos.length })}</span>}
        />
        {validated === 0 ? (
          <Card>
            <EmptyState icon={BarChart3} title={t("project.matrix.noValidated.title")} className="py-10">
              {t("project.matrix.noValidated.body")}
            </EmptyState>
          </Card>
        ) : (
          <GradingStats project={project} repos={repos} columns={columns} />
        )}
      </section>

      <section aria-labelledby="grading-matrix" className="space-y-3">
        <SectionHeading
          icon={Table2}
          title={<span id="grading-matrix">{t("project.matrix.title")}</span>}
          count={repos.length}
          actions={link}
        />
        <Matrix project={project} repos={repos} columns={columns} onToggle={toggle} navigate={navigate} />
        <p className="text-xs text-fg-faint">{t("project.matrix.legend")}</p>
      </section>
    </div>
  );
}

/** A band's tint on a cell, and its fill on a bar: the Histogram's meaning, never a new palette. */
const HEAT_FILL: Record<GradeBand, string> = { fail: "bg-danger-soft", borderline: "bg-warning-soft", pass: "bg-success-soft" };
const HEAT_BAR: Record<GradeBand, BarTone> = { fail: "danger", borderline: "warning", pass: "success" };

/** The total and the mark stay in view while the criteria scroll, once the card has room (the gradebook's mean). */
const PIN = "@2xl:sticky @2xl:z-10 @2xl:bg-surface";
const PIN_TOTAL = `${PIN} @2xl:right-16 @2xl:border-l @2xl:border-line`;
const PIN_MARK = `${PIN} @2xl:right-0 w-16`;

const columnKey = (c: MatrixColumn) => (c.kind === "leaf" ? c.id : `section:${c.key}`);

function Matrix({
  project,
  repos,
  columns,
  onToggle,
  navigate,
}: {
  project: ProjectDetail;
  repos: readonly ProjectGradingRepo[];
  columns: readonly MatrixColumn[];
  onToggle: (key: string) => void;
  navigate: Navigate;
}) {
  const t = useT();
  const rows = headerRows(columns);
  const height = rows.length;
  const open = (repo: ProjectGradingRepo) => navigate({ view: "projectGrading", id: project.id }, { query: { repo: repo.id } });
  return (
    <Card className={cx(T.container, "overflow-x-auto")}>
      <table className={cx(T.table, "min-w-max")}>
        <thead className={T.head}>
          {rows.map((cells, depth) => (
            <tr key={depth} className={depth > 0 ? "border-t border-line" : undefined}>
              {depth === 0 ? (
                <th scope="col" rowSpan={height} className={cx(T.th, "sticky left-0 z-10 bg-surface align-bottom")}>
                  {t(project.groupMode ? "project.col.group" : "results.col.student")}
                </th>
              ) : null}
              {cells.map((cell) =>
                cell.kind === "open" ? (
                  <th key={`open:${cell.group.key}`} scope="colgroup" colSpan={cell.colSpan} className={cx(T.th, "border-l border-line text-left")}>
                    <SectionToggle group={cell.group} expanded onToggle={onToggle} />
                  </th>
                ) : (
                  <th
                    key={columnKey(cell.column)}
                    scope="col"
                    rowSpan={cell.rowSpan}
                    className={cx(T.th, "align-bottom text-center", cell.column.chain.length === 0 && "border-l border-line")}
                  >
                    <ColumnHead column={cell.column} onToggle={onToggle} />
                  </th>
                ),
              )}
              {depth === 0 ? (
                <>
                  <th scope="col" rowSpan={height} className={cx(T.th, "text-right align-bottom", PIN_TOTAL)}>
                    {t("project.matrix.col.total")}
                  </th>
                  <th scope="col" rowSpan={height} className={cx(T.th, "text-right align-bottom", PIN_MARK)}>
                    {t("project.matrix.col.mark")}
                  </th>
                </>
              ) : null}
            </tr>
          ))}
        </thead>
        <tbody>
          {repos.map((repo) => {
            const byId = rowsById(repo);
            const mark = repo.validation.validated ? repoMark(repo, project.gradingScale) : null;
            return (
              <tr
                key={repo.id}
                aria-label={t("project.matrix.open", { name: repo.label })}
                className={cx(T.row, T.rowHover, "cursor-pointer", !repo.frozen && "text-fg-faint")}
                data-testid="matrix-row"
                {...pressable(() => open(repo), "row")}
              >
                <th scope="row" className={cx(T.td, "sticky left-0 z-10 bg-surface text-left font-normal group-hover:bg-surface-2")}>
                  <RepoLabel repo={repo} />
                </th>
                {columns.map((column) => (
                  <MatrixCell key={columnKey(column)} cell={cellValue(column, byId)} frozen={repo.frozen} />
                ))}
                <td className={cx(T.td, "text-right tabular-nums", PIN_TOTAL, "@2xl:group-hover:bg-surface-2")}>
                  {repo.total ? (
                    <span className="font-semibold">
                      {formatPoints(repo.total.points)}/{formatPoints(repo.total.max)}
                    </span>
                  ) : (
                    <Dash />
                  )}
                </td>
                <td className={cx(T.td, "text-right font-semibold tabular-nums", PIN_MARK, "@2xl:group-hover:bg-surface-2")}>
                  {mark === null ? <Dash /> : <Grade value={mark} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/** The name, and where the repository stands: validated, to validate, or not frozen yet (dimmed). */
function RepoLabel({ repo }: { repo: ProjectGradingRepo }) {
  const t = useT();
  const state = repo.validation.validated ? "validated" : repo.frozen ? "toValidate" : "notFrozen";
  const Icon = state === "validated" ? CheckCheck : state === "notFrozen" ? Clock : null;
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("block max-w-36 truncate @lg:max-w-56", repo.frozen && "font-semibold")}>{repo.label}</span>
      {Icon ? (
        <Icon aria-hidden className={cx("size-3.5 shrink-0", state === "validated" ? "text-success" : "text-fg-faint")} />
      ) : null}
      <span className="sr-only">{t(`project.matrix.repo.${state}`)}</span>
    </span>
  );
}

/** A folded section's head is the button that unfolds it; a leaf's names its criterion, described in full on hover. */
function ColumnHead({ column, onToggle }: { column: MatrixColumn; onToggle: (key: string) => void }) {
  if (column.kind === "group") return <SectionToggle group={column} expanded={false} onToggle={onToggle} />;
  return (
    <span title={`${column.id} — ${column.description}`} className="inline-flex flex-col items-center leading-tight">
      <span className="block max-w-32 truncate font-mono text-[12px] text-fg">{column.label}</span>
      <span className="sr-only"> — {column.description}</span>
      <span className="text-[11px] tabular-nums text-fg-faint">{column.role === "bonus" ? `+${formatPoints(column.max)}` : formatPoints(column.max)}</span>
    </span>
  );
}

function SectionToggle({ group, expanded, onToggle }: { group: MatrixGroup; expanded: boolean; onToggle: (key: string) => void }) {
  const t = useT();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      title={t(expanded ? "project.matrix.fold" : "project.matrix.unfold", { section: group.key })}
      onClick={(e) => {
        // The head is not the row: unfolding never opens a repository.
        e.stopPropagation();
        onToggle(group.key);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <Chevron aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
      <span className="inline-flex flex-col items-start leading-tight">
        <span className="block max-w-32 truncate font-mono text-[12px] font-semibold text-fg">{group.label}</span>
        {expanded ? null : <span className="text-[11px] tabular-nums text-fg-faint">{formatPoints(group.max)}</span>}
      </span>
    </button>
  );
}

/** Points tinted by their band on a frozen repository; a proposal in italics; nothing given, a dash. */
function MatrixCell({ cell, frozen }: { cell: CellValue; frozen: boolean }) {
  const t = useT();
  const heat = frozen ? cellHeat(cell) : null;
  const pending = cell.state !== "validated";
  return (
    <td
      className={cx(T.td, "text-center tabular-nums", heat && HEAT_FILL[heat], pending && "italic text-fg-muted", !frozen && "text-fg-faint")}
      {...(cell.points !== null && pending ? { title: t("project.grading.state.proposed") } : {})}
    >
      {cell.points === null ? <Dash /> : formatPoints(cell.points)}
    </td>
  );
}

/** The marks, then each criterion's mean share; over the validated repositories only. */
function GradingStats({
  project,
  repos,
  columns,
}: {
  project: ProjectDetail;
  repos: readonly ProjectGradingRepo[];
  columns: readonly MatrixColumn[];
}) {
  const t = useT();
  const marks = markStats(repos, project.gradingScale);
  const criteria = criteriaStats(columns, repos);
  const { count } = marks.description;
  return (
    <div className="space-y-3">
      <Summary
        title={t("results.histogram.title")}
        chart={<Histogram buckets={marks.histogram} className="h-40 lg:h-48" />}
        stats={
          <GradeStats
            description={marks.description}
            countLabel={t("project.matrix.repos", { n: count })}
            passing={marks.passing}
            total={count}
          />
        }
      />
      <Card className="space-y-4 p-5">
        <SectionHeading title={t("project.matrix.byCriterion")} description={t("project.matrix.byCriterion.desc")} />
        <ul className="space-y-2" data-testid="criteria-bars">
          {criteria.criteria.map(({ column, ratio }) => {
            const band = ratioBand(ratio);
            const percent = Math.round(ratio * 100);
            return (
              <li key={columnKey(column)} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_3rem] items-center gap-3 text-[13px]">
                {/* Out of the matrix's heads, a criterion is named in full. */}
                <span className="truncate font-mono text-[12px]" title={column.kind === "leaf" ? column.description : column.key}>
                  {column.kind === "leaf" ? column.id : column.key}
                </span>
                <SegmentedBar
                  total={1}
                  parts={[{ tone: HEAT_BAR[band], value: ratio, label: t("project.matrix.bar", { percent }) }]}
                />
                <span className="text-right tabular-nums text-fg-muted">{percent}%</span>
              </li>
            );
          })}
        </ul>
        {criteria.penalties.length + criteria.bonuses.length > 0 ? (
          <ul className="space-y-1 border-t border-line pt-3 text-[13px] text-fg-muted" data-testid="criteria-extras">
            {criteria.penalties.map(({ column, count: n }) => (
              <li key={columnKey(column)}>
                <span className="font-mono text-[12px] text-fg">{column.label}</span> ·{" "}
                {t("project.matrix.penalty", { n, total: count })}
              </li>
            ))}
            {criteria.bonuses.map(({ column, count: n }) => (
              <li key={columnKey(column)}>
                <span className="font-mono text-[12px] text-fg">{column.label}</span> · {t("project.matrix.bonus", { n, total: count })}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}
