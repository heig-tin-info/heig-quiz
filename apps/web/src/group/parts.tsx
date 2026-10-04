import type { GroupSetUse } from "@quiz/contracts";

import { AppLink } from "../AppLink";
import { useT } from "../i18n";
import type { Navigate } from "../router";
import { Badge } from "../ui";

/** A link in running text: the parent's ink until hovered, then `fg` and an underline. */
export const textLink = "underline-offset-2 transition-colors hover:text-fg hover:underline";

/**
 * The projects that name a set (ADR-070 §4), each a link to its page: an
 * archived one says so, and one whose groups stopped following the set
 * (its deadline applied, or archived) says that instead.
 */
export function SetUses({ uses, navigate }: { uses: Pick<GroupSetUse, "id" | "name" | "archived" | "follows">[]; navigate: Navigate }) {
  const t = useT();
  if (uses.length === 0) return <span className="text-fg-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {uses.map((use) => (
        <span key={use.id} className="inline-flex items-center gap-1.5">
          <AppLink route={{ view: "project", id: use.id }} navigate={navigate} className={textLink}>
            {use.name}
          </AppLink>
          {use.archived ? (
            <Badge tone="zinc">{t("classrooms.archived")}</Badge>
          ) : use.follows ? null : (
            <Badge tone="zinc">{t("groups.use.stopped")}</Badge>
          )}
        </span>
      ))}
    </span>
  );
}
