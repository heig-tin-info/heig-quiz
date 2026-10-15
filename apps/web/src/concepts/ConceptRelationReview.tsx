import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  type AdminConcept,
  ConceptRelationCandidates,
  type ConceptRelationProposals,
} from "@quiz/contracts";
import { edgesOf, type RelationEdges } from "@quiz/domain";

import { api } from "../api";
import { useI18n, useT } from "../i18n";
import { useLlmAvailability } from "../llmAvailability";
import { adminConceptCandidatesKey, adminConceptsKey, conceptsKey } from "../queryKeys";
import { Badge, Button, Card, Checkbox, EmptyState, QueryError, SelectionBar, Skeleton } from "../ui";
import { AiAsk } from "./AiAsk";
import { RowRefusal, TopHeading } from "./ConceptRelations";
import { conceptName, refName } from "./names";
import {
  aiRowsOf,
  conflicting,
  createTop,
  isConcept,
  relateRow,
  rowsOf,
  rowState,
  runAccept,
  type Outcome,
  type RelationRow,
  type TopConcept,
} from "./relationReview";

/**
 * The Relations view of the curation queue (#897 step A, ADR-114): the
 * relations found without a model (a broader concept whose label another
 * contains, two concepts used together on many questions) and, below, the
 * model's proposals on demand (`ai`, kept by the queue): broader rows,
 * related pairs with a reason and missing top concepts. Nothing is checked;
 * the one primary action, "Accept the n selected", creates the ticked rows'
 * top concepts, then writes their edges through the relation route one at a
 * time, the broader ones first, and shows each row's outcome. A row that
 * conflicts with the ticked ones is disabled. "Dismiss" hides a row until
 * reload; nothing is stored.
 */
