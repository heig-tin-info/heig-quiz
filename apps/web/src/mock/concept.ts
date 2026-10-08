/**
 * 12. The vocabulary of concepts and the sorting of the existing tags
 * (ADR-081, second addendum): the admin's "Concepts" tab. Three pools whose
 * tags spell the same notions differently (`pointeurs` / `pointeur`,
 * `chaînes` / `chaines`), a chapter label (`c01`), a kind of task
 * (`lecture-de-code`) and a homonym across languages (`static` /
 * `static-cpp`). Two pairs are already accepted.
 *
 * Accepting a NEW concept whose label is already taken (`Pointeur`, say)
 * answers `409 concept_exists`, as the server does.
 *
 * `?empty=1`: no question wears a tag.
 */
import type {
  Concept,
  TagPair,
  TagSorting,
  TagSortingAcceptResponse,
  TagSortingChoice,
  TagSortingItem,
  TagSortingRow,
} from "@quiz/contracts";
import { groupNewConcepts, groupTagsByConceptKey, qualifiedConceptKey, tagGroupKey } from "@quiz/domain";

import { D, flags, iso, MockPayload, on } from "./runtime";

const INFO1 = { poolId: "c0a1b2c3-0000-4000-8000-0000000000a1", poolName: "Info1" };
const PROGC = { poolId: "c0a1b2c3-0000-4000-8000-0000000000c1", poolName: "Prog C — C10" };
const POO = { poolId: "c0a1b2c3-0000-4000-8000-0000000000f1", poolName: "POO" };
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";

