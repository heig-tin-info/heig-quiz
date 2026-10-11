import type { UseMutationResult } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import type { ProjectDetail, ProjectPatch, ProjectSummary } from "@quiz/contracts";

import { refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { DateField } from "../evaluation/TimingStep";
import { useT, type TFunction } from "../i18n";
import {
  Badge,
  Button,
  cx,
  FieldError,
  fieldErrorProps,
  isoDateTime,
  RingChart,
  RelativeTime,
  Stat,
  type RingPart,
} from "../ui";
import { foreignZone } from "./newProject";
import { RepoLink } from "./parts";
import {
  deadlineDesc,
  deadlinePassed,
  isReopen,
  offersSync,
  projectTally,
  reopenedRepos,
  type ProjectTally,
  type RepoFilter,
} from "./projectPage";

const DEADLINE_ID = "project-deadline";

/** A tile's row of facts: a muted name on the left, its value on the right. */
export function Facts({ rows }: { rows: [label: string, value: ReactNode][] }) {
  return (
    <dl className="space-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-xs text-fg-muted">{label}</dt>
          <dd className="min-w-0 text-right text-[13px] text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A figure that narrows the repositories' table (`aria-pressed`): its count
 * in tabular bold, then its word. A zero is drawn muted and cannot be
 * pressed (there is nothing to show) unless it is the filter in force, so it
 * can be cleared from here too. The one red figure of the page, the alerts,
 * wears `danger` ink while it is not zero.
 */
function SubFigure({
  filter,
  count,
  active,
  onPick,
  danger,
}: {
  filter: RepoFilter;
  count: number;
  active: RepoFilter | null;
  onPick: (filter: RepoFilter | null) => void;
  danger?: boolean;
}) {
  const t = useT();
  const pressed = active === filter;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={count === 0 && !pressed}
      onClick={() => onPick(pressed ? null : filter)}
      className={cx(
        "inline-flex items-baseline gap-1.5 rounded-field border px-2 py-0.5 text-left text-[13px] transition-colors",
        pressed ? "border-line-strong bg-surface-2" : "border-transparent hover:bg-surface-2/70",
        count === 0 ? "text-fg-faint" : danger ? "text-danger" : "text-fg",
        "disabled:cursor-default disabled:hover:bg-transparent",
      )}
    >
      <span className="font-semibold tabular-nums">{count}</span>
      {t(`project.filter.${filter}`)}
    </button>
  );
}

/**
 * The acceptance: the ring's parts in their fixed order, and the words of each
 * (the filters' own words for pending and not accepted) for its sentence.
 */
function acceptanceParts(tally: ProjectTally, groupMode: boolean, t: TFunction): { part: RingPart; word: string }[] {
  const { ready, pending, none } = tally.acceptance;
  return [
    { part: { value: ready, tone: "success" }, word: t("project.accept.ready") },
    ...(groupMode ? [] : [{ part: { value: pending, tone: "warning" }, word: t("project.filter.pending") } as const]),
    { part: { value: none, tone: "faint" }, word: t("project.filter.notAccepted") },
  ];
}

function AcceptanceTile({
  project,
  tally,
  filter,
  onFilter,
}: {
  project: ProjectDetail;
  tally: ProjectTally;
  filter: RepoFilter | null;
  onFilter: (filter: RepoFilter | null) => void;
}) {
  const t = useT();
  const shares = acceptanceParts(tally, project.groupMode, t);
  const { ready, provisionErrors, noGroup, leftRoster } = tally.acceptance;
  const words = [
    provisionErrors > 0 ? t("project.accept.error", { n: provisionErrors }) : null,
    noGroup > 0 ? t("project.accept.noGroup", { n: noGroup }) : null,
    leftRoster > 0 ? t("project.accept.left", { n: leftRoster }) : null,
  ].filter((w) => w !== null);
  return (
    <Stat
      label={t("project.tile.accepted")}
      value={`${ready} / ${tally.total}`}
      visual={
        <RingChart
          parts={shares.map((s) => s.part)}
          total={tally.total}
          size={56}
          thickness={7}
          holeClassName="text-xs"
          hole={tally.total > 0 ? Math.round((ready / tally.total) * 100) : 0}
          sentence={t("project.accept.sentence", {
            label: t("project.tile.accepted"),
            parts: shares.map((s) => `${s.part.value} ${s.word}`).join(" · "),
          })}
        />
      }
    >
      <div className="-mx-2 flex flex-wrap gap-x-1 gap-y-0.5">
        {project.groupMode ? null : (
          <SubFigure filter="pending" count={tally.acceptance.pending} active={filter} onPick={onFilter} />
        )}
        <SubFigure filter="notAccepted" count={tally.acceptance.none} active={filter} onPick={onFilter} />
      </div>
      {words.length > 0 ? <p className="text-xs text-fg-faint">{words.join(" · ")}</p> : null}
    </Stat>
  );
}

/**
 * The deadline, edited where it is shown (F-PROJ-03, F-PROJ-09): moving it
 * later once it has passed REOPENS the project, which is asked first with
 * the number of repositories it reaches; a date already past is refused by
 * the server (`deadline_past`). What `editable` does not name, and an
 * archived project, are drawn disabled. "Passed" is the server's word
 * (`state`, `deadlineAppliedAt`), never this browser's clock.
 */
function DeadlineTile({
  project,
  tally,
  patch,
}: {
  project: ProjectDetail;
  tally: ProjectTally;
  patch: UseMutationResult<ProjectSummary, Error, ProjectPatch>;
}) {
  const t = useT();
  const confirm = useConfirm();
  const busy = patch.isPending || project.archivedAt !== null;
  const deadlineRefused =
    patch.variables?.deadlineAt !== undefined && refusedWith(patch.error, "deadline_past")
      ? t("project.refusal.deadlinePast")
      : undefined;

  const commitDeadline = async (deadlineAt: string | null, reset: () => void) => {
    if (deadlineAt === null) {
      reset();
      return;
    }
    const now = Date.now();
    if (isReopen(project, deadlineAt, now)) {
      const ok = await confirm({
        title: t("project.reopen.title"),
        message: t("project.reopen.body", { n: reopenedRepos(project, deadlineAt, now) }),
        confirmLabel: t("project.reopen.confirm"),
      });
      if (!ok) {
        reset();
        return;
      }
    }
    // A manual deadline counted as a duration becomes a date once set by hand.
    patch.mutate(
      { deadlineAt, ...(project.durationMinutes !== null ? { durationMinutes: null } : {}) },
      { onError: reset },
    );
  };

  const rows: [string, ReactNode][] = [
    [t("project.grace"), `${project.graceMinutes} ${t("project.grace.unit")}`],
    [t("project.tile.frozen"), `${project.counts.frozen} / ${project.counts.live}`],
  ];
  if (tally.own.n > 0) rows.push([t("project.tile.own"), String(tally.own.n)]);

  return (
    <Stat label={t("project.deadline")} value={<span className="text-[17px]">{isoDateTime(project.deadlineAt)}</span>}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {deadlinePassed(project) ? t("project.deadline.passed") : <RelativeTime iso={project.deadlineAt} />}
        <Badge tone="zinc">{t(`project.deadlineStrategy.${project.deadlineStrategy}`)}</Badge>
      </p>
      <Facts rows={rows} />
      <div className="flex flex-col gap-1 pt-1">
        <DateField
          key={project.deadlineAt}
          id={DEADLINE_ID}
          label={t("project.deadline.change")}
          description={deadlineDesc(project, foreignZone(), t)}
          disabled={busy || !project.editable.includes("deadlineAt")}
          value={project.deadlineAt}
          onCommit={(value, reset) => void commitDeadline(value, reset)}
          {...fieldErrorProps(DEADLINE_ID, deadlineRefused)}
        />
        <FieldError id={DEADLINE_ID}>{deadlineRefused}</FieldError>
      </div>
    </Stat>
  );
}

function ProgressTile({
  tally,
  filter,
  onFilter,
}: {
  tally: ProjectTally;
  filter: RepoFilter | null;
  onFilter: (filter: RepoFilter | null) => void;
}) {
  const t = useT();
  const { progress } = tally;
  return (
    <Stat
      label={t("project.tile.progress")}
      value={
        <>
          {progress.pushed} <span className="text-sm font-medium tracking-normal text-fg-muted">{t("project.progress.pushed")}</span>
        </>
      }
    >
      <div className="-mx-2 flex flex-col items-start gap-0.5">
        <SubFigure filter="noCommit" count={progress.noCommit} active={filter} onPick={onFilter} />
        <SubFigure filter="ciFail" count={progress.ciFail} active={filter} onPick={onFilter} />
        <SubFigure filter="toVerify" count={progress.toVerify} active={filter} onPick={onFilter} />
        <SubFigure filter="alerts" count={progress.alerts} active={filter} onPick={onFilter} danger />
      </div>
    </Stat>
  );
}

function SourceTile({
  project,
  onSync,
  syncing,
}: {
  project: ProjectDetail;
  onSync: () => void;
  syncing: boolean;
}) {
  const t = useT();
  const { sync } = project;
  const ahead = sync.ahead;
  return (
    <Stat
      label={t("project.tile.source")}
      value={
        ahead ? (
          <span className="text-[17px]">
            {ahead.commits === null ? t("project.source.aheadUnknown") : t("project.source.ahead", { n: ahead.commits })}
          </span>
        ) : (
          <span className="text-[17px]">{t("project.source.inSync")}</span>
        )
      }
    >
      <Facts
        rows={[
          [t("project.source"), <RepoLink key="s" fullName={project.source.fullName} />],
          [
            t("project.distribution"),
            project.distribution ? (
              <RepoLink key="d" fullName={project.distribution.fullName} />
            ) : (
              <span className="text-fg-muted">{t("project.distribution.building")}</span>
            ),
          ],
          [t("project.branches"), <span key="b" className="font-mono text-xs">{project.branches.join(", ")}</span>],
          [t("project.sourceStrategy"), t(`project.sourceStrategy.${project.sourceStrategy}`)],
          [t("project.publishMode"), t(`project.publishMode.${project.publishMode}`)],
          [
            t("project.gradingMode"),
            project.gradingMode === "auto"
              ? `${t("project.gradingMode.auto")} · ${t(`project.scale.${project.gradingScale.kind}`)}`
              : t("project.gradingMode.none"),
          ],
        ]}
      />
      {sync.syncedAt && sync.last ? (
        <p className="text-xs tabular-nums text-fg-faint" data-testid="project-sync-last">
          {t("project.sync.last", { date: isoDateTime(sync.syncedAt), ...sync.last })}
        </p>
      ) : null}
      {/* The header's secondary Sync moved here; as the primary action it stays in the header. */}
      {offersSync(project) && project.archivedAt === null ? (
        <Button variant="secondary" size="sm" data-coach="project.sync" onClick={onSync} loading={syncing || sync.inProgress}>
          <RefreshCw /> {t(sync.inProgress ? "project.sync.inProgress" : "project.sync")}
        </Button>
      ) : null}
    </Stat>
  );
}

/**
 * The four tiles under a published project's header (DESIGN.md › The project
 * page): the acceptance as a ring, the deadline (edited here), the progress
 * and the source with its sync. The sub-figures of the first and third
 * narrow the repositories' table; the staff's test repository is counted by
 * none of them. A tile is never a button: it holds focusable things.
 */
export function ProjectOverview({
  project,
  patch,
  filter,
  onFilter,
  onSync,
  syncing,
}: {
  project: ProjectDetail;
  patch: UseMutationResult<ProjectSummary, Error, ProjectPatch>;
  filter: RepoFilter | null;
  onFilter: (filter: RepoFilter | null) => void;
  onSync: () => void;
  syncing: boolean;
}) {
  const tally = projectTally(project);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="project-tiles">
      <AcceptanceTile project={project} tally={tally} filter={filter} onFilter={onFilter} />
      <DeadlineTile project={project} tally={tally} patch={patch} />
      <ProgressTile tally={tally} filter={filter} onFilter={onFilter} />
      <SourceTile project={project} onSync={onSync} syncing={syncing} />
    </div>
  );
}
