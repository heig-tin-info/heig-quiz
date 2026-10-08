/**
 * The state of the tag sorting screen (ADR-081, second addendum), apart from
 * its markup: the filter and the search, the ticked pairs, the decisions set
 * here and not accepted yet, and the accept with what it may answer.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  TagSortingConflict,
  TagSortingItemsError,
  type Concept,
  type TagPair,
  type TagSortingAccept,
  type TagSortingAcceptResponse,
  type TagSortingChoice,
  type TagSortingItem,
  type TagSortingList,
  type TagSortingRow,
} from "@quiz/contracts";

import { api, ApiError, apiErrorMessage } from "../api";
import { fuzzyScore } from "../fuzzy";
import { useT, type Locale, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { adminConceptSortingKey, conceptsKey } from "../queryKeys";

export const FILTERS = ["undecided", "accepted", "all"] as const;
export type Filter = (typeof FILTERS)[number];

/**
 * A decision not accepted yet, and where it comes from: the admin, here.
 * The model's proposals (a later step) will be the other source, read by
 * `decisionOf` when the admin has set nothing on the pair.
 */
export interface Pending {
  choice: TagSortingChoice;
  /** The concept a `concept` choice names, to show it. */
  concept?: Concept;
  source: "admin";
}

export type Conflict = TagSortingConflict["conflicts"][number];
export type ItemsErrorCode = TagSortingItemsError["error"];

export const keyOf = (p: TagPair) => JSON.stringify([p.poolId, p.tag]);

/** The rows in their `conceptKey` groups; the list already comes in group order. */
export function groupRows(rows: readonly TagSortingRow[]): { key: string; rows: TagSortingRow[] }[] {
  const groups = new Map<string, TagSortingRow[]>();
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  return [...groups].map(([key, list]) => ({ key, rows: list }));
}

/** The pairs the most questions wear first: what a decision is named after. */
export const byUse = (pairs: readonly TagSortingRow[]) => [...pairs].sort((a, b) => b.count - a.count);

/** The label in the reader's language, else the other, with its qualifier: `Adresse (mémoire)`. */
export function conceptName(c: Concept, locale: Locale): string {
  const lang = c.labels[locale] !== null ? locale : locale === "fr" ? "en" : "fr";
  const qualifier = c.qualifiers[lang];
  return qualifier ? `${c.labels[lang]} (${qualifier})` : (c.labels[lang] ?? "");
}

/** What a pending decision reads as. */
export function choiceText(t: TFunction, locale: Locale, p: Pending): string {
  const { choice } = p;
  if (choice.kind === "drop") return t("admin.concepts.dropNamed", { reason: t(`admin.concepts.reason.${choice.reason}`) });
  if (choice.kind === "new") return t("admin.concepts.newNamed", { label: choice.fr.label });
  return p.concept ? conceptName(p.concept, locale) : t("admin.concepts.unknownConcept");
}

/**
 * The accepted decision of a row, as it reads, and whether it keeps the tag
 * (a concept) or drops it; null while it is undecided. A `concept` decision
 * whose concept did not come back is still a decision: it says so.
 */
export function storedDecision(t: TFunction, locale: Locale, row: TagSortingRow): { text: string; drop: boolean } | null {
  const s = row.sorting;
  if (s?.decision === "drop") {
    return { text: t("admin.concepts.dropNamed", { reason: s.dropReason ? t(`admin.concepts.reason.${s.dropReason}`) : "—" }), drop: true };
  }
  if (s?.decision === "concept") {
    return { text: s.concept ? conceptName(s.concept, locale) : t("admin.concepts.unknownConcept"), drop: false };
  }
  return null;
}

/** An accept refused with something the screen can act on, read through the contracts. */
type Refusal = { kind: "conflict"; conflicts: Conflict[] } | { kind: "items"; code: ItemsErrorCode; items: TagPair[] };

function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof ApiError)) return null;
  const conflict = TagSortingConflict.safeParse(error.body);
  if (conflict.success) return { kind: "conflict", conflicts: conflict.data.conflicts };
  const items = TagSortingItemsError.safeParse(error.body);
  if (items.success) return { kind: "items", code: items.data.error, items: items.data.items };
  return null;
}

