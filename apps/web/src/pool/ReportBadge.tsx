import { Flag } from "lucide-react";

import { useT } from "../i18n";
import { Badge } from "../ui";

/**
 * "Open report" on a question (issue #680): a reader told the writers it is
 * wrong, and nobody resolved it yet. Shown beside the nightly review's pill
 * (`ReviewBadge`), never merged with it: one is a colleague's word, the other
 * the model's. Nothing when none is open.
 */
export function ReportBadge({ count }: { count: number }) {
  const t = useT();
  if (count <= 0) return null;
  return (
    <Badge tone="amber" icon={Flag}>
      {count === 1 ? t("question.reports.open.one") : t("question.reports.open", { n: count })}
    </Badge>
  );
}
