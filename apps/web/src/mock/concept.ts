/**
 * 12. The vocabulary of concepts (ADR-081): `GET`/`POST /app/api/concepts`
 * for the question editor's picker and the pool filters.
 *
 * The question editor's concept picker (third addendum §5) creates a
 * `proposed` concept: `409 concept_exists` with the holder when its key is
 * taken, `422 concept_dropped` when, unqualified, it is the key of a tag the
 * admin dropped (`c01`, dropped as a chapter label, is one from the start).
 */
import {
  ConceptAliasAdd,
  ConceptCreate,
  ConceptMerge,
  ConceptPatch,
  ConceptRelationAdd,
  ConceptRelationKind,
  type AdminConcept,
  type AdminConceptList,
  type ConceptDuplicatesAi,
  type Concept,
  type ConceptExists,
  type ConceptRef,
  type TagDropReason,
} from "@quiz/contracts";
import {
  canonicalRelated,
  narrowerDescendants,
  checkAlias,
  checkBroaderEdge,
  checkRelatedEdge,
  cleanConceptLabel,
  conceptKey,
  mergedAliases,
  edgesOf,
  mergedRelations,
  relationsOf,
  qualifiedConceptKey,
  splitQualifiedLabel,
  type RelationEdges,
} from "@quiz/domain";

import { resolvable } from "../concepts/ranking";
import { D, flags, H, iso, MockPayload, on, refuse, role } from "./runtime";

let conceptSeq = 0;
const concept = (
  status: Concept["status"],
  fr: [string | null, string?, string?],
  en: [string | null, string?, string?],
): Concept => ({
  id: `c0c0c0c0-0000-4000-8000-${String((conceptSeq += 1)).padStart(12, "0")}`,
  status,
  mergedInto: null,
  labels: { fr: fr[0], en: en[0] },
  qualifiers: { fr: fr[1] ?? "", en: en[1] ?? "" },
  descriptions: { fr: fr[2] ?? "", en: en[2] ?? "" },
  aliases: [],
  broader: [],
  related: [],
  createdBy: null,
  createdAt: iso(-3 * D),
});

const concepts: Concept[] = [
  concept("validated", ["Pointeur", "", "Variable qui contient une adresse mémoire."], ["Pointer", "", "A variable holding a memory address."]),
  concept("validated", ["Tableau", "", "Suite d'éléments du même type, contigus en mémoire."], ["Array", "", "Elements of one type, contiguous in memory."]),
  concept("validated", ["Adresse", "mémoire"], ["Address", "memory"]),
  concept("validated", ["Adresse", "réseau"], ["Address", "network"]),
  concept("proposed", ["Récursivité", "", "Fonction qui s'appelle elle-même."], [null]),
  concept("proposed", ["Héritage"], ["Inheritance"]),
  concept("validated", ["Allocation dynamique", "", "malloc, free et la durée de vie du tas."], ["Dynamic allocation"]),
  concept("proposed", ["Fuite mémoire", "", "Mémoire allouée que plus aucun pointeur ne désigne."], [null]),
  concept("proposed", [null], ["Hash table", "", "Keys mapped to buckets by a hash function."]),
  concept("proposed", ["Complément à deux"], ["Two's complement"]),
  concept("proposed", ["Complément à 2"], [null]),
  // One pair per probable-duplicate reason (with the two Adresse homonyms above and the alias "Tas" below).
  concept("proposed", ["Alocation dynamique"], ["Dynamic alocation"]),
  concept("proposed", ["Hash table", "", "Anglicisme saisi par un enseignant."], [null]),
  concept("proposed", ["Tas"], ["Heap"]),
];

concepts[0]!.aliases = ["Référence mémoire", "Pointer variable"];
concepts[6]!.aliases = ["Tas"];

/** Writes edges back onto the concepts, both sides of a related pair. */
function setEdges(edges: RelationEdges): void {
  const all = relationsOf(edges);
  for (const c of concepts) {
    c.broader = all.get(c.id)?.broader ?? [];
    c.related = all.get(c.id)?.related ?? [];
  }
}

// A small hierarchy for the curation screens (sixth addendum, 7c).
const named = (fr: string, qualifier = "") => concepts.find((c) => c.labels.fr === fr && c.qualifiers.fr === qualifier)!;
setEdges({
  broader: [
    { concept: named("Fuite mémoire").id, target: named("Allocation dynamique").id },
    { concept: named("Allocation dynamique").id, target: named("Pointeur").id },
    { concept: named("Tableau").id, target: named("Pointeur").id },
  ],
  related: [canonicalRelated(named("Pointeur").id, named("Adresse", "mémoire").id)],
});

