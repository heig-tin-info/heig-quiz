import { CircleAlert, CircleX, Info, ScanSearch } from "lucide-react";

import type { ReviewPill } from "@quiz/contracts";
import type { ReviewSeverity } from "@quiz/domain";

import { useT, type Dict } from "../i18n";
import { Badge, type IconType, type Tone } from "../ui";

/** The one icon and colour of each severity (ADR-060 §2). */
export const SEVERITY: Record<ReviewSeverity, { icon: IconType; className: string; tone: Tone; label: keyof Dict }> = {
  error: { icon: CircleX, className: "text-danger", tone: "red", label: "review.severity.error" },
  warn: { icon: CircleAlert, className: "text-warning", tone: "amber", label: "review.severity.warn" },
  notice: { icon: Info, className: "text-fg-muted", tone: "zinc", label: "review.severity.notice" },
};

/**
 * The pill of the LLM review of a question's latest version (ADR-060 §3):
 * "LLM reviewed" when clean or ignored, the count of remarks in the colour
 * of the worst otherwise; nothing when it was not reviewed, or the call
 * failed.
 */
export function ReviewBadge({ review }: { review: ReviewPill | null }) {
  const t = useT();
  if (!review || review.state === "failed") return null;
  if (review.state !== "findings" || review.worst === null) {
    return (
      <Badge tone="zinc" icon={ScanSearch}>
        {t("review.pill.reviewed")}
      </Badge>
    );
  }
  return (
    <Badge tone={SEVERITY[review.worst].tone} icon={SEVERITY[review.worst].icon}>
      {review.count === 1 ? t("review.pill.findings.one") : t("review.pill.findings", { n: review.count })}
    </Badge>
  );
}
