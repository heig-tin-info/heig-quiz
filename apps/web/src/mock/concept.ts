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
  ConceptCreate,
  ConceptMerge,
  ConceptPatch,
  type AdminConcept,
  type AdminConceptList,
  type Concept,
  type ConceptExists,
  type ConceptRef,
  type TagDropReason,
} from "@quiz/contracts";
import { conceptKey, qualifiedConceptKey, splitQualifiedLabel } from "@quiz/domain";

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
];

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
        deletable: (usage.get(c.id) ?? 0) === 0,
        creator: c.status === "proposed" ? (i % 2 === 0 ? "Marie Dupont" : "Jean Martin") : null,
      }),
    ),
  };
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
  const moved = usage.get(loser.id) ?? 0;
  usage.set(winner.id, (usage.get(winner.id) ?? 0) + moved);
  usage.delete(loser.id);
  for (const c of concepts) if (c.mergedInto === loser.id) c.mergedInto = winner.id;
  loser.status = "merged";
  loser.mergedInto = winner.id;
  return winner;
});

on("DELETE", "/app/api/admin/concepts/:id", (m) => {
  const i = concepts.findIndex((x) => x.id === m.groups!.id);
  if (i < 0) throw refuse(404, "not_found", "No such concept");
  if ((usage.get(concepts[i]!.id) ?? 0) > 0) throw refuse(409, "concept_in_use", "A question refers to this concept");
  concepts.splice(i, 1);
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
