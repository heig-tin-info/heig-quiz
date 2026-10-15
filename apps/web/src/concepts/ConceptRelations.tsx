import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

import type { AdminConcept, Concept, ConceptCycle, ConceptRelationAdd, ConceptRelationKind } from "@quiz/contracts";
import { checkBroaderEdge, checkRelatedEdge, edgesOf, type RelationRefusal } from "@quiz/domain";

import { api, ApiError, refusalCodeOf } from "../api";
import { useI18n, useT, type Locale, type TFunction } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Button, Chip, FormError, SearchInput } from "../ui";
import { conceptName, refName } from "./names";
import { rankConcepts } from "./ranking";

const SHOWN = 5;

/** `A › B › A`: the closed path a cycle refusal names. */
export const pathLabel = (error: unknown): string | null =>
  error instanceof ApiError && Array.isArray((error.body as Partial<ConceptCycle> | null)?.path)
    ? (error.body as ConceptCycle).path.map(refName).join(" › ")
    : null;

/** The message of a refused relation write, naming the path of a cycle. */
export function relationError(t: TFunction, error: unknown): string {
  switch (refusalCodeOf(error)) {
    case "concept_cycle":
      return t("admin.concepts.relations.error.cycle", { path: pathLabel(error) ?? "" });
    case "relation_exists":
      return t("admin.concepts.relations.error.exists");
    case "relation_redundant":
      return t("admin.concepts.relations.error.redundant");
    case "concept_merged":
    case "concept_not_found":
      return t("admin.concepts.error.merged");
    default:
      return t("admin.concepts.relations.error.save");
  }
}

/** Why the rule refuses an edge the vocabulary has moved past since it was proposed: a cycle names its path. */
export function ruleRefusal(t: TFunction, refusal: RelationRefusal, byId: ReadonlyMap<string, AdminConcept>, locale: Locale): string {
  if (refusal.kind !== "cycle") return t("admin.concepts.relations.error.redundant");
  const path = refusal.path.map((id) => (byId.has(id) ? conceptName(byId.get(id)!, locale) : "?")).join(" › ");
  return t("admin.concepts.relations.error.cycle", { path });
}

/**
 * Adds a relation of `conceptId` (the admin's `POST .../relations`) and
 * refreshes the vocabulary; shared by the sheet and the Duplicates view.
 */
export function useAddRelation(conceptId: string, onAdded?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConceptRelationAdd) =>
      api<Concept>(`/app/api/admin/concepts/${conceptId}/relations`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      onAdded?.();
      void qc.invalidateQueries({ queryKey: adminConceptsKey });
      void qc.invalidateQueries({ queryKey: conceptsKey });
    },
  });
}

/**
 * One kind of relation of a concept: its chips, each removable, and a search
 * that offers the concepts the rule of `@quiz/domain` accepts (the server's
 * own check, run on the edges once); a click adds one. The server still
 * decides: a cycle comes back as a 409 naming the path.
 */
function Group({
  kind,
  concept,
  concepts,
  byId,
}: {
  kind: ConceptRelationKind;
  concept: AdminConcept;
  concepts: readonly AdminConcept[];
  byId: ReadonlyMap<string, AdminConcept>;
}) {
  const t = useT();
  const { locale } = useI18n();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const current = kind === "broader" ? concept.broader : concept.related;

  const offered = useMemo(() => {
    if (typed.trim() === "") return [];
    const edges = edgesOf(concepts);
    const check = kind === "broader" ? checkBroaderEdge : checkRelatedEdge;
    const pool = concepts.filter((c) => c.status !== "merged" && check(edges, concept.id, c.id) === null);
    return rankConcepts(typed.trim(), pool, locale).slice(0, SHOWN);
  }, [concepts, concept.id, kind, typed, locale]);

  const changed = () => {
    void qc.invalidateQueries({ queryKey: adminConceptsKey });
    void qc.invalidateQueries({ queryKey: conceptsKey });
  };
  const base = `/app/api/admin/concepts/${concept.id}/relations`;
  const add = useAddRelation(concept.id, () => setTyped(""));
  const remove = useMutation({
    mutationFn: (target: string) => api<Concept>(`${base}/${kind}/${target}`, { method: "DELETE" }),
    onSuccess: changed,
  });
  const names = [...current]
    .map((id) => ({ id, name: byId.has(id) ? conceptName(byId.get(id)!, locale) : id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">{t(`admin.concepts.relations.${kind}`)}</h4>
      {names.length === 0 ? (
        <p className="text-sm text-fg-muted">{t(`admin.concepts.relations.${kind}.none`)}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {names.map(({ id, name }) => (
            <li key={id}>
              <Chip
                label={name}
                remove={t("admin.concepts.relations.remove")}
                disabled={remove.isPending}
                onRemove={() => remove.mutate(id)}
              />
            </li>
          ))}
        </ul>
      )}
      <SearchInput
        className="w-full"
        aria-label={t(`admin.concepts.relations.${kind}.search`)}
        placeholder={t(`admin.concepts.relations.${kind}.search`)}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      {typed.trim() !== "" && offered.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("admin.concepts.relations.none")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {offered.map((c) => (
            <li key={c.id}>
              <Button variant="secondary" size="sm" loading={add.isPending && add.variables?.target === c.id} onClick={() => add.mutate({ kind, target: c.id })}>
                {conceptName(c, locale)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FormError error={add.error ?? remove.error} describe={(error) => relationError(t, error)} />
    </div>
  );
}

/**
 * The relations of a concept (ADR-081 §4, sixth addendum 7c), the admin's:
 * its broader concepts, with the model's suggestions for them on demand, and
 * its related ones. Each change is saved at once and audited alone, like the
 * aliases.
 */
export function ConceptRelations({
  concept,
  concepts,
  byId,
  children,
}: {
  concept: AdminConcept;
  concepts: readonly AdminConcept[];
  byId: ReadonlyMap<string, AdminConcept>;
  /** Under the broader concepts: the sheet's Suggest a broader concept. */
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <fieldset className="space-y-4">
      <legend className="mb-1 text-base font-bold tracking-tight">{t("admin.concepts.relations")}</legend>
      <p className="text-xs text-fg-muted">{t("admin.concepts.relations.desc")}</p>
      <Group kind="broader" concept={concept} concepts={concepts} byId={byId} />
      {children}
      <Group kind="related" concept={concept} concepts={concepts} byId={byId} />
    </fieldset>
  );
}