/** The questions each concept's links hold, beyond those the mock's own questions name (`seedConceptIds`). */
const usage = new Map<string, number>();
const use = (c: Concept | undefined, n: number) => c && usage.set(c.id, (usage.get(c.id) ?? 0) + n);
for (const [label, n] of [["Héritage", 4], ["Complément à deux", 12], ["Fuite mémoire", 1]] as const) {
  use(concepts.find((c) => c.labels.fr === label), n);
}

/** The English of the mock's seeded labels, so an English reader reads English. */
const SEED_EN: Record<string, string> = {
  "Arithmétique des pointeurs": "Pointer arithmetic",
  Sécurité: "Security",
  Fichier: "File",
  Accéléromètre: "Accelerometer",
  Filtre: "Filter",
  Capteur: "Sensor",
  "Circuit RC": "RC circuit",
  Électronique: "Electronics",
  Résistance: "Resistor",
  "Conversion analogique-numérique": "Analog-to-digital conversion",
  Mesure: "Measurement",
  Amplificateur: "Amplifier",
  Boucle: "Loop",
  Pile: "Stack",
  "Diagramme de classes": "Class diagram",
  "Chaîne de caractères": "String",
  Structure: "Struct",
  "Opérations bit à bit": "Bitwise operations",
};

/**
 * The concepts of the mock's questions (`pool.ts`, `poll.ts`), by French
 * label — `Adresse (mémoire)` with its qualifier: the vocabulary's entry, or
 * a validated one created on first use, its English from `SEED_EN`.
 */
export function seedConceptIds(labels: readonly string[]): string[] {
  return labels.map((written) => {
    const { label, qualifier } = splitQualifiedLabel(written) ?? { label: written, qualifier: "" };
    const key = qualifiedConceptKey(label, qualifier);
    const known = concepts.find((c) => c.labels.fr !== null && qualifiedConceptKey(c.labels.fr, c.qualifiers.fr) === key);
    if (known) {
      use(known, 1);
      return known.id;
    }
    const created = concept("validated", [label, qualifier], [SEED_EN[label] ?? label, qualifier]);
    concepts.push(created);
    use(created, 1);
    return created.id;
  });
}

/**
 * Concept ids as a question shows them (`ConceptRef`): in the reader's
 * language (the page's, as the interface set it), falling back to the other;
 * a merged one as the concept it went into, an unknown one left out — as the
 * server reads its links.
 */
export function conceptRefs(ids: readonly string[]): ConceptRef[] {
  const reader = typeof document !== "undefined" && document.documentElement.lang === "fr" ? "fr" : "en";
  const out = new Map<string, ConceptRef>();
  for (const id of ids) {
    let c = concepts.find((x) => x.id === id);
    if (c?.mergedInto) c = concepts.find((x) => x.id === c!.mergedInto);
    if (!c) continue;
    const lang = c.labels[reader] !== null ? reader : reader === "fr" ? "en" : "fr";
    out.set(c.id, { id: c.id, label: c.labels[lang] ?? "", qualifier: c.qualifiers[lang], status: c.status });
  }
  return [...out.values()];
}

/** Whether every id names a live concept: what `PATCH /questions/:id` checks (`422 concept_not_found`). */
export const unknownConceptIds = (ids: readonly string[]): string[] =>
  ids.filter((id) => !concepts.some((c) => c.id === id && c.status !== "merged"));

/** The tags the admin dropped when sorting them: the stop list (third addendum §4). */
const DROPPED: { tag: string; reason: TagDropReason }[] = [
  { tag: "c01", reason: "organisational" },
];

/**
 * The admin's curation queue (ADR-081 fifth addendum): the vocabulary whole,
 * proposed first, with the number of questions using each (a number only).
 */
on("GET", "/app/api/admin/concepts", (): AdminConceptList => {
  const live = flags.empty ? [] : concepts.filter((c) => c.status !== "merged");
  const sorted = [...live].sort(
    (a, b) =>
      Number(b.status === "proposed") - Number(a.status === "proposed") ||
      (a.labels.fr ?? a.labels.en ?? "").localeCompare(b.labels.fr ?? b.labels.en ?? ""),
  );
  return {
    concepts: sorted.map(
      (c, i): AdminConcept => ({
        ...c,
        createdAt: iso(-(1 + (i % 9)) * D - H),
        createdBy: null,
        questionCount: usage.get(c.id) ?? 0,
        deletable: (usage.get(c.id) ?? 0) === 0 && !listedByACourse(c.id),
        creator: c.status === "proposed" ? (i % 2 === 0 ? "Marie Dupont" : "Jean Martin") : null,
      }),
    ),
  };
});

