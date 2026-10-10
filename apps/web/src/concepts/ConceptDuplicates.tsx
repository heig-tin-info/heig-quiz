import { useQueryClient } from "@tanstack/react-query";
import { Check, GitMerge, Pencil, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { AdminConcept, ConceptDuplicatesAi } from "@quiz/contracts";
import { mergeDirection, probableDuplicates, type DuplicatePair as DuplicatePairOf, type DuplicateReason } from "@quiz/domain";

import { apiErrorMessage } from "../api";
import { useI18n, useT } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Alert, Badge, Button, Card, EmptyState } from "../ui";
import { ConceptMergeDialog } from "./ConceptMergeDialog";
import { ConceptStatusBadge } from "./ConceptStatusBadge";
import { conceptName, refName, usesLabel } from "./names";
import { resolvable } from "./ranking";

export type DuplicatePair = DuplicatePairOf<AdminConcept>;

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

/** A pair the model proposed (purpose `concepts`), with its reason in the model's words. */
export interface AiPair {
  a: AdminConcept;
  b: AdminConcept;
  reason: string;
}

/** The AI's session state, held by the queue so that a paid answer survives a change of filter. */
export interface AiDuplicates {
  ask: () => void;
  pending: boolean;
  error: unknown;
  /** The answer, or undefined before the first ask. */
  result: ConceptDuplicatesAi | undefined;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * The model's pairs on the queue's concepts: a concept that is gone (merged
 * since the call) drops its pair, and so does a pair the deterministic pass
 * already lists. The server validated the rest.
 */
export function aiPairsOf(result: ConceptDuplicatesAi | undefined, concepts: readonly AdminConcept[], found: readonly DuplicatePair[]): AiPair[] {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const known = new Set(found.map((p) => pairKey(p.a.id, p.b.id)));
  return (result?.pairs ?? []).flatMap(({ a, b, reason }) => {
    const [ca, cb] = [byId.get(a), byId.get(b)];
    return ca && cb && !known.has(pairKey(a, b)) ? [{ a: ca, b: cb, reason }] : [];
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
} as const satisfies Record<DuplicateReason, { tone: "red" | "amber" | "zinc"; mergeable: boolean; label: string; why: string }>;

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
  ai: AiDuplicates;
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
              {pairs.map((pair) => {
                const reason = REASONS[pair.reason];
                return (
                  <PairRow
                    key={`${pair.a.id}:${pair.b.id}`}
                    a={pair.a}
                    b={pair.b}
                    names={pair.match?.map(withLang)}
                    badge={<Badge tone={reason.tone}>{t(reason.label)}</Badge>}
                    why={t(reason.why)}
                    mergeable={reason.mergeable}
                    onEdit={onEdit}
                    onMerge={setMerging}
                  />
                );
              })}
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
  ai: AiDuplicates;
  onEdit: (id: string) => void;
  onMerge: (direction: { loser: AdminConcept; target: AdminConcept }) => void;
}) {
  const t = useT();
  return (
    <section aria-label={t("admin.concepts.ai.title")} className="space-y-3 pt-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="secondary" size="sm" loading={ai.pending} onClick={ai.ask}>
          <Sparkles /> {t(ai.result ? "admin.concepts.ai.askAgain" : "admin.concepts.ai.ask")}
        </Button>
        <p className="min-w-0 flex-1 basis-64 text-xs text-fg-muted">{t("admin.concepts.ai.hint")}</p>
      </div>
      {ai.error ? (
        <Alert tone="danger" title={t("admin.concepts.ai.failed")}>
          {apiErrorMessage(ai.error, t("error.llmFailed"))}
        </Alert>
      ) : null}
      {ai.result && !ai.pending && aiPairs.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("admin.concepts.ai.none")}</p>
      ) : null}
      {aiPairs.length > 0 ? (
        <Card>
          <ul className="divide-y divide-line">
            {aiPairs.map((pair) => (
              <PairRow
                key={`${pair.a.id}:${pair.b.id}`}
                a={pair.a}
                b={pair.b}
                badge={
                  <Badge tone="accent" icon={Sparkles}>
                    {t("admin.concepts.ai.badge")}
                  </Badge>
                }
                why={pair.reason}
                mergeable
                onEdit={onEdit}
                onMerge={onMerge}
              />
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}

function PairRow({
  a,
  b,
  names: matched,
  badge,
  why,
  mergeable,
  onEdit,
  onMerge,
}: {
  a: AdminConcept;
  b: AdminConcept;
  /** The labels to show instead of the concepts' names (a translation's matching labels). */
  names?: string[] | undefined;
  badge: ReactNode;
  why: string;
  mergeable: boolean;
  onEdit: (id: string) => void;
  onMerge: (direction: { loser: AdminConcept; target: AdminConcept }) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const direction = mergeable ? mergeDirection(a, b) : null;
  const names = matched ?? [conceptName(a, locale), conceptName(b, locale)];
  const whyId = `dup-${a.id}-${b.id}-why`;

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4">
      <div className="min-w-0 flex-1 basis-72 space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {badge}
          <span id={whyId} className="text-xs text-fg-muted">
            {why}
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
      {!mergeable ? null : direction ? (
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
