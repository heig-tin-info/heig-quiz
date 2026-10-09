import { Users } from "lucide-react";

import type { GroupSetSummary } from "@quiz/contracts";

import { useT } from "../i18n";
import type { Navigate } from "../router";
import { Badge, Button, Card, EmptyState, isoDateTime, pressable, QueryError, Skeleton, T, TableHead } from "../ui";
import { useClassroomGroupSets } from "./api";
import { SetUses } from "./parts";

/**
 * The classroom's Groups tab (ADR-070 §2, M3-16a): its group sets, the
 * oldest first, as the API lists them. A row is a set — its name (and
 * "open" while its students form their groups, F-PROJ-22), its groups, the students placed and not placed, the projects that name it,
 * its date — and opens its page. "New group set", the tab's one primary
 * action, is in the classroom's header (`ClassroomView`), and in the empty
 * state.
 */
export function GroupSetList({
  classroomId,
  navigate,
  onNew,
  creating,
  readOnly,
}: {
  classroomId: string;
  navigate: Navigate;
  onNew: () => void;
  creating: boolean;
  /** An archived classroom: its sets are read, never created. */
  readOnly: boolean;
}) {
  const t = useT();
  const list = useClassroomGroupSets(classroomId);

  if (list.isLoading) {
    return (
      <Card className="space-y-3 p-4">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-2/5" />
      </Card>
    );
  }
  if (list.isError) {
    return (
      <QueryError title={t("groups.loadFailed")} query={list} />
    );
  }
  const sets = list.data ?? [];
  if (sets.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title={t("groups.empty.title")}
          action={
            readOnly ? undefined : (
              <Button loading={creating} onClick={onNew}>
                {t("groups.new")}
              </Button>
            )
          }
        >
          {t("groups.empty.body")}
        </EmptyState>
      </Card>
    );
  }

  const open = (set: GroupSetSummary) => navigate({ view: "groupSet", classroomId, id: set.id });
  return (
    <Card className={`${T.container} overflow-x-auto`}>
      <table className={T.table}>
        <TableHead
          columns={[
            { key: "name", label: t("groups.col.name") },
            { key: "groups", label: t("groups.col.groups"), right: true },
            { key: "placed", label: t("groups.col.placed"), right: true },
            { key: "unplaced", label: t("groups.col.unplaced"), right: true },
            { key: "usedBy", label: t("groups.col.usedBy"), className: T.colMid },
            { key: "created", label: t("groups.col.created"), className: T.colHigh },
          ]}
        />
        <tbody>
          {sets.map((set) => (
            <tr
              key={set.id}
              className={`${T.row} ${T.rowHover} cursor-pointer`}
              {...pressable(() => open(set), "row")}
            >
              <td className={`${T.td} font-semibold`}>
                <span className="inline-flex flex-wrap items-center gap-2">
                  {set.name}
                  {set.open ? <Badge tone="green">{t("groups.open.badge")}</Badge> : null}
                </span>
              </td>
              <td className={`${T.td} text-right tabular-nums`}>{set.groups}</td>
              <td className={`${T.td} text-right tabular-nums`}>{set.placed}</td>
              <td className={`${T.td} text-right tabular-nums ${set.unplaced > 0 ? "font-medium text-warning" : "text-fg-muted"}`}>
                {set.unplaced}
              </td>
              <td className={`${T.td} ${T.colMid} text-fg-muted`}>
                <SetUses uses={set.usedBy} navigate={navigate} />
              </td>
              <td className={`${T.td} ${T.colHigh} tabular-nums text-fg-muted`}>{isoDateTime(set.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