/**
 * The model's pass for probable duplicates (fifth addendum §4, PR4b): two
 * pairs a label comparison cannot find, from the live concepts; the `nollm`
 * scene refuses as a platform without a key does.
 */
on("POST", "/app/api/admin/concepts/duplicates/ai", (): ConceptDuplicatesAi => {
  if (flags.nollm) throw refuse(409, "llm_not_configured", "No AI key is configured", { reason: "not_configured" });
  const live = (fr: string, qualifier = "") => concepts.find((c) => c.status !== "merged" && c.labels.fr === fr && c.qualifiers.fr === qualifier);
  const french = document.documentElement.lang === "fr";
  const pairs = [
    [live("Complément à deux"), live("Complément à 2"), "close", french ? "La même notion, écrite avec un chiffre." : "The same notion, written with a digit."],
    [live("Pointeur"), live("Adresse", "mémoire"), "related", french ? "Un pointeur contient une adresse mémoire." : "A pointer holds a memory address."],
    [live("Fuite mémoire"), live("Allocation dynamique"), "related", french ? "Une fuite est un défaut d'allocation dynamique." : "A leak is a dynamic-allocation fault."],
  ] as const;
  return { pairs: pairs.flatMap(([a, b, kind, reason]) => (a && b ? [{ a: a.id, b: b.id, kind, reason }] : [])), truncated: false };
});

on("POST", "/app/api/admin/concepts/:id/validate", (m): Concept => {
  const c = concepts.find((x) => x.id === m.groups!.id);
  if (!c) throw refuse(404, "not_found", "No such concept");
  for (const lang of ["fr", "en"] as const) {
    if (c.labels[lang] === null) throw refuse(422, "concept_label_missing", "A validated concept has both labels", { lang });
  }
  c.status = "validated";
  return c;
});

/**
 * The merge (ADR-081 fifth addendum §2): into a validated concept only; the
 * usage moves, earlier merges are re-pointed, the merged one leaves the queue.
 */
on("POST", "/app/api/admin/concepts/:id/merge", (m, raw): Concept => {
  const body = ConceptMerge.safeParse(raw);
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  const loser = concepts.find((x) => x.id === m.groups!.id);
  const winner = concepts.find((x) => x.id === body.data.into);
  if (loser && loser === winner) throw refuse(422, "concept_merge_self", "A concept is not merged into itself");
  if (!loser || !winner) throw refuse(404, "not_found", "No such concept");
  if (loser.status === "merged" || winner.status === "merged") throw refuse(409, "concept_merged", "A merged concept is not merged again");
  if (winner.status !== "validated") throw refuse(422, "concept_merge_target_not_validated", "A concept is merged into a validated one only");
  const relations = mergedRelations(edgesOf(concepts), loser.id, winner.id);
  if (relations.cycle) {
    throw refuse(409, "concept_merge_cycle", "This merge would make a concept broader than itself", { path: relations.cycle.map((id) => conceptRefs([id])[0]) });
  }
  const moved = usage.get(loser.id) ?? 0;
  usage.set(winner.id, (usage.get(winner.id) ?? 0) + moved);
  usage.delete(loser.id);
  // The courses listing the loser list the winner instead, once (sixth addendum).
  for (const [course, ids] of courseConcepts) {
    courseConcepts.set(course, [...new Set(ids.map((id) => (id === loser.id ? winner.id : id)))]);
  }
  setEdges(relations.after);
  for (const c of concepts) if (c.mergedInto === loser.id) c.mergedInto = winner.id;
  const { moved: movedAliases, added } = mergedAliases(resolvable(loser), resolvable(winner), body.data.keepAsAlias);
  winner.aliases = [...winner.aliases, ...movedAliases, ...added].sort((a, b) => a.localeCompare(b));
  loser.aliases = [];
  loser.status = "merged";
  loser.mergedInto = winner.id;
  return winner;
});

const resolvables = () => concepts.map(resolvable);

