import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import {
  CRITERION_RATIONALE_MAX,
  ProjectContestationResolveBody,
  type CriteriaTableRow,
  type ProjectContestations,
  type ProjectGradingRepo,
  type ProjectStaffContestation,
} from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api } from "../../api";
import { ContestationRecord, contestationStateId, ContestedCriterionHeading } from "../../contestation/Contestation";
import { ContestationResponse, type ProposedContestation } from "../../contestation/Proposal";
import { useT, type Dict } from "../../i18n";
import { projectContestationsKey, projectKey } from "../../queryKeys";
import { ContestationLine, type WindowWords } from "../../contestation/ContestationLine";
import { numberOf, PointsField, pointsBounds, pointsMax, pointsRange, SectionHeading, Textarea } from "../../ui";
import type { MatrixColumn } from "./matrix";

/*
 * A project's contestations, for its staff (ADR-139 §13): the second read
 * of the Grading tab and the grading screen — a route of its own, never the
 * grading view the MCP tools forward —, joined to the grading on
 * (repository, criterion). The window's line above the matrix, a mark on a
 * contested cell, the open count on a repository's row, and on the grading
 * screen each contestation of the repository with the owner's one answer.
 */

/** The project's contestations: the window, the open counts, every contestation (open first). */
export function useProjectContestations(projectId: string) {
  return useQuery<ProjectContestations>({
    queryKey: projectContestationsKey(projectId),
    queryFn: () => api(`/app/api/projects/${projectId}/contestations`),
  });
}

/** One cell's key in the join: the repository and the criterion. */
const cellKey = (repoId: string, criterionId: string) => `${repoId}\u0000${criterionId}`;

/** The contestations by cell; one per (repository, criterion) by the server's rule. */
export function contestationsByCell(list: readonly ProjectStaffContestation[]): Map<string, ProjectStaffContestation> {
  return new Map(list.map((c) => [cellKey(c.repoId, c.criterionId), c]));
}

/**
 * The contestation a matrix cell marks: its criterion's, or, for a folded
 * section, the most pressing of its criteria's — an open one before an
 * answered one.
 */
export function cellContestation(
  byCell: ReadonlyMap<string, ProjectStaffContestation>,
  repoId: string,
  column: MatrixColumn,
): ProjectStaffContestation | null {
  const ids = column.kind === "leaf" ? [column.id] : column.leafIds;
  const found = ids.map((id) => byCell.get(cellKey(repoId, id))).filter((c) => c !== undefined);
  return found.find((c) => c.state === "open") ?? found[0] ?? null;
}

const CRITERION_WORDS: WindowWords = {
  unavailable: "project.contest.refusal.unavailable",
  closeBody: "project.contest.close.confirm.body",
};

/**
 * The shared window line (ADR-139 §2, §13) on a project: the open count
 * leading to the contested repositories, the window, and the owner's acts.
 */
export function ProjectContestationLine({
  projectId,
  data,
  isOwner,
  onOpenContested,
}: {
  projectId: string;
  data: ProjectContestations;
  /** The owner's acts are offered on `true` only (null: the role is not known yet). */
  isOwner: boolean | null;
  onOpenContested: () => void;
}) {
  const qc = useQueryClient();
  return (
    <ContestationLine
      path={`/app/api/projects/${projectId}/contestation-window`}
      closesAt={data.closesAt}
      applies={data.applies}
      open={openTotal(data)}
      isOwner={isOwner === true}
      onChanged={() => void qc.invalidateQueries({ queryKey: projectContestationsKey(projectId) })}
      onOpenContested={onOpenContested}
      words={CRITERION_WORDS}
    />
  );
}

/** The owner's answer's refusals a project words, over the shared ones; a proposal's confirmation's too. */
export const ANSWER_REFUSAL: Partial<Record<string, keyof Dict>> = {
  points_out_of_range: "project.contest.answer.refusal.points",
  criterion_removed: "project.contest.answer.refusal.removed",
};

/**
 * The contestations of ONE repository on the grading screen, each under
 * its criterion's words and its points when contested: the shared record
 * (never folded: this screen names the repository), and, while open, the
 * owner's one answer — anyone else reads who answers. A criterion that
 * left the snapshot can only be refused, and says so.
 */
export function RepoContestations({
  projectId,
  repo,
  contestations,
  isOwner,
}: {
  projectId: string;
  repo: ProjectGradingRepo;
  contestations: readonly ProjectStaffContestation[];
  /** The answer is offered on `true`, the sentence saying who answers on `false`; neither while the role is unknown. */
  isOwner: boolean | null;
}) {
  const t = useT();
  const headingId = useId();
  if (contestations.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid="repo-contestations">
      <SectionHeading title={<span id={headingId}>{t("eval.contestation")}</span>} count={contestations.length} />
      {contestations.map((c) => (
        <CriterionContestation
          key={c.id}
          projectId={projectId}
          contestation={c}
          row={repo.table.find((r) => r.criterionId === c.criterionId)}
          isOwner={isOwner}
        />
      ))}
    </section>
  );
}

