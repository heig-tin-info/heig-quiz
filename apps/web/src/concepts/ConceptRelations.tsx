import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState, type ReactNode } from "react";

import type { AdminConcept, Concept, ConceptCycle, ConceptRelationAdd, ConceptRelationKind } from "@quiz/contracts";
import { checkBroaderEdge, checkRelatedEdge, edgesOf, type RelationRefusal } from "@quiz/domain";

import { api, ApiError, refusalCodeOf } from "../api";
import { useI18n, useT, type Locale, type TFunction } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Button, Chip, FormError, SearchInput } from "../ui";
import { ConceptStatusBadge } from "./ConceptStatusBadge";
import { conceptName, conceptSide, narrowerOf, refName } from "./names";
import { rankConcepts } from "./ranking";
import { BroaderPath, ConceptLabel } from "./refs";
import type { RowState, TopConcept } from "./relationReview";

const SHOWN = 5;
/** How many of a broader candidate's narrower concepts "Currently holds" names before "+n". */
const HELD = 5;

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
function ruleRefusal(t: TFunction, refusal: RelationRefusal, byId: ReadonlyMap<string, AdminConcept>, locale: Locale): string {
  if (refusal.kind !== "cycle") return t("admin.concepts.relations.error.redundant");
  const path = refusal.path.map((id) => (byId.has(id) ? conceptName(byId.get(id)!, locale) : "?")).join(" › ");
  return t("admin.concepts.relations.error.cycle", { path });
}

/**
 * What stops a proposed row (the Relations view, the sheet's suggestions):
 * the server's refusal of its write, else the rule's reason for a row the
 * vocabulary has moved past, else `conflict` (a ticked row rules it out).
 * `id` lets the row's control point at the reason.
 */
export function RowRefusal({
  id,
  state,
  refused,
  byId,
  conflict = false,
}: {
  id?: string;
  state: RowState;
  refused: unknown;
  byId: ReadonlyMap<string, AdminConcept>;
  conflict?: boolean;
}) {
  const t = useT();
  const { locale } = useI18n();
  if (refused) return <FormError error={refused} describe={(error) => relationError(t, error)} />;
  const reason =
    state.state === "blocked" ? ruleRefusal(t, state.refusal, byId, locale) : conflict ? t("admin.concepts.rel.ai.conflict") : null;
  return reason ? (
    <p id={id} className="text-xs text-fg-muted">
      {reason}
    </p>
  ) : null;
}

/** A missing top concept the model proposes, by name, marked as the proposed concept accepting it creates. */
export function TopHeading({ top }: { top: TopConcept }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-sm font-semibold">{t("admin.concepts.rel.top.new", { name: refName(top) })}</span>
      <ConceptStatusBadge status="proposed" />
    </div>
  );
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
 * "Currently holds: A, B (+n more)": the narrower concepts a broader candidate
 * already has, its would-be siblings; nothing when none. `id` lets the
 * candidate's button be described by it.
 */
function Holds({ held, id }: { held: readonly AdminConcept[]; id: string }) {
  const t = useT();
  const { locale } = useI18n();
  if (held.length === 0) return null;
  const names = held.slice(0, HELD).map((c) => conceptName(c, locale)).join(", ");
  return (
    <p id={id} className="text-xs text-fg-muted">
      {t("admin.concepts.relations.holds", { names })}
      {held.length > HELD ? <span className="text-fg-faint"> {t("admin.concepts.relations.holds.more", { n: held.length - HELD })}</span> : null}
    </p>
  );
}

/**
 * One kind of relation of a concept: its chips, each removable, and a search
 * that offers the concepts the rule of `@quiz/domain` accepts (the server's
 * own check, run on the edges once), each with its path, and for a broader
 * candidate the narrower concepts it holds already; a click adds one. The
 * server still decides: a cycle comes back as a 409 naming the path.
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
  const holdsId = useId();
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
        <ul className="space-y-2">
          {offered.map((c) => {
            const held = kind === "broader" ? narrowerOf(concepts, c.id, locale) : [];
            const described = `${holdsId}-${c.id}`;
            return (
              <li key={c.id} className="flex flex-col items-start gap-0.5">
                <Button
                  variant="secondary"
                  size="sm"
                  aria-describedby={held.length > 0 ? described : undefined}
                  loading={add.isPending && add.variables?.target === c.id}
                  onClick={() => add.mutate({ kind, target: c.id })}
                >
                  {conceptName(c, locale)}
                </Button>
                <BroaderPath concept={c} byId={byId} locale={locale} />
                <Holds held={held} id={described} />
              </li>
            );
          })}
        </ul>
      )}
      <FormError error={add.error ?? remove.error} describe={(error) => relationError(t, error)} />
    </div>
  );
}

/**
 * The concepts directly under this one (#897), read-only, by name, a proposed
 * one marked: the edge belongs to the child, so a narrower concept is placed
 * from its own sheet. A name opens nothing, as the path: switching sheets
 * would drop unsaved edits.
 */
function Narrower({ concept, concepts }: { concept: AdminConcept; concepts: readonly AdminConcept[] }) {
  const t = useT();
  const { locale } = useI18n();
  const narrower = useMemo(() => narrowerOf(concepts, concept.id, locale), [concepts, concept.id, locale]);
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">{t("admin.concepts.relations.narrower")}</h4>
      {narrower.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("admin.concepts.relations.narrower.none")}</p>
      ) : (
        <ul aria-label={t("admin.concepts.relations.narrower")} className="space-y-1 text-sm">
          {narrower.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ConceptLabel concept={conceptSide(c, locale)} />
              {c.status === "proposed" ? <ConceptStatusBadge status="proposed" /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The relations of a concept (ADR-081 §4, sixth addendum 7c), the admin's:
 * its broader concepts, what the caller puts under them, its narrower ones
 * (read-only) and its related ones. Each change is saved at once and audited
 * alone, like the aliases.
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
  /** Rendered under the broader concepts, before the narrower ones. */
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <fieldset className="space-y-4">
      <legend className="mb-1 text-base font-bold tracking-tight">{t("admin.concepts.relations")}</legend>
      <p className="text-xs text-fg-muted">{t("admin.concepts.relations.desc")}</p>
      <Group kind="broader" concept={concept} concepts={concepts} byId={byId} />
      {children}
      <Narrower concept={concept} concepts={concepts} />
      <Group kind="related" concept={concept} concepts={concepts} byId={byId} />
    </fieldset>
  );
}
