import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";

import type {
  DashboardRow,
  EvaluationIncidents,
  IntegrityIncident,
  IntegrityIncidentKind,
} from "@quiz/contracts";

import { api } from "../api";
import { formatSpan, useT, type Dict, type TFunction } from "../i18n";
import { evaluationIncidentsKey } from "../queryKeys";
import { Badge, Button, cx, EmptyState, Modal, QueryError, SectionHeading, Skeleton, T, TableHead } from "../ui";

/**
 * The integrity journal as a teacher reads it (ADR-088 §7): a hint for the
 * teacher's attention, never proof. Three surfaces share this file — the
 * row's badge, the inspector's Journal section and the evaluation's list —
 * so an incident reads the same wherever it is met.
 */

/** The word of each kind: a kind added to the contract without one is a compile error. */
const KIND_LABEL: Record<IntegrityIncidentKind, keyof Dict> = {
  left: "live.integrity.kind.left",
  paste: "live.integrity.kind.paste",
};

/** "09:41:07", in the reader's time zone: the seconds matter for an absence of a few. */
function timeOf(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** What the incident amounts to: how long the page was left, or what was pasted. */
function detailOf(incident: IntegrityIncident, t: TFunction): string {
  if (incident.kind === "left") {
    return incident.durationMs === null ? t("live.integrity.ongoing") : formatSpan(incident.durationMs / 1000, t);
  }
  const length =
    incident.length === null
      ? "—"
      : t(incident.length === 1 ? "live.integrity.chars.one" : "live.integrity.chars", { n: incident.length });
  return incident.afterFocusLoss ? `${length} · ${t("live.integrity.afterFocusLoss")}` : length;
}

/**
 * The row's badge: neutral, an icon and a count, shown only when there is
 * something to count. It is the door to the student's paper, opened on its
 * Journal section (DESIGN.md, Badge: a badge that is also a door).
 */
export function IncidentBadge({ count, name, onOpen }: { count: number; name: string; onOpen: () => void }) {
  const t = useT();
  if (count <= 0) return null;
  const label = t(count === 1 ? "live.integrity.count.one" : "live.integrity.count", { n: count });
  return (
    <button
      type="button"
      title={label}
      aria-label={t("live.integrity.open", { count: label, name })}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="shrink-0 rounded-full transition-opacity hover:opacity-80"
    >
      <Badge tone="zinc" icon={ScrollText}>
        <span className="tabular-nums">{count}</span>
      </Badge>
    </button>
  );
}

/** One entry of a list; `name` only in the evaluation's list. */
interface Entry {
  key: string;
  incident: IntegrityIncident;
  name?: string;
  onOpen?: (() => void) | undefined;
}

/**
 * The incidents as a table — time, (student,) kind with its duration or
 * length — or the empty state of an evaluation that recorded none.
 */
function IncidentTable({ entries, named }: { entries: Entry[]; named: boolean }) {
  const t = useT();
  if (entries.length === 0) {
    return <EmptyState icon={ScrollText} title={t("live.integrity.empty")} className="py-6" />;
  }
  return (
    <div className={T.container}>
      <table className={T.table}>
        <TableHead
          columns={[
            { key: "time", label: t("live.integrity.col.time") },
            ...(named ? [{ key: "student", label: t("live.integrity.col.student") }] : []),
            { key: "kind", label: t("live.integrity.col.kind") },
          ]}
        />
        <tbody>
          {entries.map(({ key, incident, name, onOpen }) => (
            <tr key={key} className={T.row}>
              <td className={cx(T.td, "whitespace-nowrap tabular-nums text-fg-muted")}>{timeOf(incident.at)}</td>
              {named ? (
                <td className={cx(T.td, "font-semibold")}>
                  {onOpen ? (
                    <button type="button" onClick={onOpen} className="text-left underline-offset-2 hover:underline">
                      {name}
                    </button>
                  ) : (
                    name
                  )}
                </td>
              ) : null}
              {/* The kind, and under it what it amounts to: two short lines
                  rather than a fourth column that a phone cannot hold. */}
              <td className={T.td}>
                <span className="block">{t(KIND_LABEL[incident.kind])}</span>
                <span className="block text-xs tabular-nums text-fg-muted">{detailOf(incident, t)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The muted line that says what the journal is worth, wherever it is read. */
function Caveat() {
  const t = useT();
  return <p className="text-xs text-fg-faint">{t("live.integrity.caveat")}</p>;
}

/** The inspector's Journal section: this one attempt's incidents. */
export function JournalSection({ incidents }: { incidents: readonly IntegrityIncident[] }) {
  const t = useT();
  return (
    <section className="space-y-2">
      <SectionHeading icon={ScrollText} title={t("live.integrity.title")} count={incidents.length} />
      <Caveat />
      <IncidentTable
        named={false}
        entries={incidents.map((incident, i) => ({ key: `${incident.at}:${i}`, incident }))}
      />
    </section>
  );
}

/**
 * The evaluation's list, over the grid (secondary: opened from the status
 * line, never on screen by itself — the dashboard is projected). Each entry
 * is named as the grid names its row, so "names hidden" holds here too —
 * an entry with no row (a student since moved off the roster) by its
 * pseudonym, never its name, while they are hidden; a name opens that
 * student's paper.
 */
export function IncidentsModal({
  evaluationId,
  rows,
  nameOf,
  namesShown,
  onOpenRow,
  onClose,
}: {
  evaluationId: string;
  rows: readonly DashboardRow[];
  nameOf: (row: DashboardRow) => string;
  /** The grid's names switch (F-DASH-02). */
  namesShown: boolean;
  onOpenRow: (row: DashboardRow) => void;
  onClose: () => void;
}) {
  const t = useT();
  const query = useQuery<EvaluationIncidents>({
    queryKey: evaluationIncidentsKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/incidents`),
  });
  const entries = (query.data?.incidents ?? []).map((entry, i) => {
    const row = entry.userId === null ? undefined : rows.find((r) => r.userId === entry.userId);
    return {
      key: `${entry.attemptId}:${entry.incident.at}:${i}`,
      incident: entry.incident,
      name: row ? nameOf(row) : namesShown ? entry.displayName : entry.pseudonym,
      onOpen: row && row.attemptId === entry.attemptId ? () => onOpenRow(row) : undefined,
    };
  });
  return (
    <Modal
      size="lg"
      scroll
      title={t("live.integrity.listTitle")}
      subtitle={t("live.integrity.caveat")}
      onClose={onClose}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      {query.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : query.isError || !query.data ? (
        <QueryError title={t("live.integrity.failed")} query={query} />
      ) : (
        <IncidentTable named entries={entries} />
      )}
    </Modal>
  );
}
