import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";

import { type AdminConcept, ConceptRelationCandidates } from "@quiz/contracts";
import { admissible, edgesOf, type RelationEdges } from "@quiz/domain";

import { api } from "../api";
import { useI18n, useT } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Badge, Button, Card, Checkbox, EmptyState, FormError, QueryError, SelectionBar, Skeleton } from "../ui";
import { relationError } from "./ConceptRelations";
import { conceptName } from "./names";
import { acceptPlan, rowsOf, rowState, runAccept, type Outcome, type RelationRow } from "./relationReview";

type Row = RelationRow<AdminConcept>;

const NO_CANDIDATES: ConceptRelationCandidates = { contained: [], together: [] };

/**
 * The Relations view of the curation queue (#897 step A1, ADR-114): the
 * relations found without a model, a broader concept whose label another
 * contains and two concepts used together on many questions. Nothing is
 * checked; the one primary action, "Accept the n selected", writes the
 * ticked rows through the relation route one at a time, the broader edges
 * first, and shows each row's outcome. "Dismiss" hides a row until reload;
 * nothing is stored. The candidates are under the queue's key, so every
 * write that refreshes the vocabulary refreshes them too.
 */
export function ConceptRelationReview({
  concepts,
  narrowed,
  onEdit,
}: {
  concepts: readonly AdminConcept[];
  /** The queue's search, as for the duplicates: a row stays when one of its concepts matches. */
  narrowed: (row: { a: AdminConcept; b: AdminConcept }) => boolean;
  onEdit: (id: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  // The rows of the last acceptance, kept on screen with their outcome after the refetch drops them.
  const [ran, setRan] = useState<{ rows: Row[]; outcomes: Map<string, Outcome> } | null>(null);

  const candidates = useQuery({
    queryKey: [...adminConceptsKey, "relation-candidates"],
    queryFn: async () => ConceptRelationCandidates.parse(await api("/app/api/admin/concepts/relations/candidates")),
  });
  const edges = useMemo(() => edgesOf(concepts), [concepts]);
  const byId = useMemo(() => new Map(concepts.map((c) => [c.id, c])), [concepts]);
  const rows = useMemo(() => {
    const fresh = rowsOf(candidates.data ?? NO_CANDIDATES, concepts);
    const kept = new Set(fresh.map((r) => r.key));
    const held = (ran?.rows ?? []).flatMap((r) => {
      const [a, b] = [byId.get(r.concept), byId.get(r.target)];
      return a && b && !kept.has(r.key) ? [{ ...r, a, b }] : [];
    });
    return [...held, ...fresh].filter((r) => !dismissed.has(r.key) && narrowed(r));
  }, [candidates.data, concepts, byId, ran, dismissed, narrowed]);
  const ticked = rows.filter((r) => selected.has(r.key) && rowState(r, edges).state === "open");

  const accept = useMutation({
    mutationFn: async (chosen: Row[]) => {
      const plan = acceptPlan(chosen);
      const outcomes = await runAccept(plan, {
        relate: (row) =>
          api(`/app/api/admin/concepts/${row.concept}/relations`, {
            method: "POST",
            body: JSON.stringify({ kind: row.kind, target: row.target }),
          }),
      });
      return { rows: plan.edges, outcomes };
    },
    onSuccess: (result) => {
      setRan(result);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: adminConceptsKey });
      void qc.invalidateQueries({ queryKey: conceptsKey });
    },
  });

  if (candidates.isLoading) return <Skeleton className="h-64 w-full" />;
  if (candidates.isError) return <QueryError title={t("admin.concepts.filter.relations")} query={candidates} />;

  const toggle = (key: string) =>
    setSelected((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const failed = ran ? [...ran.outcomes.values()].filter((o) => "error" in o).length : 0;
  const sections = [
    { kind: "broader", title: t("admin.concepts.rel.contained"), desc: t("admin.concepts.rel.contained.desc") },
    { kind: "related", title: t("admin.concepts.rel.together"), desc: t("admin.concepts.rel.together.desc") },
  ] as const;

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-fg-muted">{t("admin.concepts.rel.hint")}</p>
      {ran ? (
        <p role="status" className="text-sm">
          {t("admin.concepts.rel.summary", { ok: ran.outcomes.size - failed, failed })}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={Check} title={t("admin.concepts.rel.empty.title")}>
            {t("admin.concepts.rel.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        sections.map((section) => {
          const list = rows.filter((r) => r.kind === section.kind);
          return list.length === 0 ? null : (
            <section key={section.kind} aria-label={section.title} className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold">{section.title}</h3>
                <p className="text-xs text-fg-muted">{section.desc}</p>
              </div>
              <Card>
                <ul className="divide-y divide-line">
                  {list.map((row) => (
                    <ReviewRow
                      key={row.key}
                      row={row}
                      edges={edges}
                      byId={byId}
                      ticked={ticked}
                      checked={selected.has(row.key)}
                      outcome={ran?.outcomes.get(row.key)}
                      onToggle={() => toggle(row.key)}
                      onDismiss={() => setDismissed((was) => new Set(was).add(row.key))}
                      onEdit={onEdit}
                    />
                  ))}
                </ul>
              </Card>
            </section>
          );
        })
      )}
      {ticked.length > 0 ? (
        <SelectionBar
          label={t("admin.concepts.rel.selected", { n: ticked.length })}
          onClear={() => setSelected(new Set())}
          end={
            <Button size="sm" loading={accept.isPending} onClick={() => accept.mutate(ticked)}>
              <Check />{" "}
              {ticked.length === 1 ? t("admin.concepts.rel.acceptOne") : t("admin.concepts.rel.accept", { n: ticked.length })}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

function ReviewRow({
  row,
  edges,
  byId,
  ticked,
  checked,
  outcome,
  onToggle,
  onDismiss,
  onEdit,
}: {
  row: Row;
  edges: RelationEdges;
  byId: ReadonlyMap<string, AdminConcept>;
  ticked: readonly Row[];
  checked: boolean;
  outcome: Outcome | undefined;
  onToggle: () => void;
  onDismiss: () => void;
  onEdit: (id: string) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [a, b] = [conceptName(row.a, locale), conceptName(row.b, locale)];
  const named =
    row.kind === "broader"
      ? t("admin.concepts.rel.broaderNamed", { name: a, target: b })
      : t("admin.concepts.rel.relatedNamed", { name: a, target: b });
  const state = rowState(row, edges);
  // A row the ticked ones would make unacceptable (a cycle through two of them, a pair both ways).
  const conflict = state.state === "open" && !checked && admissible(edges, [...ticked, row]).length <= ticked.length;
  const reason =
    state.state === "blocked"
      ? state.refusal.kind === "cycle"
        ? t("admin.concepts.relations.error.cycle", {
            path: state.refusal.path.map((id) => (byId.has(id) ? conceptName(byId.get(id)!, locale) : "?")).join(" › "),
          })
        : t("admin.concepts.relations.error.redundant")
      : conflict
        ? t("admin.concepts.rel.conflict")
        : null;
  const reasonId = `rel-${row.key}-why`;
  const name = (id: string, label: string) => (
    <Button size="sm" variant="ghost" aria-label={t("admin.concepts.editNamed", { name: label })} onClick={() => onEdit(id)}>
      <span className="font-semibold">{label}</span>
    </Button>
  );

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 p-4">
      <Checkbox
        className="mt-1.5"
        label={<span className="sr-only">{named}</span>}
        checked={checked && state.state === "open"}
        disabled={state.state !== "open" || conflict}
        aria-describedby={reason ? reasonId : undefined}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <div className="-ml-3 flex flex-wrap items-center gap-y-1">
          {name(row.a.id, a)}
          <span className="text-xs text-fg-muted">
            {row.kind === "broader" ? t("admin.concepts.rel.under") : t("admin.concepts.rel.and")}
          </span>
          {name(row.b.id, b)}
          {state.state === "added" ? (
            <Badge tone="green" icon={Check}>
              {t("admin.concepts.rel.added")}
            </Badge>
          ) : null}
        </div>
        {row.questions !== null ? (
          <p className="text-xs tabular-nums text-fg-muted">{t("admin.concepts.rel.questions", { n: row.questions })}</p>
        ) : null}
        {reason ? (
          <p id={reasonId} className="text-xs text-fg-muted">
            {reason}
          </p>
        ) : null}
        {outcome && "error" in outcome ? <FormError error={outcome.error} describe={(error) => relationError(t, error)} /> : null}
      </div>
      {state.state === "added" ? null : (
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto shrink-0"
          aria-label={t("admin.concepts.rel.dismissNamed", { name: named })}
          onClick={onDismiss}
        >
          {t("admin.concepts.rel.dismiss")}
        </Button>
      )}
    </li>
  );
}
