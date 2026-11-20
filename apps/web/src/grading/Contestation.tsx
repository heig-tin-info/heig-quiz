import { MessageSquare, MessageSquareWarning } from "lucide-react";

import type { GradingEntry, GradingQueueItem, StaffContestation } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { CONTESTATION_STATE, ContestationRecord, contestationStateId } from "../contestation/Contestation";
import { ContestationResponse, ProposalSign, type ProposedContestation } from "../contestation/Proposal";
import { useT } from "../i18n";
import { Badge, cx, Tip } from "../ui";
import { PointsFields, usePointsDraft } from "./PointsDraft";
import { useGradingInvalidate } from "./useGradingInvalidate";

/**
 * A student's contestation of one cell, on the grading screen (ADR-139):
 * the mark of its row, the record above the answer, and the owner's one
 * answer below it.
 */

/**
 * A row's mark: an open contestation in amber, an answered one quiet; the
 * verdict in the tooltip. `compact`, the icon alone (a matrix's cell, ADR-139
 * §13), the verdict its accessible name. An open one an AI assistant
 * prepared (ADR-139 §14) carries the `Bot` after its icon, and says so.
 */
export function ContestationMark({
  contestation,
  compact = false,
}: {
  contestation: (Pick<StaffContestation, "state"> & { proposal?: StaffContestation["proposal"] }) | null;
  compact?: boolean;
}) {
  const t = useT();
  if (!contestation) return null;
  const open = contestation.state === "open";
  const prepared = open && contestation.proposal != null;
  const label = prepared ? t("contest.proposal.ready") : t(CONTESTATION_STATE[contestation.state].label);
  if (compact) {
    const Icon = open ? MessageSquareWarning : MessageSquare;
    return (
      <Tip label={label} className="inline-flex items-center gap-0.5 align-middle">
        <Icon role="img" aria-label={t(CONTESTATION_STATE[contestation.state].label)} className={cx("size-3.5", open ? "text-warning" : "text-fg-faint")} />
        {prepared ? <ProposalSign className="size-3 text-warning" /> : null}
      </Tip>
    );
  }
  return (
    <Tip label={label}>
      <Badge tone={open ? "amber" : "zinc"} icon={open ? MessageSquareWarning : MessageSquare}>
        {t(CONTESTATION_STATE[contestation.state].badge)}
        {prepared ? <ProposalSign /> : null}
      </Badge>
    </Tip>
  );
}

/** An exam's contestation's base path: its answer, its proposal and the proposal's confirmation under it. */
export const examContestationPath = (c: Pick<ProposedContestation, "id">) => `/app/api/contestations/${c.id}`;

/**
 * Above the answer: the reason and its date, the verdict and the reply once
 * answered. Under Anonymise the reason is folded (decision 4): the teacher
 * reads the answer first, then unfolds it. The server sends it either way,
 * and never a name.
 */
export function ContestationReason({
  contestation,
  named,
  resolver,
}: {
  contestation: StaffContestation;
  named: boolean;
  /** The reader answers it (the course's owner, ADR-068 §3): no sentence saying who does. */
  resolver: boolean;
}) {
  const t = useT();
  return (
    <section aria-label={t("grading.contest.title")} className="rounded-card border border-line p-3">
      <ContestationRecord contestation={contestation} audience="teacher" folded={!named} stateId={contestationStateId(contestation.id)}>
        {contestation.counted ? null : <p className="text-xs text-fg-muted">{t("grading.contest.notCounted")}</p>}
        {contestation.state === "open" && !resolver ? (
          <p className="text-xs text-fg-muted">{t("grading.contest.ownerAnswers")}</p>
        ) : null}
      </ContestationRecord>
    </section>
  );
}

/**
 * Under the answer of an OPEN contestation: an AI assistant's proposal when
 * there is one (ADR-139 §14), and for the course's owner the shared answer,
 * its new points the adjustment's own fields (F-GRADE-05), offered by its
 * switch — which Edit fills from the proposal.
 */
export function ContestationAnswer({
  evaluationId,
  contestation,
  entry,
  criteria,
  maxPoints,
  minPoints,
  resolver,
}: {
  evaluationId: string;
  contestation: StaffContestation;
  entry: GradingEntry;
  criteria: NonNullable<GradingQueueItem["criteria"]>;
  maxPoints: number;
  minPoints: number;
  /** The reader answers (the course's owner); anyone else reads the proposal and may discard it. */
  resolver: boolean;
}) {
  const invalidate = useGradingInvalidate(evaluationId);
  const draft = usePointsDraft({ entry, criteria, maxPoints, minPoints });
  return (
    <ContestationResponse
      contestation={contestation}
      isOwner={resolver}
      path={examContestationPath(contestation)}
      onChanged={invalidate}
      outOf={formatPoints(maxPoints)}
      points={{
        invalid: draft.invalid,
        body: draft.body,
        fields: <PointsFields draft={draft} showErrors={draft.invalid} />,
        // An essay graded by criteria takes no proposed points (`422 proposal_points_unsupported`).
        ...(draft.graded ? {} : { fill: (points: number) => draft.setPoints(formatPoints(points)) }),
      }}
    />
  );
}