function CriterionContestation({
  projectId,
  contestation,
  row,
  isOwner,
}: {
  projectId: string;
  contestation: ProjectStaffContestation;
  row: CriteriaTableRow | undefined;
  isOwner: boolean | null;
}) {
  const t = useT();
  const refresh = useProjectRefresh(projectId);
  const open = contestation.state === "open";
  const points = useNewPoints(contestation.inSnapshot ? row : undefined);
  return (
    <section
      id={`contest-${contestation.criterionId}`}
      aria-label={t("project.contest.of", { criterion: contestation.criterionDescription })}
      className="scroll-mt-20 space-y-3 rounded-card border border-line bg-surface p-4"
    >
      <ContestedCriterionHeading
        contestation={contestation}
        detail={<span className="font-mono text-xs text-fg-faint">{contestation.criterionId}</span>}
      />
      <ContestationRecord contestation={contestation} audience="teacher" stateId={contestationStateId(contestation.id)}>
        {contestation.inSnapshot ? null : <p className="text-xs text-fg-muted">{t("project.contest.removed")}</p>}
        {contestation.counted ? null : <p className="text-xs text-fg-muted">{t("project.contest.notCounted")}</p>}
        {open && isOwner === false ? <p className="text-xs text-fg-muted">{t("grading.contest.ownerAnswers")}</p> : null}
      </ContestationRecord>
      <ContestationResponse
        contestation={contestation}
        isOwner={isOwner}
        path={projectContestationPath(projectId)(contestation)}
        onChanged={refresh}
        schema={ProjectContestationResolveBody}
        acceptable={contestation.inSnapshot}
        refusals={ANSWER_REFUSAL}
        points={points}
        outOf={pointsMax(pointsBounds({ max: contestation.maxAtFiling, bonus: contestation.bonusAtFiling ?? undefined }))}
      />
    </section>
  );
}

/**
 * The new points of an answer on a criterion, behind the shared switch: the
 * criterion's own pill over its range and its rationale, as the teacher's
 * criterion write takes them (a `manual` row, still to validate). The
 * rationale is sent only when changed: absent, the row keeps the current
 * one. None when the criterion left the snapshot.
 */
function useNewPoints(row: CriteriaTableRow | undefined) {
  const t = useT();
  const [points, setPoints] = useState(row?.points == null ? "" : String(row.points));
  const [rationale, setRationale] = useState(row?.rationale ?? "");
  if (!row) return undefined;
  const bounds = pointsBounds(row);
  const [lo, hi] = pointsRange(bounds);
  const value = numberOf(points);
  const invalid = !(value >= lo && value <= hi);
  return {
    invalid,
    body: () => ({ points: value, ...(rationale !== (row.rationale ?? "") ? { rationale } : {}) }),
    // Edit (ADR-139 §14): a proposal's points, and its rationale when it gave one.
    fill: (proposed: number, why: string | null) => {
      setPoints(formatPoints(proposed));
      if (why !== null) setRationale(why);
    },
    fields: (
      <div className="space-y-3">
        <PointsField
          label={t("grading.override.points")}
          bounds={bounds}
          value={points}
          onChange={setPoints}
          error={invalid ? t("ui.points.range", { min: formatPoints(lo), max: formatPoints(hi) }) : null}
        />
        <Textarea
          label={t("project.grading.rationale")}
          value={rationale}
          maxLength={CRITERION_RATIONALE_MAX}
          rows={3}
          onChange={(e) => setRationale(e.target.value)}
          className="min-h-20 text-[13px]"
        />
      </div>
    ),
  };
}

/** A project's contestation's base path: its answer, its proposal and the proposal's confirmation under it. */
export const projectContestationPath = (projectId: string) => (c: Pick<ProposedContestation, "id">) =>
  `/app/api/projects/${projectId}/contestations/${c.id}`;

/** What every write on a project's contestation makes stale: the project's reads, its grading and contestations included. */
export function useProjectRefresh(projectId: string): () => void {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: projectKey(projectId) });
}

/** The project's open contestations: the sum of its live repositories' (`openByRepo`). */
export const openTotal = (data: Pick<ProjectContestations, "openByRepo">): number => Object.values(data.openByRepo).reduce((sum, n) => sum + n, 0);
