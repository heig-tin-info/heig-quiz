/**
 * The marks of a paper copy (ADR-125 §17): "paper" on the attempt a staff
 * member typed in, "replaced" on an attempt a paper copy replaced. Drawn on
 * the dashboard row, the results row, the staff copy and the inspect view —
 * never on the grading table, which is anonymised (F-GRADE-03): a badge there
 * would name the one student whose computer died.
 */
import { PenLine, Replace } from "lucide-react";

import type { AttemptOrigin } from "@quiz/contracts";

import { useT } from "../i18n";
import { Badge, Tip } from "../ui";

export function PaperBadge({ origin }: { origin: AttemptOrigin }) {
  const t = useT();
  if (origin !== "paper") return null;
  return (
    <Tip label={t("attempt.paper.tip")}>
      <Badge tone="zinc" icon={PenLine}>
        {t("attempt.paper")}
      </Badge>
    </Tip>
  );
}

/** An attempt a paper copy replaced: kept for the staff, counted nowhere (ADR-125 §12). */
export function SupersededBadge({ supersededBy }: { supersededBy: string | null }) {
  const t = useT();
  if (supersededBy === null) return null;
  return (
    <Tip label={t("attempt.superseded.tip")}>
      <Badge tone="amber" icon={Replace}>
        {t("attempt.superseded")}
      </Badge>
    </Tip>
  );
}