/** A curated alias (ADR-081 §6): a collision with another concept's label or alias is a 409 until forced. */
on("POST", "/app/api/admin/concepts/:id/aliases", (m, raw): Concept => {
  const c = concepts.find((x) => x.id === m.groups!.id);
  if (!c) throw refuse(404, "not_found", "No such concept");
  if (c.status === "merged") throw refuse(409, "concept_merged", "A merged concept has no aliases");
  const body = ConceptAliasAdd.safeParse(raw);
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  const all = resolvables();
  const check = checkAlias(body.data.alias, all.find((x) => x.id === c.id)!, all);
  if (check.kind === "redundant") {
    throw check.of === "label"
      ? refuse(422, "alias_redundant", "An alias equal to the concept's own label is pointless")
      : refuse(409, "alias_exists", "The concept already has this alias");
  }
  if (check.kind === "collides" && !body.data.force) {
    throw refuse(409, "alias_collision", "This alias would make an input ambiguous", {
      collisions: check.with.map((hit) => ({ concept: conceptRefs([hit.id])[0]!, via: hit.via })),
    });
  }
  c.aliases = [...c.aliases, cleanConceptLabel(body.data.alias)].sort((a, b) => a.localeCompare(b));
  return c;
});

on("DELETE", "/app/api/admin/concepts/:id/aliases/:alias", (m): Concept => {
  const c = concepts.find((x) => x.id === m.groups!.id);
  if (!c) throw refuse(404, "not_found", "No such concept");
  const key = conceptKey(decodeURIComponent(m.groups!.alias!));
  if (!c.aliases.some((a) => conceptKey(a) === key)) throw refuse(404, "not_found", "No such alias");
  c.aliases = c.aliases.filter((a) => conceptKey(a) !== key);
  return c;
});

/** A relation (ADR-081 §4, sixth addendum 7c): the domain's rules, the server's refusals. */
on("POST", "/app/api/admin/concepts/:id/relations", (m, raw): Concept => {
  const c = concepts.find((x) => x.id === m.groups!.id);
  if (!c) throw refuse(404, "not_found", "No such concept");
  if (c.status === "merged") throw refuse(409, "concept_merged", "A merged concept has no relations");
  const body = ConceptRelationAdd.safeParse(raw);
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  const other = concepts.find((x) => x.id === body.data.target);
  if (!other || other.status === "merged") {
    throw refuse(422, "concept_not_found", "A concept is missing or merged", { ids: [body.data.target] });
  }
  const edges = edgesOf(concepts);
  const refusal =
    body.data.kind === "broader" ? checkBroaderEdge(edges, c.id, other.id) : checkRelatedEdge(edges, c.id, other.id);
  if (refusal?.kind === "self") throw refuse(422, "relation_self", "A concept is not related to itself");
  if (refusal?.kind === "exists") throw refuse(409, "relation_exists", "This relation exists already");
  if (refusal?.kind === "redundant") throw refuse(409, "relation_redundant", "These concepts are already connected");
  if (refusal?.kind === "cycle") {
    throw refuse(409, "concept_cycle", "This would make a concept broader than itself", { path: refusal.path.map((id) => conceptRefs([id])[0]) });
  }
  setEdges(
    body.data.kind === "broader"
      ? { ...edges, broader: [...edges.broader, { concept: c.id, target: other.id }] }
      : { ...edges, related: [...edges.related, canonicalRelated(c.id, other.id)] },
  );
  return c;
});

on("DELETE", "/app/api/admin/concepts/:id/relations/:kind/:target", (m): Concept => {
  const c = concepts.find((x) => x.id === m.groups!.id);
  const kind = ConceptRelationKind.safeParse(m.groups!.kind);
  if (!c || !kind.success) throw refuse(404, "not_found", "No such concept");
  const target = m.groups!.target!;
  const present = kind.data === "broader" ? c.broader.includes(target) : c.related.includes(target);
  if (!present) throw refuse(404, "not_found", "No such relation");
  const edges = edgesOf(concepts);
  if (kind.data === "broader") edges.broader = edges.broader.filter((e) => !(e.concept === c.id && e.target === target));
  else {
    const gone = canonicalRelated(c.id, target);
    edges.related = edges.related.filter((e) => !(e.concept === gone.concept && e.target === gone.target));
  }
  setEdges(edges);
  return c;
});

on("DELETE", "/app/api/admin/concepts/:id", (m) => {
  const i = concepts.findIndex((x) => x.id === m.groups!.id);
  if (i < 0) throw refuse(404, "not_found", "No such concept");
  if ((usage.get(concepts[i]!.id) ?? 0) > 0 || listedByACourse(concepts[i]!.id)) {
    throw refuse(409, "concept_in_use", "A merge, a question or a course refers to this concept");
  }
  const [gone] = concepts.splice(i, 1);
  const edges = edgesOf(concepts);
  const other = (e: { concept: string; target: string }) => e.concept !== gone!.id && e.target !== gone!.id;
  setEdges({ broader: edges.broader.filter(other), related: edges.related.filter(other) });
  return undefined;
});

