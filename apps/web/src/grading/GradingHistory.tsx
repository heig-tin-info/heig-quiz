import { PencilLine, RefreshCcw } from "lucide-react";

import type { GradingHistoryEntry } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { useT } from "../i18n";
import { Badge, RelativeTime } from "../ui";
import { gradingStateLabel, sourceLabel, stateTone } from "./labels";

/**
 * The gradings an answer went through, newest first (deviation W6-19): who
 * graded it, for how many points, and — when a pass re-graded it — the note
 * that pass carried (F-GRADE-06). Inline in the answer panel, which has the
 * room a popover beside a row never had.
 */
export function GradingHistory({ history }: { history: GradingHistoryEntry[] }) {
  const t = useT();
  if (history.length === 0) {
    return <p className="text-xs text-fg-muted">{t("grading.history.empty")}</p>;
  }
  return (
    <ul className="space-y-2">
      {history.map((h) => (
        <li key={h.id} className="border-t border-line pt-2 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold tabular-nums">
              {t("grading.score", {
                points: formatPoints(h.points),
                max: formatPoints(h.maxPoints),
              })}
            </span>
            <Badge tone={stateTone(h.state)}>{gradingStateLabel(t, h.state)}</Badge>
            {h.source === "manual" ? (
              <Badge tone="accent" icon={PencilLine}>
                {t("grading.history.edited")}
              </Badge>
            ) : null}
            <span className="text-xs text-fg-faint">
              {sourceLabel(t, h.source)} · <RelativeTime iso={h.gradedAt} />
            </span>
          </div>
          {h.regradeNote ? (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-fg-muted">
              <RefreshCcw className="mt-0.5 size-3 shrink-0" />
              {t("grading.history.regrade", { note: h.regradeNote })}
            </p>
          ) : null}
          {h.comment ? <p className="mt-1 text-xs text-fg-muted">{h.comment}</p> : null}
        </li>
      ))}
    </ul>
  );
}
