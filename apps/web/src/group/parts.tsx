import type { GroupSetUse } from "@quiz/contracts";

import { useT } from "../i18n";
import { routeToPath, type Navigate, type Route } from "../router";
import { Badge, isPlainClick } from "../ui";

/** A page of the app as a real link: a plain click routes in place, a middle click opens a tab. */
export function AppLink({
  route,
  navigate,
  children,
  className = "",
}: {
  route: Route;
  navigate: Navigate;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={routeToPath(route)}
      onClick={(e) => {
        // A link in a clickable row opens its own page, not the row's.
        e.stopPropagation();
        if (!isPlainClick(e)) return;
        e.preventDefault();
        navigate(route);
      }}
      className={`underline-offset-2 transition-colors hover:text-fg hover:underline ${className}`}
    >
      {children}
    </a>
  );
}

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
          <AppLink route={{ view: "project", id: use.id }} navigate={navigate}>
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