export function ConceptRelationReview({
  concepts,
  ai,
  narrowed,
  onEdit,
}: {
  concepts: readonly AdminConcept[];
  /** The model's pass, kept by the queue so that it survives a filter switch; `ask` runs it, again past what it asked. */
  ai: { data: ConceptRelationProposals | undefined; isPending: boolean; error: Error | null; ask: () => void };
  /** The queue's search, as for the duplicates: a row stays when one of its concepts matches. */
  narrowed: (row: { a: AdminConcept; b: AdminConcept }) => boolean;
  onEdit: (id: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const llm = useLlmAvailability();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  const candidates = useQuery({
    queryKey: adminConceptCandidatesKey,
    queryFn: async () => ConceptRelationCandidates.parse(await api("/app/api/admin/concepts/relations/candidates")),
  });
  const edges = useMemo(() => edgesOf(concepts), [concepts]);
  const byId = useMemo(() => new Map(concepts.map((c) => [c.id, c])), [concepts]);
  const prepass = useMemo(() => rowsOf(candidates.data?.candidates ?? [], concepts), [candidates.data, concepts]);
  const proposed = useMemo(() => aiRowsOf(ai.data, concepts, prepass), [ai.data, concepts, prepass]);
  const [rows, aiRows] = useMemo(() => {
    const shown = (r: RelationRow) => !dismissed.has(r.key) && narrowed({ a: r.a, b: isConcept(r.b) ? r.b : r.a });
    return [prepass.filter(shown), proposed.filter(shown)];
  }, [prepass, proposed, dismissed, narrowed]);
  const { ticked, conflicts } = useMemo(() => {
    const all = [...rows, ...aiRows];
    const open = all.filter((r) => selected.has(r.key) && rowState(r, edges).state === "open");
    return { ticked: open, conflicts: conflicting(all, open, edges) };
  }, [rows, aiRows, selected, edges]);

  const accept = useMutation({
    mutationFn: (chosen: RelationRow[]) =>
      runAccept(chosen, {
        create: createTop,
        relate: relateRow,
      }),
    onSuccess: () => {
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
  const outcomes = accept.data;
  const failed = outcomes ? [...outcomes.values()].filter((o) => "error" in o).length : 0;
  const render = (row: RelationRow) => (
    <ReviewRow
      key={row.key}
      row={row}
      edges={edges}
      byId={byId}
      checked={selected.has(row.key)}
      conflict={conflicts.has(row.key)}
      outcome={outcomes?.get(row.key)}
      onToggle={() => toggle(row.key)}
      onDismiss={() => setDismissed((was) => new Set(was).add(row.key))}
      onEdit={onEdit}
    />
  );
  const sections = [
    { kind: "broader", title: t("admin.concepts.rel.contained"), desc: t("admin.concepts.rel.contained.desc") },
    { kind: "related", title: t("admin.concepts.rel.together"), desc: t("admin.concepts.rel.together.desc") },
  ] as const;
  const aiSections = [
    { kind: "broader", title: t("admin.concepts.rel.ai.broader"), desc: t("admin.concepts.rel.ai.broader.desc") },
    { kind: "related", title: t("admin.concepts.rel.ai.related"), desc: t("admin.concepts.rel.ai.related.desc") },
  ] as const;
  const tops = new Map<string, { top: TopConcept; rows: RelationRow[] }>();
  for (const r of aiRows) if (r.top) tops.set(r.top.key, { top: r.top, rows: [...(tops.get(r.top.key)?.rows ?? []), r] });

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-fg-muted">{t("admin.concepts.rel.hint")}</p>
      {outcomes ? (
        <p role="status" className="text-sm">
          {t("admin.concepts.rel.summary", { ok: outcomes.size - failed, failed })}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={Check} title={t("admin.concepts.rel.empty.title")}>
            {t("admin.concepts.rel.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        sections.map((s) => (
          <Section key={s.kind} title={s.title} desc={s.desc}>
            {rows.filter((r) => r.kind === s.kind).map(render)}
          </Section>
        ))
      )}

      {llm.data?.available === true ? (
        <section aria-label={t("admin.concepts.rel.ai.title")} className="space-y-4 pt-2">
          <AiAsk
            label={t(ai.data && ai.data.remaining > 0 ? "admin.concepts.rel.ai.askAgain" : "admin.concepts.rel.ai.ask")}
            hint={
              <>
                {t("admin.concepts.rel.ai.hint")}
                {ai.data && ai.data.remaining > 0 ? ` ${t("admin.concepts.rel.ai.remaining", { n: ai.data.remaining })}` : ""}
                {ai.data?.truncated ? ` ${t("admin.concepts.rel.ai.truncated")}` : ""}
              </>
            }
            pending={ai.isPending}
            error={ai.error}
            failedTitle={t("admin.concepts.rel.ai.failed")}
            onAsk={ai.ask}
          />
          {ai.data && !ai.isPending && proposed.length === 0 ? (
            <p className="text-sm text-fg-muted">{t("admin.concepts.rel.ai.none")}</p>
          ) : null}
          {aiSections.map((s) => (
            <Section key={s.kind} title={s.title} desc={s.desc}>
              {aiRows.filter((r) => r.kind === s.kind && !r.top).map(render)}
            </Section>
          ))}
          {tops.size > 0 ? (
            <section aria-label={t("admin.concepts.rel.top.title")} className="space-y-2">
              <SectionTitle title={t("admin.concepts.rel.top.title")} desc={t("admin.concepts.rel.top.desc")} />
              {[...tops.values()].map(({ top, rows: group }) => (
                <Card key={top.key}>
                  <div className="space-y-1 border-b border-line p-4">
                    <TopHeading top={top} />
                    <p className="text-xs text-fg-muted">{top.reason}</p>
                  </div>
                  <ul className="divide-y divide-line">{group.map(render)}</ul>
                </Card>
              ))}
            </section>
          ) : null}
        </section>
      ) : null}

      {ticked.length > 0 ? (
        <SelectionBar
          // "{n} sélectionnées": a relation is feminine, as the pool's questions are.
          label={t("pool.bulk.selected", { n: ticked.length })}
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

function SectionTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-fg-muted">{desc}</p>
    </div>
  );
}

/** A titled list of rows; nothing when it has none. */
function Section({ title, desc, children }: { title: string; desc: string; children: ReactNode[] }) {
  return children.length === 0 ? null : (
    <section aria-label={title} className="space-y-2">
      <SectionTitle title={title} desc={desc} />
      <Card>
        <ul className="divide-y divide-line">{children}</ul>
      </Card>
    </section>
  );
}

function ReviewRow({
  row,
  edges,
  byId,
  checked,
  conflict,
  outcome,
  onToggle,
  onDismiss,
  onEdit,
}: {
  row: RelationRow;
  edges: RelationEdges;
  byId: ReadonlyMap<string, AdminConcept>;
  checked: boolean;
  /** It would be refused once the ticked rows are written. */
  conflict: boolean;
  outcome: Outcome | undefined;
  onToggle: () => void;
  onDismiss: () => void;
  onEdit: (id: string) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [a, b] = [conceptName(row.a, locale), isConcept(row.b) ? conceptName(row.b, locale) : refName(row.b)];
  const named =
    row.kind === "broader"
      ? t("admin.concepts.rel.broaderNamed", { name: a, target: b })
      : t("admin.concepts.rel.relatedNamed", { name: a, target: b });
  const state = rowState(row, edges);
  const refused = outcome && "error" in outcome ? outcome.error : null;
  // The server's refusal says it already; the rule's reason is for a row the vocabulary has moved past.
  const reason = !refused && (state.state === "blocked" || conflict);
  const open = state.state === "open" && !conflict;
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
        checked={checked && open}
        disabled={!open}
        aria-describedby={reason ? reasonId : undefined}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <div className="-ml-3 flex flex-wrap items-center gap-y-1">
          {name(row.a.id, a)}
          <span className="text-xs text-fg-muted">
            {row.kind === "broader" ? t("admin.concepts.rel.under") : t("admin.concepts.rel.and")}
          </span>
          {isConcept(row.b) ? name(row.b.id, b) : <span className="px-3 text-sm font-semibold">{b}</span>}
          {state.state === "added" ? (
            <Badge tone="green" icon={Check}>
              {t("admin.concepts.rel.added")}
            </Badge>
          ) : null}
        </div>
        {row.questions !== null ? (
          <p className="text-xs tabular-nums text-fg-muted">{t("admin.concepts.rel.questions", { n: row.questions })}</p>
        ) : null}
        {row.reason !== null ? <p className="text-xs text-fg-muted">{row.reason}</p> : null}
        <RowRefusal id={reasonId} state={state} refused={refused} byId={byId} conflict={conflict} />
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
