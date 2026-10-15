import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";

import { type AdminConcept, ConceptRelationProposals, type ConceptRelationsAiRequest } from "@quiz/contracts";
import { edgesOf } from "@quiz/domain";

import { api } from "../api";
import { useI18n, useT } from "../i18n";
import { useLlmAvailability } from "../llmAvailability";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Badge, Button, Card } from "../ui";
import { AiAsk } from "./AiAsk";
import { RowRefusal, TopHeading } from "./ConceptRelations";
import { conceptName, refName } from "./names";
import { BroaderPath } from "./refs";
import {
  broaderRowsFor,
  createTop,
  isConcept,
  relateRow,
  rowState,
  runAccept,
  type Outcome,
  type RelationRow,
} from "./relationReview";

/**
 * "Suggest a broader concept" on the concept sheet (ADR-114 §3): the model's
 * pass of the Relations view (`POST /admin/concepts/relations/ai`) asked for
 * this one concept. Only its broader rows are shown — towards an existing
 * concept, with that concept's path, or towards a missing top concept — and
 * each is added on its own through the relation route, a top concept created
 * first (`runAccept`). A row written reads "Added" at once, so it is never
 * sent twice. Nothing is written until the admin adds a row; the reply is
 * kept by the sheet only. Offered only when a model is configured.
 */
export function ConceptBroaderSuggestion({
  concept,
  concepts,
  byId,
}: {
  concept: AdminConcept;
  concepts: readonly AdminConcept[];
  byId: ReadonlyMap<string, AdminConcept>;
}) {
  const t = useT();
  const { locale } = useI18n();
  const qc = useQueryClient();
  const llm = useLlmAvailability();
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const ask = useMutation({
    mutationFn: async () =>
      ConceptRelationProposals.parse(
        await api("/app/api/admin/concepts/relations/ai", {
          method: "POST",
          body: JSON.stringify({ concept: concept.id } satisfies ConceptRelationsAiRequest),
        }),
      ),
    onSuccess: () => setOutcomes(new Map()),
  });
  const accept = useMutation({
    mutationFn: (row: RelationRow) => runAccept([row], { create: createTop, relate: relateRow }),
    onSuccess: (done) => {
      setOutcomes((was) => new Map([...was, ...done]));
      void qc.invalidateQueries({ queryKey: adminConceptsKey });
      void qc.invalidateQueries({ queryKey: conceptsKey });
    },
  });
  const rows = useMemo(() => broaderRowsFor(ask.data, concepts, concept.id), [ask.data, concepts, concept.id]);
  const edges = useMemo(() => edgesOf(concepts), [concepts]);
  if (llm.data?.available !== true) return null;

  const render = (row: RelationRow) => {
    // The broader concept of the vocabulary, or null for a top concept still to create.
    const [known, name] = isConcept(row.b) ? [row.b, conceptName(row.b, locale)] : [null, refName(row.b)];
    const state = rowState(row, edges);
    const outcome = outcomes.get(row.key);
    const refused = outcome && "error" in outcome ? outcome.error : null;
    const added = state.state === "added" || (outcome !== undefined && "ok" in outcome);
    return (
      <li key={row.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        <div className="min-w-0 flex-1 basis-48 space-y-0.5">
          {known ? <span className="text-sm font-semibold">{name}</span> : row.top ? <TopHeading top={row.top} /> : null}
          {known ? <BroaderPath concept={known} byId={byId} locale={locale} /> : null}
          {row.top ? <p className="text-xs text-fg-muted">{row.top.reason}</p> : null}
          <RowRefusal state={state} refused={refused} byId={byId} />
        </div>
        {added ? (
          <Badge tone="green" icon={Check}>
            {t("admin.concepts.rel.added")}
          </Badge>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto shrink-0"
            disabled={state.state === "blocked" || (accept.isPending && accept.variables?.key !== row.key)}
            loading={accept.isPending && accept.variables?.key === row.key}
            aria-label={t(known ? "admin.concepts.relations.suggest.addNamed" : "admin.concepts.relations.suggest.createNamed", { name })}
            onClick={() => accept.mutate(row)}
          >
            {t(known ? "admin.concepts.relations.suggest.add" : "admin.concepts.relations.suggest.create")}
          </Button>
        )}
      </li>
    );
  };

  return (
    <section aria-label={t("admin.concepts.relations.suggest")} className="space-y-3">
      <AiAsk
        label={t("admin.concepts.relations.suggest")}
        hint={t("admin.concepts.relations.suggest.hint")}
        pending={ask.isPending}
        error={ask.error}
        failedTitle={t("admin.concepts.relations.suggest.failed")}
        onAsk={() => ask.mutate()}
      />
      {ask.data && !ask.isPending ? (
        rows.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("admin.concepts.relations.suggest.none")}</p>
        ) : (
          <Card>
            <ul aria-label={t("admin.concepts.relations.suggest.list")} className="divide-y divide-line">
              {rows.map(render)}
            </ul>
          </Card>
        )
      ) : null}
    </section>
  );
}
