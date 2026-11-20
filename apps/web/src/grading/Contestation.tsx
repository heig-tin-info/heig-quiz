import { MessageSquare, MessageSquareWarning } from "lucide-react";

import type { GradingEntry, GradingQueueItem, StaffContestation } from "@quiz/contracts";

import { CONTESTATION_STATE, ContestationRecord, ContestationReply } from "../contestation/Contestation";
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
 * §13), the verdict its accessible name.
 */
export function ContestationMark({ contestation, compact = false }: { contestation: Pick<StaffContestation, "state"> | null; compact?: boolean }) {
  const t = useT();
  if (!contestation) return null;
  const open = contestation.state === "open";
  if (compact) {
    const Icon = open ? MessageSquareWarning : MessageSquare;
    return (
      <Tip label={t(CONTESTATION_STATE[contestation.state].label)} className="inline-flex align-middle">
        <Icon role="img" aria-label={t(CONTESTATION_STATE[contestation.state].label)} className={cx("size-3.5", open ? "text-warning" : "text-fg-faint")} />
      </Tip>
    );
  }
  return (
    <Tip label={t(CONTESTATION_STATE[contestation.state].label)}>
      <Badge tone={open ? "amber" : "zinc"} icon={open ? MessageSquareWarning : MessageSquare}>
        {t(CONTESTATION_STATE[contestation.state].badge)}
      </Badge>
    </Tip>
  );
}

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
      <ContestationRecord contestation={contestation} audience="teacher" folded={!named}>
        {contestation.counted ? null : <p className="text-xs text-fg-muted">{t("grading.contest.notCounted")}</p>}
        {contestation.state === "open" && !resolver ? (
          <p className="text-xs text-fg-muted">{t("grading.contest.ownerAnswers")}</p>
        ) : null}
      </ContestationRecord>
    </section>
  );
}

/**
 * Under the answer, for the course's owner: the shared answer, its new
 * points the adjustment's own fields (F-GRADE-05), offered by its switch.
 */
export function ContestationAnswer({
  evaluationId,
  contestation,
  entry,
  criteria,
  maxPoints,
  minPoints,
}: {
  evaluationId: string;
  contestation: StaffContestation;
  entry: GradingEntry;
  criteria: NonNullable<GradingQueueItem["criteria"]>;
  maxPoints: number;
  minPoints: number;
}) {
  const invalidate = useGradingInvalidate(evaluationId);
  const draft = usePointsDraft({ entry, criteria, maxPoints, minPoints });
  return (
    <ContestationReply
      resolvePath={`/app/api/contestations/${contestation.id}/resolve`}
      onChanged={invalidate}
      points={{ invalid: draft.invalid, body: draft.body, fields: <PointsFields draft={draft} showErrors={draft.invalid} /> }}
    />
  );
}
