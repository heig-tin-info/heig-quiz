/*
 * A student's grades in two groups (#803, F-ORG-14, F-GBOOK-05), split by
 * the server's effective `counts` flag (the gradebook column's, or its kind's
 * default) and named by it, never by a kind: "Count toward your average" —
 * an exam, a project, an exercise the teacher included —, then "Indicative",
 * what does not count (an exercise by default, an exam the teacher left
 * out). For the global Grades page and the classroom's Grades tab alike; the
 * order within a group is the page's; an empty group is not drawn.
 *
 * Each group is a sub-heading INSIDE its section (DESIGN.md › The student's
 * "Coming up", by day): an `h3` at 14 px semibold, 8 px to what follows, 20
 * between the groups. The indicative group says once, under its heading,
 * what its grades are worth; its rows wear no badge for it and their grades
 * no band colour (`Grade`'s `neutral`), so the page stays calm.
 */
import { useId, type ReactNode } from "react";

import { useT } from "../i18n";

export function CountsGroups<T extends { counts: boolean }>({
  rows,
  children,
}: {
  rows: readonly T[];
  /** The rows of one group, drawn by the page (a table, a list); `counts`, which group it is. */
  children: (rows: T[], counts: boolean) => ReactNode;
}) {
  const groups = [true, false]
    .map((counts) => ({ counts, rows: rows.filter((row) => row.counts === counts) }))
    .filter((group) => group.rows.length > 0);
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <CountsGroup key={String(group.counts)} counts={group.counts}>
          {children(group.rows, group.counts)}
        </CountsGroup>
      ))}
    </div>
  );
}

function CountsGroup({ counts, children }: { counts: boolean; children: ReactNode }) {
  const t = useT();
  const id = useId();
  return (
    <section className="space-y-2" aria-labelledby={id}>
      <div>
        <h3 id={id} className="text-sm font-semibold text-fg">
          {t(counts ? "sgrades.group.counting" : "sgrades.group.indicative")}
        </h3>
        {counts ? null : <p className="mt-0.5 text-[13px] text-fg-muted">{t("sgrades.group.indicativeHint")}</p>}
      </div>
      {children}
    </section>
  );
}
