import { useQuery } from "@tanstack/react-query";
import { BarChart3, CheckCheck, ChevronDown, ChevronRight, ClipboardCheck, Clock, MessageSquareWarning, Table2 } from "lucide-react";
import { useMemo, useState } from "react";

import type { ProjectDetail, ProjectGradingRepo, ProjectGradingView, ProjectStaffContestation } from "@quiz/contracts";
import { formatPoints, formatScore, type GradeBand } from "@quiz/domain";

import { api } from "../../api";
import { AppLink } from "../../AppLink";
import { studentName } from "../../group/groupRules";
import { Grade } from "../../Grade";
import { useT } from "../../i18n";
import { projectGradingKey } from "../../queryKeys";
import { GradeStats } from "../../charts/GradeStats";
import { bucketLabel, bucketTone, GRADE_BAND_BAR, Histogram } from "../../charts/Histogram";
import { Summary } from "../../charts/Summary";
import { useSearchParam, type Navigate } from "../../router";
import { ContestationMark } from "../../grading/Contestation";
import {
  BAR_TONES,
  buttonClass,
  Card,
  cx,
  Dash,
  EmptyState,
  HeldButton,
  pressable,
  QueryError,
  SectionHeading,
  Segmented,
  SegmentedBar,
  Skeleton,
  T,
  Tip,
} from "../../ui";
import {
  cellHeat,
  ratioBand,
  cellValue,
  criteriaStats,
  criteriaTree,
  headerRows,
  markStats,
  rowsById,
  validatedRepos,
  visibleColumns,
  type BinMember,
  type CellValue,
  type MatrixColumn,
  type MatrixGroup,
} from "./matrix";
import { AdjustmentMark } from "../parts";
import {
  cellContestation,
  contestationsByCell,
  ProjectContestationLine,
  useProjectContestations,
} from "./Contestations";
import { GradeAdjustDialog } from "./GradeAdjustDialog";
import { openContestationsWords } from "../../contestation/ContestationLine";
import { releasedWriteHeld } from "../projectPage";

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
 *
 * ADR-139 §13: the contestations are a second read (`Contestations.tsx`),
 * joined on (repository, criterion): above the matrix the shared window
 * line, its open count leading to the contested filter (`?filter=contested`,
 * the bell's link), the filter itself beside the matrix while any
 * repository is contested, a mark on a contested cell and the open count on
 * its repository's row. Once released, the grade adjustment is the owner's:
 * a mark's button is held for anyone else, saying why (`releasedWriteHeld`).
 */
export function GradingTab({
  project,
  navigate,
  owner,
}: {
  project: ProjectDetail;
  navigate: Navigate;
  /** The reader owns the course; null while the role is not known (nothing held, no owner's act offered). */
  owner: boolean | null;
}) {
  const t = useT();
  const view = useQuery<ProjectGradingView>({
    queryKey: projectGradingKey(project.id),
    queryFn: () => api(`/app/api/projects/${project.id}/grading`),
  });
  const contestations = useProjectContestations(project.id);
  const [filterParam, setFilterParam] = useSearchParam("filter", "");
  const asked = filterParam === "contested";
  // The filter applies once the contestations are read: never "none contested" on a read pending or failed.
  const contestedOnly = asked && contestations.data !== undefined;
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

  if (view.isLoading || (asked && contestations.isLoading)) {
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
  const list = contestations.data?.contestations ?? [];
  // The repositories holding a contestation, open or answered: the filter keeps these, and counts them.
  const contestedIds = new Set(list.map((c) => c.repoId));
  const contested = repos.filter((r) => contestedIds.has(r.id));
  const shown = contestedOnly ? contested : repos;
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
          <GradingStats project={project} repos={repos} columns={columns} navigate={navigate} />
        )}
      </section>

      <section aria-labelledby="grading-matrix" className="space-y-3">
        <SectionHeading
          icon={Table2}
          title={<span id="grading-matrix">{t("project.matrix.title")}</span>}
          count={repos.length}
          actions={link}
        />
        {contestations.isError ? (
          <QueryError title={t("project.contest.loadFailed")} query={contestations} />
        ) : contestations.data ? (
          <ProjectContestationLine
            projectId={project.id}
            data={contestations.data}
            isOwner={owner}
            onOpenContested={() => setFilterParam("contested")}
          />
        ) : null}
        {list.length > 0 || contestedOnly ? (
          <Segmented<"all" | "contested">
            name="matrix-filter"
            label={t("project.matrix.filter")}
            value={contestedOnly ? "contested" : "all"}
            options={[
              { value: "all", label: t("project.matrix.filter.all") },
              {
                value: "contested",
                label:
                  contested.length > 0
                    ? t("project.matrix.filter.contested", { n: contested.length })
                    : t("project.matrix.filter.contested.none"),
              },
            ]}
            onChange={(next) => setFilterParam(next === "contested" ? "contested" : "")}
          />
        ) : null}
        {shown.length === 0 ? (
          <Card>
            <EmptyState icon={MessageSquareWarning} title={t("project.matrix.contested.none")} className="py-10" />
          </Card>
        ) : (
          <Matrix
            project={project}
            repos={shown}
            columns={columns}
            onToggle={toggle}
            navigate={navigate}
            contestations={list}
            openByRepo={contestations.data?.openByRepo ?? {}}
            adjustHeld={releasedWriteHeld(project.releasedAt !== null, owner)}
          />
        )}
        <p className="text-xs text-fg-faint">{t("project.matrix.legend")}</p>
      </section>
    </div>
  );
}