export function useTagSorting(rows: readonly TagSortingRow[]) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();

  const [filter, setFilter] = useState<Filter>("undecided");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(new Map());
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [failure, setFailure] = useState<{ code: ItemsErrorCode; keys: ReadonlySet<string> } | null>(null);

  /** The seam every read of a pair's pending decision goes through. */
  const decisionOf = (row: TagPair): Pending | null => pending.get(keyOf(row)) ?? null;

  const query = search.trim();
  const visible = rows.filter(
    (r) =>
      (filter === "all" || (filter === "accepted") === (r.sorting?.decision != null)) &&
      (query === "" || fuzzyScore(query, r.tag) !== null || fuzzyScore(query, r.poolName) !== null),
  );
  // What the bar acts on: the ticked pairs still on screen.
  const chosen = visible.filter((r) => selected.has(keyOf(r)));
  const ready = chosen.filter((r) => decisionOf(r) !== null);

  /** The notices speak of a selection: they go with it. */
  const clearNotices = () => {
    setConflicts([]);
    setFailure(null);
  };
  /** The notices about these pairs are answered by a new decision on them. */
  const forget = (keys: ReadonlySet<string>) => {
    setConflicts((cs) => cs.filter((c) => !c.items.some((i) => keys.has(keyOf(i)))));
    setFailure((f) => {
      if (!f) return f;
      const left = new Set([...f.keys].filter((k) => !keys.has(k)));
      return left.size > 0 ? { ...f, keys: left } : null;
    });
  };

  const select = (keys: readonly string[], on: boolean) => {
    const next = new Set(selected);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    setSelected(next);
    if (next.size === 0) clearNotices();
  };
  const clearSelection = () => {
    setSelected(new Set());
    clearNotices();
  };

  const decide = (pairs: readonly TagPair[], value: Omit<Pending, "source">) => {
    const keys = new Set(pairs.map(keyOf));
    setPending((p) => new Map([...p, ...[...keys].map((k) => [k, { ...value, source: "admin" }] as const)]));
    forget(keys);
  };
  const clearPending = (row: TagPair) => {
    const key = keyOf(row);
    setPending((p) => new Map([...p].filter(([k]) => k !== key)));
    forget(new Set([key]));
  };
  /** One click: the items that asked for a taken label map to the concept holding it. */
  const remap = (conflict: Conflict) =>
    decide(conflict.items, { choice: { kind: "concept", conceptId: conflict.concept.id }, concept: conflict.concept });

  const accept = useMutation({
    mutationFn: (items: TagSortingItem[]) =>
      api<TagSortingAcceptResponse>("/app/api/admin/concept-sorting/accept", {
        method: "POST",
        body: JSON.stringify({ items } satisfies TagSortingAccept),
      }),
    onMutate: clearNotices,
    onSuccess: (res) => {
      const done = new Map(res.rows.map((r) => [keyOf(r), r.sorting]));
      qc.setQueryData<TagSortingList>(adminConceptSortingKey, (old) =>
        old && { rows: old.rows.map((r) => ({ ...r, sorting: done.get(keyOf(r)) ?? r.sorting })) },
      );
      if (res.created.length > 0) void qc.invalidateQueries({ queryKey: conceptsKey });
      setPending((p) => new Map([...p].filter(([k]) => !done.has(k))));
      setSelected((s) => new Set([...s].filter((k) => !done.has(k))));
      const n = res.rows.length;
      toast(t(n === 1 ? "admin.concepts.accepted.one" : "admin.concepts.accepted", { n }), "success");
    },
    onError: (err) => {
      const refusal = refusalOf(err);
      if (refusal?.kind === "conflict") setConflicts(refusal.conflicts);
      else if (refusal?.kind === "items") setFailure({ code: refusal.code, keys: new Set(refusal.items.map(keyOf)) });
      else toast(apiErrorMessage(err, t("error.save")), "error");
    },
  });

  const submit = () =>
    accept.mutate(ready.map((r) => ({ poolId: r.poolId, tag: r.tag, decision: decisionOf(r)!.choice })));

  return {
    filter,
    setFilter,
    search,
    setSearch,
    query,
    sorted: rows.filter((r) => r.sorting?.decision != null).length,
    visible,
    groups: groupRows(visible),
    selected,
    chosen,
    ready,
    select,
    clearSelection,
    decisionOf,
    decide,
    clearPending,
    remap,
    conflicts,
    failure,
    submit,
    accepting: accept.isPending,
  };
}
