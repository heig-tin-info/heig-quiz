import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ClipboardCheck } from "lucide-react";

import type { ResultRow, ResultsItem, StaffCopy } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api } from "../api";
import { CopyItem } from "../CopyItem";
import { Grade } from "../Grade";
import { useT } from "../i18n";
import type { Route } from "../router";
import { IconButton, QueryError, Sheet, Skeleton } from "../ui";
import { resultsCopyKey } from "../queryKeys";
import { PendingLine } from "../student/cards";

/**
 * One student's copy, opened from their name in the grade table: every
 * question with the answer, the points, the key, the explanation and the
 * comment — whatever the feedback policy and before any release, so the
 * teacher can check a "but I had it right" on the spot. A reading sheet over
 * the table, walked student by student (↑ / ↓ in the table's order); a
 * question that deserves another look opens in the grading panel.
 */
export function StudentCopy({
  evaluationId,
  row,
  items,
  onClose,
  onMove,
  navigate,
}: {
  evaluationId: string;
  /** The table's row: its name and state, and the attempt to read. */
  row: ResultRow & { attemptId: string };
  /** The evaluation's items, for the internal name the copy does not carry. */
  items: ResultsItem[];
  onClose: () => void;
  /** One student up or down the table; absent when there is none that way. */
  onMove: { prev?: (() => void) | undefined; next?: (() => void) | undefined };
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const copy = useQuery<StaffCopy>({
    queryKey: resultsCopyKey(evaluationId, row.attemptId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/results/attempts/${row.attemptId}`),
  });
  const names = new Map(items.map((i) => [i.id, i.internalName]));
  const data = copy.data;

  return (
    <Sheet
      width="lg"
      title={row.displayName}
      subtitle={
        data ? (
          <>
            {t("feedback.grade")} <Grade value={data.grade} /> ·{" "}
            <span className="tabular-nums">
              {formatPoints(data.points)} / {formatPoints(data.totalPoints)}
            </span>
          </>
        ) : (
          row.email
        )
      }
      onClose={onClose}
      actions={
        <>
          <IconButton label={t("results.copy.prev")} onClick={onMove.prev} disabled={!onMove.prev}>
            <ArrowUp />
          </IconButton>
          <IconButton label={t("results.copy.next")} onClick={onMove.next} disabled={!onMove.next}>
            <ArrowDown />
          </IconButton>
        </>
      }
    >
      {copy.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : copy.isError || !data ? (
        <QueryError title={t("results.copy.loadFailed")} query={copy} />
      ) : (
        <div className="space-y-5">
          <PendingLine count={data.pendingCount} />
          {data.items.map((item) => (
            <CopyItem
              key={item.itemId}
              item={item}
              audience="teacher"
              subtitle={names.get(item.itemId)}
              actions={
                <IconButton
                  label={t("results.copy.grade")}
                  onClick={() => navigate({ view: "grading", evaluationId, item: item.itemId })}
                >
                  <ClipboardCheck />
                </IconButton>
              }
            />
          ))}
        </div>
      )}
    </Sheet>
  );
}