/** The admin edits any concept; a teacher only their own proposed ones, which the mock does not model. */
on("PATCH", "/app/api/concepts/:id", (m, raw): Concept => {
  const c = concepts.find((x) => x.id === m.groups!.id);
  if (!c) throw refuse(404, "not_found", "No such concept");
  if (role !== "admin") throw refuse(403, "concept_forbidden", "Only the admin edits this concept");
  const body = ConceptPatch.safeParse(raw);
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  for (const lang of ["fr", "en"] as const) {
    const p = body.data[lang];
    if (!p) continue;
    const label = p.label ?? c.labels[lang];
    const qualifier = p.qualifier ?? c.qualifiers[lang];
    if (label !== null) {
      const holder = concepts.find((x) => x.id !== c.id && x.status !== "merged" && keyOf(x, lang) === qualifiedConceptKey(label, qualifier));
      if (holder) throw new MockPayload(409, { error: "concept_exists", message: "A concept with this label already exists", concept: holder });
    }
    c.labels[lang] = label;
    c.qualifiers[lang] = qualifier;
    c.descriptions[lang] = p.description ?? c.descriptions[lang];
  }
  return c;
});

on("GET", "/app/api/concepts", () => ({ concepts: concepts.filter((c) => c.status !== "merged") }));

/** The key a concept holds in `lang`, or null when it has no label there. */
const keyOf = (c: Concept, lang: "fr" | "en") =>
  c.labels[lang] === null ? null : qualifiedConceptKey(c.labels[lang]!, c.qualifiers[lang]);

/** The teacher's new concept: `proposed`, in their language only. */
on("POST", "/app/api/concepts", (_m, raw): Concept => {
  const body = ConceptCreate.safeParse(raw);
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  const { lang, label, qualifier = "", description = "" } = body.data;
  // A qualifier tells a concept apart from a dropped tag (third addendum §4, amended).
  const drop = qualifier.trim() === ""
    ? DROPPED.find((p) => conceptKey(p.tag) === conceptKey(label))
    : undefined;
  if (drop) {
    // `ConceptWriteRefusal`, as the server answers a label on the stop list.
    throw refuse(422, "concept_dropped", "This label was dropped from the vocabulary", {
      errors: [{ input: label, error: "concept_dropped", reason: drop.reason }],
    });
  }
  const holder = concepts.find((c) => c.status !== "merged" && keyOf(c, lang) === qualifiedConceptKey(label, qualifier));
  if (holder) {
    const exists: ConceptExists = { error: "concept_exists", message: "A concept with this label already exists", concept: holder };
    throw new MockPayload(409, exists);
  }
  const side: [string, string, string] = [label, qualifier, description];
  const created = concept("proposed", lang === "fr" ? side : [null], lang === "en" ? side : [null]);
  concepts.push(created);
  return created;
});

/**
 * The concepts each course declares (ADR-081 §8): a plain set per course id,
 * staff only. PRG1 (`c1`) lists three validated concepts and one proposed
 * (`?empty=1` lists none); the other courses start empty.
 */
const courseConcepts = new Map<string, string[]>([
  [
    "c1",
    flags.empty
      ? []
      : ["Pointeur", "Allocation dynamique", "Tableau", "Récursivité"].map((fr) => concepts.find((c) => c.labels.fr === fr)!.id),
  ],
]);

const listedByACourse = (id: string) => [...courseConcepts.values()].some((ids) => ids.includes(id));

/** A course's concepts as the staff reads them: by label, a merged one followed (as the server's merge rewrites the links). */
export const courseConceptRefs = (courseId: string): ConceptRef[] =>
  conceptRefs(courseConcepts.get(courseId) ?? []).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

/** The concepts the given ones cover together, themselves and every narrower one (the server's `coveredConcepts`, ADR-081 §4). */
export function coveredConceptIds(ids: readonly string[]): string[] {
  const { broader } = edgesOf(concepts);
  return [...new Set(ids.flatMap((id) => [id, ...narrowerDescendants(broader, id)]))];
}

/** The concept ids a course covers (the server's `conceptsCoveredByCourse`): the ones it lists and their narrower ones. */
export const coveredByCourse = (courseId: string): string[] => coveredConceptIds(courseConceptRefs(courseId).map((c) => c.id));

/** `PUT /courses/:id/concepts`: the whole set; a merged or unknown id is `422 concept_not_found`. */
export function setCourseConceptIds(courseId: string, ids: readonly string[]): void {
  const unknown = unknownConceptIds(ids);
  if (unknown.length > 0) throw refuse(422, "concept_not_found", "A concept is missing or merged", { ids: unknown });
  courseConcepts.set(courseId, [...new Set(ids)]);
}
