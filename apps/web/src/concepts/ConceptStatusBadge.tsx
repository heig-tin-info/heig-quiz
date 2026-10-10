import type { AdminConcept } from "@quiz/contracts";

import { useT } from "../i18n";
import { Badge } from "../ui";

/** A concept's status, as the queue's rows and the duplicates' rows show it. */
export function ConceptStatusBadge({ status }: { status: AdminConcept["status"] }) {
  const t = useT();
  return (
    <Badge tone={status === "validated" ? "green" : "amber"}>
      {status === "validated" ? t("admin.concepts.status.validated") : t("admin.concepts.status.proposed")}
    </Badge>
  );
}