let conceptSeq = 0;
const concept = (
  status: Concept["status"],
  fr: [string, string?, string?],
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

interface Pair {
  poolId: string;
  poolName: string;
  tag: string;
  count: number;
  description: string;
  excerpts: string[];
  sorting: TagSorting | null;
}

const pair = (
  pool: { poolId: string; poolName: string },
  tag: string,
  count: number,
  description = "",
  excerpts: string[] = [],
): Pair => ({ ...pool, tag, count, description, excerpts, sorting: null });

const pairs: Pair[] = flags.empty
  ? []
  : [
      pair(INFO1, "pointeurs", 18, "Adresses, déréférencement, pointeurs de pointeurs.", [
        "Soit int x = 5; int *p = &x; Que vaut *p après l'instruction *p += 2; ?",
        "Expliquez la différence entre int *p[3] et int (*p)[3].",
      ]),
      pair(PROGC, "pointeur", 9, "", [
        "Quelle est la taille d'un pointeur sur une machine 64 bits ?",
      ]),
      pair(POO, "pointeurs", 3, "Pointeurs bruts face aux pointeurs intelligents.", [
        "Pourquoi préférer std::unique_ptr à un pointeur brut pour posséder un objet ?",
      ]),
      pair(INFO1, "chaînes", 11, "Chaînes de caractères terminées par \\0.", [
        "Que retourne strlen(\"HEIG\\0VD\") ?",
        "Écrivez une fonction qui inverse une chaîne en place.",
      ]),
      pair(PROGC, "chaines", 6, "", ["Pourquoi char s[4] = \"HEIG\"; pose-t-il problème ?"]),
      pair(INFO1, "lecture-de-code", 12, "Questions où l'on lit un programme et prédit sa sortie.", [
        "Qu'affiche le programme suivant ? for (int i = 0; i < 3; i++) printf(\"%d\", i * i);",
      ]),
      pair(PROGC, "lecture-de-code", 8),
      pair(INFO1, "c01", 14, "Chapitre 1 — introduction au C.", [
        "Quel est le rôle de la fonction main ?",
      ]),
      pair(PROGC, "static", 5, "Mot-clé static : durée de vie et visibilité.", [
        "Que vaut le compteur après trois appels à une fonction qui déclare static int n = 0; n++; ?",
      ]),
      pair(POO, "static-cpp", 4, "Membres static d'une classe C++.", [
        "Un membre static d'une classe est-il partagé entre toutes ses instances ?",
      ]),
      pair(INFO1, "tableaux", 7, "Déclaration, parcours, passage en paramètre."),
      pair(PROGC, "tableau", 4),
      pair(POO, "héritage", 10, "", ["Quelle méthode est appelée par b->f() si f est virtuelle ?"]),
      pair(INFO1, "récursivité", 5),
      pair(PROGC, "test", 1),
      pair(POO, "todo", 2),
    ];

// Two pairs already decided: the chapter label dropped, the array tag mapped.
const decided = (choice: TagSortingChoice, conceptOf: Concept | null): TagSorting => ({
  decision: choice.kind === "drop" ? "drop" : "concept",
  concept: conceptOf,
  dropReason: choice.kind === "drop" ? choice.reason : null,
  proposal: null,
  decidedBy: ADMIN,
  decidedAt: iso(-2 * 3_600_000),
});
for (const p of pairs) {
  if (p.tag === "c01") p.sorting = decided({ kind: "drop", reason: "organisational" }, null);
  if (p.tag === "tableaux") p.sorting = decided({ kind: "concept", conceptId: concepts[1]!.id }, concepts[1]!);
}

const pairKey = (p: TagPair) => JSON.stringify([p.poolId, p.tag]);

on("GET", "/app/api/concepts", () => ({ concepts: concepts.filter((c) => c.status !== "merged") }));

on("GET", "/app/api/admin/concept-sorting", () => ({
  rows: groupTagsByConceptKey(pairs).flatMap((g) =>
    g.pairs.map(
      (p): TagSortingRow => ({
        poolId: p.poolId,
        tag: p.tag,
        poolName: p.poolName,
        count: p.count,
        description: p.description,
        excerpts: p.excerpts,
        group: tagGroupKey(p.tag),
        sorting: p.sorting,
      }),
    ),
  ),
}));

/** The key a concept holds in `lang`, or null when it has no label there. */
const keyOf = (c: Concept, lang: "fr" | "en") =>
  c.labels[lang] === null ? null : qualifiedConceptKey(c.labels[lang]!, c.qualifiers[lang]);

on("POST", "/app/api/admin/concept-sorting/accept", (_m, body): TagSortingAcceptResponse => {
  const items = (body.items ?? []) as TagSortingItem[];
  const byKey = new Map(pairs.map((p) => [pairKey(p), p]));
  const unknown = items.filter((i) => !byKey.has(pairKey(i)));
  if (unknown.length > 0) throw new MockPayload(422, { error: "tag_unknown", items: unknown.map(bare) });
  const conceptOf = (d: TagSortingChoice) => (d.kind === "concept" ? concepts.find((c) => c.id === d.conceptId) : undefined);
  const missing = items.filter((i) => i.decision.kind === "concept" && !conceptOf(i.decision));
  if (missing.length > 0) throw new MockPayload(422, { error: "concept_not_found", items: missing.map(bare) });

  const grouping = groupNewConcepts(
    items.flatMap((item) => (item.decision.kind === "new" ? [{ item, fr: item.decision.fr, en: item.decision.en }] : [])),
  );
  if (grouping.kind === "clash") {
    throw new MockPayload(422, { error: "concept_batch_conflict", items: grouping.items.map(bare) });
  }
  // A new concept whose key, in either language, a live concept already holds.
  const conflicts = concepts.flatMap((holder) => {
    const asked = grouping.concepts.filter(
      (g) => keyOf(holder, "fr") === g.sides.fr.key || keyOf(holder, "en") === g.sides.en.key,
    );
    return asked.length > 0 ? [{ concept: holder, items: asked.flatMap((g) => g.items.map(bare)) }] : [];
  });
  if (conflicts.length > 0) {
    throw new MockPayload(409, { error: "concept_exists", message: "A concept with this label already exists", conflicts });
  }

  const created = grouping.concepts.map((g) => {
    const c = concept(
      "validated",
      [g.sides.fr.label, g.sides.fr.qualifier, g.sides.fr.description],
      [g.sides.en.label, g.sides.en.qualifier, g.sides.en.description],
    );
    concepts.push(c);
    return { c, items: new Set(g.items.map(pairKey)) };
  });
  const rows = items.map((item) => {
    const target =
      item.decision.kind === "concept"
        ? conceptOf(item.decision)!
        : item.decision.kind === "new"
          ? created.find((n) => n.items.has(pairKey(item)))!.c
          : null;
    const sorting = decided(item.decision, target);
    byKey.get(pairKey(item))!.sorting = sorting;
    return { ...bare(item), sorting };
  });
  return { rows, created: created.map((n) => n.c) };
});

function bare({ poolId, tag }: TagPair): TagPair {
  return { poolId, tag };
}