/** A band's tint on a cell (its fill on a bar is the Histogram's `GRADE_BAND_BAR`): never a new palette. */
const HEAT_FILL: Record<GradeBand, string> = { fail: "bg-danger-soft", borderline: "bg-warning-soft", pass: "bg-success-soft" };

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
  contestations,
  openByRepo,
  adjustHeld,
}: {
  project: ProjectDetail;
  repos: readonly ProjectGradingRepo[];
  columns: readonly MatrixColumn[];
  onToggle: (key: string) => void;
  navigate: Navigate;
  /** ADR-139 §13: every contestation of the project, marked on its cell. */
  contestations: readonly ProjectStaffContestation[];
  /** The open contestations per repository, on its row. */
  openByRepo: Readonly<Record<string, number>>;
  /** The grade adjustment is held for this reader (ADR-135: the owner's once released). */
  adjustHeld: boolean;
}) {
  const t = useT();
  const byCell = useMemo(() => contestationsByCell(contestations), [contestations]);
  const rows = headerRows(columns);
  const height = rows.length;
  const open = (repo: ProjectGradingRepo) => navigate({ view: "projectGrading", id: project.id }, { query: { repo: repo.id } });
  const [adjusting, setAdjusting] = useState<ProjectGradingRepo | null>(null);
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
            return (
              <tr
                key={repo.id}
                aria-label={t("project.matrix.open", { name: repo.label })}
                className={cx(T.row, T.rowHover, "cursor-pointer", !repo.frozen && "text-fg-faint")}
                data-testid="matrix-row"
                {...pressable(() => open(repo), "row")}
              >
                <th scope="row" className={cx(T.td, "sticky left-0 z-10 bg-surface text-left font-normal group-hover:bg-surface-2")}>
                  <RepoLabel repo={repo} open={openByRepo[repo.id] ?? 0} />
                </th>
                {columns.map((column) => (
                  <MatrixCell
                    key={columnKey(column)}
                    cell={cellValue(column, byId)}
                    frozen={repo.frozen}
                    contestation={cellContestation(byCell, repo.id, column)}
                  />
                ))}
                <td className={cx(T.td, "text-right tabular-nums", PIN_TOTAL, "@2xl:group-hover:bg-surface-2")}>
                  {repo.total ? (
                    <span className="font-semibold">
                      {formatScore(repo.total.points)}/{formatScore(repo.total.max)}
                    </span>
                  ) : (
                    <Dash />
                  )}
                </td>
                <td className={cx(T.td, "text-right font-semibold tabular-nums", PIN_MARK, "@2xl:group-hover:bg-surface-2")}>
                  <MarkCell repo={repo} held={adjustHeld} onAdjust={() => setAdjusting(repo)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {adjusting ? (
        <GradeAdjustDialog
          projectId={project.id}
          repo={adjusting}
          members={membersOf(project, adjusting.id)}
          onClose={() => setAdjusting(null)}
        />
      ) : null}
    </Card>
  );
}

/** The students whose grade a repository's is (a group's members, or its student), by name, from the page's rows. */
const membersOf = (project: ProjectDetail, repoId: string): string[] =>
  project.rows.filter((r) => r.repo?.id === repoId).map((r) => studentName(r.student));

/**
 * A row's mark (ADR-135): the server's grade, adjusted, with its mark. On
 * a repository frozen for good that has a grade (or an adjustment), it is
 * the button that opens the grade adjustment — never the row's own click;
 * `held` for a reader who may not adjust it (a released project, not the
 * owner: ADR-139 §13), saying why.
 */
function MarkCell({ repo, held, onAdjust }: { repo: ProjectGradingRepo; held: boolean; onAdjust: () => void }) {
  const t = useT();
  const mark = repo.grade === null ? <Dash /> : <Grade value={repo.grade} />;
  if (!repo.frozen || (repo.grade === null && repo.adjustment === null)) return mark;
  if (held) {
    return (
      <HeldButton
        variant="ghost"
        size="sm"
        className="-mx-1 h-auto gap-1 px-1 py-0.5 font-semibold"
        disabledReason={t("project.refusal.gradeOwnerRequired")}
        data-testid="matrix-mark-held"
      >
        <span className="sr-only">{t("project.adjust.open", { name: repo.label })}: </span>
        {mark}
        <AdjustmentMark adjustment={repo.adjustment} />
      </HeldButton>
    );
  }
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={(e) => {
        // The mark is not the row: adjusting never opens the grading screen.
        e.stopPropagation();
        onAdjust();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 underline decoration-line-strong decoration-dotted underline-offset-4 transition-colors duration-150 hover:bg-surface-3 hover:decoration-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      data-testid="matrix-mark"
    >
      <span className="sr-only">{t("project.adjust.open", { name: repo.label })}: </span>
      {mark}
      <AdjustmentMark adjustment={repo.adjustment} />
    </button>
  );
}

/** The name, where the repository stands — validated, to validate, or not frozen yet (dimmed) — and its open contestations (ADR-139 §13). */
function RepoLabel({ repo, open }: { repo: ProjectGradingRepo; open: number }) {
  const t = useT();
  const contested = openContestationsWords(open, t);
  const state = repo.validation.validated ? "validated" : repo.frozen ? "toValidate" : "notFrozen";
  const Icon = state === "validated" ? CheckCheck : state === "notFrozen" ? Clock : null;
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("block max-w-36 truncate @lg:max-w-56", repo.frozen && "font-semibold")}>{repo.label}</span>
      {Icon ? (
        <Icon aria-hidden className={cx("size-3.5 shrink-0", state === "validated" ? "text-success" : "text-fg-faint")} />
      ) : null}
      <span className="sr-only">{t(`project.matrix.repo.${state}`)}</span>
      {open > 0 ? (
        <Tip label={contested} className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold tabular-nums text-warning">
          <MessageSquareWarning aria-hidden className="size-3" />
          <span aria-hidden>{open}</span>
          <span className="sr-only">{contested}</span>
        </Tip>
      ) : null}
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

/** Points tinted by their band on a frozen repository; a proposal in italics; nothing given, a dash; a contestation's mark after them. */
function MatrixCell({ cell, frozen, contestation }: { cell: CellValue; frozen: boolean; contestation: ProjectStaffContestation | null }) {
  const t = useT();
  const heat = frozen ? cellHeat(cell) : null;
  const pending = cell.state !== "validated";
  return (
    <td
      className={cx(T.td, "text-center tabular-nums", heat && HEAT_FILL[heat], pending && "italic text-fg-muted", !frozen && "text-fg-faint")}
      {...(cell.points !== null && pending ? { title: t("project.grading.state.proposed") } : {})}
    >
      {cell.points === null ? <Dash /> : formatPoints(cell.points)}
      {contestation ? (
        <span className="ml-1">
          <ContestationMark contestation={contestation} compact />
        </span>
      ) : null}
    </td>
  );
}

/**
 * The card a bar of the marks' histogram opens: its range and count, then
 * who is under it, the best mark first. A row opens that repository's
 * grading, as the matrix's row does.
 */
function BinCard({
  project,
  bucket,
  members,
  navigate,
}: {
  project: ProjectDetail;
  bucket: number;
  members: readonly BinMember[];
  navigate: Navigate;
}) {
  const t = useT();
  const n = members.length;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 border-b border-line pb-2">
        <span className="inline-flex items-center gap-2 text-sm font-semibold tabular-nums text-fg">
          <span aria-hidden className={cx("size-2.5 shrink-0 rounded-[3px]", BAR_TONES[bucketTone(bucket)])} />
          {bucketLabel(bucket)}
        </span>
        <span className="text-xs tabular-nums text-fg-muted">
          {t(n === 1 ? "project.matrix.repos.one" : "project.matrix.repos", { n })}
        </span>
      </div>
      {/* Nine rows and a half (`DETAIL_HEIGHT` of `Bars` counts on it): from the tenth the list scrolls, and the cut row says so. */}
      <ul className="-mx-1.5 max-h-[16.5rem] overflow-y-auto overscroll-contain">
        {members.map(({ repo, mark }) => (
          <li
            key={repo.id}
            className="relative flex items-center justify-between gap-4 rounded-md px-1.5 py-1 text-[13px] transition-colors duration-150 hover:bg-surface-2"
          >
            {/* The whole row is the link; its name says where it goes, as the matrix's row. */}
            <AppLink
              route={{ view: "projectGrading", id: project.id }}
              query={{ repo: repo.id }}
              navigate={navigate}
              className="min-w-0 truncate text-fg after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
            >
              <span className="sr-only">{t("project.matrix.open", { name: repo.label })}</span>
              <span aria-hidden>{repo.label}</span>
            </AppLink>
            <span className="shrink-0 font-semibold tabular-nums">
              <Grade value={mark} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The marks, then each criterion's mean share; over the validated repositories only. */
function GradingStats({
  project,
  repos,
  columns,
  navigate,
}: {
  project: ProjectDetail;
  repos: readonly ProjectGradingRepo[];
  columns: readonly MatrixColumn[];
  navigate: Navigate;
}) {
  const t = useT();
  const marks = markStats(repos);
  const criteria = criteriaStats(columns, repos);
  const { count } = marks.description;
  const detail = (bucket: number) => (
    <BinCard project={project} bucket={bucket} members={marks.members.get(bucket) ?? []} navigate={navigate} />
  );
  return (
    <div className="space-y-3">
      <Summary
        title={t("results.histogram.title")}
        chart={<Histogram buckets={marks.histogram} detail={detail} className="h-40 lg:h-48" />}
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
                  parts={[{ tone: GRADE_BAND_BAR[band], value: ratio, label: t("project.matrix.bar", { percent }) }]}
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
