import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { Check, GitMerge, Pencil, Sparkles } from "lucide-react";
import { useState } from "react";

import type { AdminConcept, ConceptDuplicatesAi } from "@quiz/contracts";
import { mergeDirection, probableDuplicates, type AiDuplicateKind, type DuplicatePair as DuplicatePairOf, type DuplicateReason } from "@quiz/domain";

import { apiErrorMessage } from "../api";
import { useI18n, useT } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Alert, Badge, Button, Card, EmptyState } from "../ui";
import { ConceptMergeDialog } from "./ConceptMergeDialog";
import { ConceptStatusBadge } from "./ConceptStatusBadge";
import { conceptName, refName, usesLabel } from "./names";
import { resolvable } from "./ranking";

/** The reason of a pair: the pre-pass's, or, for a model's, one of its kinds (`related` is its own). */
export type DuplicatePair = Omit<DuplicatePairOf<AdminConcept>, "reason"> & { reason: DuplicateReason | AiDuplicateKind };

/**
 * The probable duplicates of the queue's list (`probableDuplicates`, ADR-081
 * fifth addendum §4): computed on read, nothing is stored.
 */
export function duplicatePairs(concepts: readonly AdminConcept[]): DuplicatePair[] {
  return probableDuplicates(concepts.map((concept) => ({ ...resolvable(concept), concept }))).map(({ a, b, ...rest }) => ({
    ...rest,
    a: a.concept,
    b: b.concept,
  }));
}

/** A pair the model proposed (purpose `concepts`), with its reason, in the model's words, in `ai`. */
export type AiPair = DuplicatePair & { ai: string };

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * The model's pairs on the queue's concepts: a concept that is gone (merged
 * since the call) drops its pair, and so does a pair the deterministic pass
 * already lists. The server validated the rest.
 */
export function aiPairsOf(result: ConceptDuplicatesAi | undefined, concepts: readonly AdminConcept[], found: readonly DuplicatePair[]): AiPair[] {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const known = new Set(found.map((p) => pairKey(p.a.id, p.b.id)));
  return (result?.pairs ?? []).flatMap(({ a, b, kind, reason }) => {
    const [ca, cb] = [byId.get(a), byId.get(b)];
    return ca && cb && !known.has(pairKey(a, b)) ? [{ a: ca, b: cb, reason: kind, ai: reason }] : [];
  });
}

/**
 * A translation pair's matching labels, each with its language (`Hash table
 * (FR)` / `Hash table (EN)`): the interface language would show both concepts
 * under the one label they share, and hide why they match.
 */
const withLang = ({ lang, ...label }: { label: string; qualifier: string; lang?: string }) =>
  lang ? `${refName(label)} (${lang.toUpperCase()})` : refName(label);

const REASONS = {
  alias: { tone: "red", mergeable: true, label: "admin.concepts.dup.alias", why: "admin.concepts.dup.alias.why" },
  translation: { tone: "amber", mergeable: true, label: "admin.concepts.dup.translation", why: "admin.concepts.dup.translation.why" },
  close: { tone: "amber", mergeable: true, label: "admin.concepts.dup.close", why: "admin.concepts.dup.close.why" },
  // Often two real concepts: the admin checks the qualifiers, a merge is not proposed.
  homonym: { tone: "zinc", mergeable: false, label: "admin.concepts.dup.homonym", why: "admin.concepts.dup.homonym.why" },
  // Connected but distinct (the model's kind): never merged.
  related: { tone: "zinc", mergeable: false, label: "admin.concepts.dup.related", why: "admin.concepts.dup.related.why" },
} as const satisfies Record<DuplicateReason | AiDuplicateKind, { tone: "red" | "amber" | "zinc"; mergeable: boolean; label: string; why: string }>;

/**
 * The probable duplicates, one row per pair: why the two look alike and,
 * unless they are homonym candidates, a merge that opens the dialog with the
 * other concept already chosen. The screen's primary action stays Validate:
 * this is a filter of the queue, with merge and edit as secondary actions.
 */
