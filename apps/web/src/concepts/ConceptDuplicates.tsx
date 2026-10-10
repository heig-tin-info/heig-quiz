import { useQueryClient } from "@tanstack/react-query";
import { Check, GitMerge, Pencil } from "lucide-react";
import { useState } from "react";

import type { AdminConcept } from "@quiz/contracts";
import type { DuplicatePair, DuplicateReason } from "@quiz/domain";

import { useI18n, useT } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Badge, Button, Card, EmptyState } from "../ui";
import { ConceptMergeDialog } from "./ConceptMergeDialog";
import { conceptName, usesLabel } from "./names";

/**
 * Which concept of a pair goes into the other, or null when neither can be
 * the target (a merge target is validated, ADR-081 fifth addendum §2). With
 * two validated ones the less used goes; the first of the pair on a tie.
 */
export function mergeDirection(a: AdminConcept, b: AdminConcept): { loser: AdminConcept; target: AdminConcept } | null {
  if (a.status !== "validated" && b.status !== "validated") return null;
  if (a.status !== "validated") return { loser: a, target: b };
  if (b.status !== "validated") return { loser: b, target: a };
  return b.questionCount < a.questionCount ? { loser: b, target: a } : { loser: a, target: b };
}

/**
 * The probable duplicates (ADR-081 fifth addendum §4), one row per pair: why
 * the two look alike and, unless they are homonym candidates, a merge that
 * opens the dialog with the other concept already chosen. The pairs are
 * computed from the list already loaded (`probableDuplicates`); nothing is
 * stored. The screen's primary action stays Validate: this is a filter of the
 * queue, with merge and edit as secondary actions.
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
  const { locale } = useI18n();
  const qc = useQueryClient();
  const [merging, setMerging] = useState<{ loser: AdminConcept; target: AdminConcept } | null>(null);
  const byId = new Map(concepts.map((c) => [c.id, c]));

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
          {pairs.map((pair) => {
            const a = byId.get(pair.a);
            const b = byId.get(pair.b);
            if (!a || !b) return null;
            return (
              <PairRow
                key={`${pair.a}:${pair.b}`}
                reason={pair.reason}
                pair={[a, b]}
                onEdit={onEdit}
                onMerge={setMerging}
              />
            );
          })}
        </ul>
      </Card>
      {merging ? (
        <ConceptMergeDialog
          concept={merging.loser}
          candidates={concepts}
          initialTarget={merging.target}
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

const REASON_BADGES = {
  alias: { tone: "red", label: "admin.concepts.dup.alias", why: "admin.concepts.dup.alias.why" },
  translation: { tone: "amber", label: "admin.concepts.dup.translation", why: "admin.concepts.dup.translation.why" },
  close: { tone: "amber", label: "admin.concepts.dup.close", why: "admin.concepts.dup.close.why" },
  homonym: { tone: "zinc", label: "admin.concepts.dup.homonym", why: "admin.concepts.dup.homonym.why" },
} as const satisfies Record<DuplicateReason, { tone: "red" | "amber" | "zinc"; label: string; why: string }>;

function PairRow({
  reason,
  pair,
  onEdit,
  onMerge,
}: {
  reason: DuplicateReason;
  pair: [AdminConcept, AdminConcept];
  onEdit: (id: string) => void;
  onMerge: (direction: { loser: AdminConcept; target: AdminConcept }) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const badge = REASON_BADGES[reason];
  // Homonym candidates are never pushed to a merge: the admin checks the qualifiers.
  const direction = reason === "homonym" ? null : mergeDirection(pair[0], pair[1]);
  const whyId = `dup-${pair[0].id}-${pair[1].id}-why`;

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4">
      <div className="min-w-0 flex-1 basis-72 space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone={badge.tone}>{t(badge.label)}</Badge>
          <span id={whyId} className="text-xs text-fg-muted">
            {t(badge.why)}
          </span>
        </div>
        <ul className="space-y-1">
          {pair.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-semibold">{conceptName(c, locale)}</span>
              <Badge tone={c.status === "validated" ? "green" : "amber"}>
                {c.status === "validated" ? t("admin.concepts.status.validated") : t("admin.concepts.status.proposed")}
              </Badge>
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
      {reason === "homonym" ? null : direction ? (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
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
