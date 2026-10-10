import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { AdminConcept, Concept, ConceptCycle, ConceptRelationAdd, ConceptRelationKind } from "@quiz/contracts";
import { broaderAncestors, narrowerDescendants } from "@quiz/domain";

import { api, ApiError, refusalCodeOf } from "../api";
import { useI18n, useT, type TFunction } from "../i18n";
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

/**
 * One kind of relation of a concept: its chips, each removable, and a search
 * that offers the concepts the server would accept (never the concept, one
 * already there, or, by the rule of `@quiz/domain`, one in a chain with it for
 * `related`, or below it for `broader`); a click adds one. The server still
 * decides: a cycle comes back as a 409 naming the path.
 */
function Group({
  kind,
  concept,
  concepts,
}: {
  kind: ConceptRelationKind;
  concept: AdminConcept;
  concepts: readonly AdminConcept[];
}) {
  const t = useT();
  const { locale } = useI18n();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const current = kind === "broader" ? concept.broader : concept.related;
  const byId = useMemo(() => new Map(concepts.map((c) => [c.id, c])), [concepts]);

  const offered = useMemo(() => {
    const edges = concepts.flatMap((c) => c.broader.map((target) => ({ concept: c.id, target })));
    const below = new Set(narrowerDescendants(edges, concept.id));
    const above = new Set(broaderAncestors(edges, concept.id));
    const taken = new Set([concept.id, ...current]);
    const pool = concepts.filter((c) => {
      if (c.status === "merged" || taken.has(c.id)) return false;
      if (kind === "broader") return !below.has(c.id) && !concept.related.includes(c.id);
      return !below.has(c.id) && !above.has(c.id);
    });
    return typed.trim() === "" ? [] : rankConcepts(typed.trim(), pool, locale).slice(0, SHOWN);
  }, [concepts, concept, current, kind, typed, locale]);

  const changed = () => {
    void qc.invalidateQueries({ queryKey: adminConceptsKey });
    void qc.invalidateQueries({ queryKey: conceptsKey });
  };
  const base = `/app/api/admin/concepts/${concept.id}/relations`;
  const add = useMutation({
    mutationFn: (target: string) =>
      api<Concept>(base, { method: "POST", body: JSON.stringify({ kind, target } satisfies ConceptRelationAdd) }),
    onSuccess: () => {
      setTyped("");
      changed();
    },
  });
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
              <Button variant="secondary" size="sm" loading={add.isPending && add.variables === c.id} onClick={() => add.mutate(c.id)}>
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
 * its broader concepts and its related ones. Each change is saved at once and
 * audited alone, like the aliases.
 */
export function ConceptRelations({ concept, concepts }: { concept: AdminConcept; concepts: readonly AdminConcept[] }) {
  const t = useT();
  return (
    <fieldset className="space-y-4">
      <legend className="mb-1 text-base font-bold tracking-tight">{t("admin.concepts.relations")}</legend>
      <p className="text-xs text-fg-muted">{t("admin.concepts.relations.desc")}</p>
      <Group kind="broader" concept={concept} concepts={concepts} />
      <Group kind="related" concept={concept} concepts={concepts} />
    </fieldset>
  );
}
