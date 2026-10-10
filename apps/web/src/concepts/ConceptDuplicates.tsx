import { useQueryClient } from "@tanstack/react-query";
import { Check, GitMerge, Pencil } from "lucide-react";
import { useState } from "react";

import type { AdminConcept } from "@quiz/contracts";
import { mergeDirection, probableDuplicates, type DuplicatePair as DuplicatePairOf, type DuplicateReason } from "@quiz/domain";

import { useI18n, useT } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Badge, Button, Card, EmptyState } from "../ui";
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
  concepts,
  onEdit,
}: {
  pairs: readonly DuplicatePair[];
  concepts: readonly AdminConcept[];
  onEdit: (id: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [merging, setMerging] = useState<{ loser: AdminConcept; target: AdminConcept } | null>(null);

  if (pairs.length === 0) {
    return (
      <Card>
        <EmptyState icon={Check} title={t("admin.concepts.dup.empty.title")}>
          {t("admin.concepts.dup.empty.body")}
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <p className="text-[13px] text-fg-muted">{t("admin.concepts.dup.hint")}</p>
      <Card>
        <ul className="divide-y divide-line">
          {pairs.map((pair) => (
            <PairRow key={`${pair.a.id}:${pair.b.id}`} pair={pair} onEdit={onEdit} onMerge={setMerging} />
          ))}
        </ul>
      </Card>
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

function PairRow({
  pair,
  onEdit,
  onMerge,
}: {
  pair: DuplicatePair;
  onEdit: (id: string) => void;
  onMerge: (direction: { loser: AdminConcept; target: AdminConcept }) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const reason = REASONS[pair.reason];
  const direction = reason.mergeable ? mergeDirection(pair.a, pair.b) : null;
  const names = pair.match?.map(withLang) ?? [conceptName(pair.a, locale), conceptName(pair.b, locale)];
  const whyId = `dup-${pair.a.id}-${pair.b.id}-why`;

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4">
      <div className="min-w-0 flex-1 basis-72 space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone={reason.tone}>{t(reason.label)}</Badge>
          <span id={whyId} className="text-xs text-fg-muted">
            {t(reason.why)}
          </span>
        </div>
        <ul className="space-y-1">
          {[pair.a, pair.b].map((c, i) => (
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
