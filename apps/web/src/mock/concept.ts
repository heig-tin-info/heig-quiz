/**
 * 12. The vocabulary of concepts (ADR-081): `GET`/`POST /app/api/concepts`
 * for the question editor's picker and the pool filters.
 *
 * The question editor's concept picker (third addendum §5) creates a
 * `proposed` concept: `409 concept_exists` with the holder when its key is
 * taken, `422 concept_dropped` when, unqualified, it is the key of a tag the
 * admin dropped (`c01`, dropped as a chapter label, is one from the start).
 */
import { ConceptCreate, type Concept, type ConceptExists, type ConceptRef } from "@quiz/contracts";
import { conceptKey, qualifiedConceptKey, splitQualifiedLabel } from "@quiz/domain";

import { D, iso, MockPayload, on, refuse } from "./runtime";

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
];

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
    if (known) return known.id;
    const created = concept("validated", [label, qualifier], [SEED_EN[label] ?? label, qualifier]);
    concepts.push(created);
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
const DROPPED: { tag: string; reason: "organisational" | "task_kind" | "noise" }[] = [
  { tag: "c01", reason: "organisational" },
];

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
