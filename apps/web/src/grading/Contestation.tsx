import { MessageSquare, MessageSquareWarning } from "lucide-react";
import { useState } from "react";

import type { GradingEntry, GradingQueueItem, StaffContestation } from "@quiz/contracts";

import { CONTESTATION_STATE, ContestationRecord, ContestationReply } from "../Contestation";
import { useT } from "../i18n";
import { Badge, Switch, Tip } from "../ui";
import { PointsFields, usePointsDraft } from "./PointsDraft";
import { useGradingInvalidate } from "./useGradingInvalidate";

/**
 * A student's contestation of one cell, on the grading screen (ADR-139):
 * the mark of its row, the record above the answer, and the owner's one
 * answer below it.
 */

/** A row's mark: an open contestation in amber, an answered one quiet; the verdict in the tooltip. */
export function ContestationMark({ contestation }: { contestation: StaffContestation | null }) {
  const t = useT();
  if (!contestation) return null;
  const open = contestation.state === "open";
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
 * points the adjustment's own fields (F-GRADE-05), offered by a switch.
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
  const t = useT();
  const invalidate = useGradingInvalidate(evaluationId);
  const [given, setGiven] = useState(false);
  const draft = usePointsDraft({ entry, criteria, maxPoints, minPoints });
  return (
    <ContestationReply
      resolvePath={`/app/api/contestations/${contestation.id}/resolve`}
      onChanged={invalidate}
      points={{
        given,
        invalid: draft.invalid,
        body: draft.body,
        fields: (
          <>
            <label className="flex items-center gap-2 text-[13px] font-medium">
              <Switch checked={given} onChange={setGiven} label={t("grading.contest.givePoints")} />
              <span aria-hidden>{t("grading.contest.givePoints")}</span>
            </label>
            {given ? <PointsFields draft={draft} showErrors={draft.invalid} /> : null}
          </>
        ),
      }}
    />
  );
}