export function ConceptDuplicates({
  pairs,
  aiPairs,
  ai,
  concepts,
  onEdit,
}: {
  pairs: readonly DuplicatePair[];
  aiPairs: readonly AiPair[];
  ai: UseMutationResult<ConceptDuplicatesAi, Error, void>;
  concepts: readonly AdminConcept[];
  onEdit: (id: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [merging, setMerging] = useState<{ loser: AdminConcept; target: AdminConcept } | null>(null);

  return (
    <>
      {pairs.length === 0 ? (
        <Card>
          <EmptyState icon={Check} title={t("admin.concepts.dup.empty.title")}>
            {t("admin.concepts.dup.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          <p className="text-[13px] text-fg-muted">{t("admin.concepts.dup.hint")}</p>
          <Card>
            <ul className="divide-y divide-line">
              {pairs.map((pair) => (
                <PairRow key={`${pair.a.id}:${pair.b.id}`} pair={pair} onEdit={onEdit} onMerge={setMerging} />
              ))}
            </ul>
          </Card>
        </>
      )}

      <AiSuggestions aiPairs={aiPairs} ai={ai} onEdit={onEdit} onMerge={setMerging} />
      {merging ? (
        <ConceptMergeDialog
          concept={merging.loser}
          candidates={concepts}
          initialTarget={merging.target.id}
          onClose={() => setMerging(null)}
          onMerged={() => {
            void qc.invalidateQueries({ queryKey: adminConceptsKey });
            void qc.invalidateQueries({ queryKey: conceptsKey });
            setMerging(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * "Ask the AI" (ADR-081 fifth addendum §4): a secondary action under the
 * deterministic pairs. It sends the concepts' labels and qualifiers and
 * nothing else; the pairs it brings back are suggestions, labelled as such,
 * and lost on reload.
 */
function AiSuggestions({
  aiPairs,
  ai,
  onEdit,
  onMerge,
}: {
  aiPairs: readonly AiPair[];
  ai: UseMutationResult<ConceptDuplicatesAi, Error, void>;
  onEdit: (id: string) => void;
  onMerge: (direction: { loser: AdminConcept; target: AdminConcept }) => void;
}) {
  const t = useT();
  return (
    <section aria-label={t("admin.concepts.ai.title")} className="space-y-3 pt-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="secondary" size="sm" loading={ai.isPending} onClick={() => ai.mutate()}>
          <Sparkles /> {t(ai.data ? "admin.concepts.ai.askAgain" : "admin.concepts.ai.ask")}
        </Button>
        <p className="min-w-0 flex-1 basis-64 text-xs text-fg-muted">
          {t("admin.concepts.ai.hint")}
          {ai.data?.truncated ? ` ${t("admin.concepts.ai.truncated")}` : ""}
        </p>
      </div>
      {ai.isError ? (
        <Alert tone="danger" title={t("admin.concepts.ai.failed")}>
          {apiErrorMessage(ai.error, t("error.llmFailed"))}
        </Alert>
      ) : null}
      {ai.data && !ai.isPending && aiPairs.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("admin.concepts.ai.none")}</p>
      ) : null}
      {aiPairs.length > 0 ? (
        <Card>
          <ul className="divide-y divide-line">
            {aiPairs.map((pair) => (
              <PairRow key={`${pair.a.id}:${pair.b.id}`} pair={pair} ai={pair.ai} onEdit={onEdit} onMerge={onMerge} />
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}

function PairRow({
  pair,
  ai,
  onEdit,
  onMerge,
}: {
  pair: DuplicatePair;
  /** The model's sentence, when the pair is its suggestion. */
  ai?: string;
  onEdit: (id: string) => void;
  onMerge: (direction: { loser: AdminConcept; target: AdminConcept }) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const reason = REASONS[pair.reason];
  const [a, b] = [pair.a, pair.b];
  const direction = reason.mergeable ? mergeDirection(a, b) : null;
  const names = pair.match?.map(withLang) ?? [conceptName(a, locale), conceptName(b, locale)];
  const whyId = `dup-${a.id}-${b.id}-why`;

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4">
      <div className="min-w-0 flex-1 basis-72 space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone={reason.tone} {...(ai === undefined ? {} : { icon: Sparkles })}>
            {t(reason.label)}
          </Badge>
          {ai === undefined ? null : <span className="text-xs font-medium text-fg-muted">{t("admin.concepts.ai.badge")}</span>}
          <span id={whyId} className="text-xs text-fg-muted">
            {ai ?? t(reason.why)}
          </span>
        </div>
        <ul className="space-y-1">
          {[a, b].map((c, i) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-semibold">{names[i]}</span>
              <ConceptStatusBadge status={c.status} />
              <span className="text-xs tabular-nums text-fg-muted">{usesLabel(t, c.questionCount)}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("admin.concepts.editNamed", { name: conceptName(c, locale) })}
                onClick={() => onEdit(c.id)}
              >
                <Pencil /> {t("admin.concepts.edit")}
              </Button>
            </li>
          ))}
        </ul>
      </div>
      {!reason.mergeable ? null : direction ? (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          aria-describedby={whyId}
          aria-label={t("admin.concepts.dup.mergeNamed", {
            name: conceptName(direction.loser, locale),
            target: conceptName(direction.target, locale),
          })}
          onClick={() => onMerge(direction)}
        >
          <GitMerge /> {t("admin.concepts.dup.mergeOne", { name: conceptName(direction.loser, locale) })}
        </Button>
      ) : (
        <p className="shrink-0 self-center text-xs text-fg-muted">{t("admin.concepts.dup.validateFirst")}</p>
      )}
    </li>
  );
}
