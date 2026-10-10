import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { AdminConcept, Concept, ConceptMerge } from "@quiz/contracts";

import { api, refusalCodeOf } from "../api";
import { useI18n, useT } from "../i18n";
import { Button, Checkbox, FormError, Modal, RadioRow, SearchInput } from "../ui";
import { conceptName, usesLabel } from "./names";
import { rankConcepts } from "./ranking";

/** How many candidates the list shows at once; the search narrows the rest. */
const SHOWN = 8;

/**
 * Merging a concept into a validated one (ADR-081, fifth addendum §2). The
 * target is searched among the validated concepts with the picker's own rule
 * (`rankConcepts`); the dialog says what the merge does before the admin
 * confirms: the questions that now use the target, and that the merged
 * concept's label no longer designates anything. There is no undo.
 */
export function ConceptMergeDialog({
  concept,
  candidates,
  onClose,
  onMerged,
}: {
  concept: AdminConcept;
  /** The queue's concepts; the validated ones other than `concept` are offered. */
  candidates: readonly AdminConcept[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  // Off by default (ADR-081 §6): the merged label is dropped unless the admin keeps it as an alias.
  const [keepAlias, setKeepAlias] = useState(false);
  const name = conceptName(concept, locale);

  const targets = useMemo(() => candidates.filter((c) => c.status === "validated" && c.id !== concept.id), [candidates, concept.id]);
  const shown = useMemo(() => rankConcepts(typed.trim(), targets, locale).slice(0, SHOWN), [targets, typed, locale]);
  const target = targets.find((c) => c.id === picked);

  const merge = useMutation({
    mutationFn: (body: ConceptMerge) =>
      api<Concept>(`/app/api/admin/concepts/${concept.id}/merge`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: onMerged,
  });

  const effect = (into: string) =>
    concept.questionCount === 0
      ? t("admin.concepts.merge.effect.none", { name, target: into })
      : concept.questionCount === 1
        ? t("admin.concepts.merge.effect.one", { name, target: into })
        : t("admin.concepts.merge.effect", { n: concept.questionCount, name, target: into });

  const describe = (error: unknown) => {
    switch (refusalCodeOf(error)) {
      case "concept_merged":
        return t("admin.concepts.error.merged");
      case "concept_merge_target_not_validated":
        return t("admin.concepts.error.targetNotValidated");
      default:
        return t("admin.concepts.error.merge");
    }
  };

  return (
    <Modal
      title={t("admin.concepts.merge.title", { name })}
      subtitle={usesLabel(t, concept.questionCount)}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={merge.isPending}
            disabled={target === undefined}
            onClick={() => target && merge.mutate({ into: target.id, keepAsAlias: keepAlias })}
          >
            {t("admin.concepts.merge.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[13px] text-fg-muted">{t("admin.concepts.merge.hint")}</p>
        <SearchInput
          className="w-full"
          aria-label={t("admin.concepts.merge.search")}
          placeholder={t("admin.concepts.merge.search")}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        {shown.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("admin.concepts.merge.none")}</p>
        ) : (
          <fieldset className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            <legend className="sr-only">{t("admin.concepts.merge.target")}</legend>
            {shown.map((c) => (
              <RadioRow key={c.id} name="merge-target" value={c.id} checked={picked === c.id} onPick={setPicked}>
                <span className="font-semibold">{conceptName(c, locale)}</span>
                <span className="ml-2 text-xs tabular-nums text-fg-muted">{usesLabel(t, c.questionCount)}</span>
              </RadioRow>
            ))}
          </fieldset>
        )}
        {target ? (
          <>
            <p role="status" className="text-sm">
              {effect(conceptName(target, locale))}
            </p>
            <div className="space-y-1">
              <Checkbox
                checked={keepAlias}
                onChange={(e) => setKeepAlias(e.target.checked)}
                label={t("admin.concepts.merge.keepAlias", { name, target: conceptName(target, locale) })}
              />
              <p className="pl-[26px] text-xs text-fg-muted">
                {t("admin.concepts.merge.keepAlias.hint", { name, target: conceptName(target, locale) })}
              </p>
            </div>
          </>
        ) : null}
        <FormError error={merge.error} describe={describe} />
      </div>
    </Modal>
  );
}
