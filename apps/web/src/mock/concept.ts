/**
 * 12. The vocabulary of concepts and the sorting of the existing tags
 * (ADR-081, second addendum): the admin's "Concepts" tab. Three pools whose
 * tags spell the same notions differently (`pointeurs` / `pointeur`,
 * `chaînes` / `chaines`), a chapter label (`c01`), a kind of task
 * (`lecture-de-code`) and a homonym across languages (`static` /
 * `static-cpp`). One pair is already accepted.
 *
 * The model's last pass (yesterday) proposed a concept for the pointer tags
 * and for `héritage`, a new concept for `récursivité`, a drop for the kind of
 * task and the chapter label. "Propose with AI" starts a run that advances
 * one group per poll, then also proposes the strings and the noise.
 *
 * Accepting a NEW concept whose label is already taken (`Pointeur`, say)
 * answers `409 concept_exists`, as the server does.
 *
 * The question editor's concept picker (third addendum §5) creates a
 * `proposed` concept: `409 concept_exists` with the holder when its key is
 * taken, `422 concept_dropped` when, unqualified, it is the key of a tag the
 * admin dropped (`c01`, dropped as a chapter label, is one from the start).
 *
 * `?empty=1`: no question wears a tag.
 */
import {
  ConceptCreate,
  type Concept,
  type ConceptExists,
  type ConceptRef,
  type ConceptSortRun,
  type TagPair,
  type TagSorting,
  type TagSortingAcceptResponse,
  type TagSortingChoice,
  type TagSortingItem,
  type TagSortingRow,
} from "@quiz/contracts";
import {
  conceptKey,
  groupNewConcepts,
  groupTagsByConceptKey,
  qualifiedConceptKey,
  splitQualifiedLabel,
  tagGroupKey,
} from "@quiz/domain";

import { D, flags, H, iso, MockPayload, on, refuse } from "./runtime";

const INFO1 = { poolId: "c0a1b2c3-0000-4000-8000-0000000000a1", poolName: "Info1" };
const PROGC = { poolId: "c0a1b2c3-0000-4000-8000-0000000000c1", poolName: "Prog C — C10" };
const POO = { poolId: "c0a1b2c3-0000-4000-8000-0000000000f1", poolName: "POO" };
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";

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

// Two pairs already decided: the array tag mapped, the chapter label dropped.
const decided = (choice: TagSortingChoice, conceptOf: Concept | null): TagSorting => ({
  decision: choice.kind === "drop" ? "drop" : "concept",
  concept: conceptOf,
  dropReason: choice.kind === "drop" ? choice.reason : null,
  proposal: null,
  decidedBy: ADMIN,
  decidedAt: iso(-2 * 3_600_000),
});
for (const p of pairs) {
  if (p.tag === "tableaux") p.sorting = decided({ kind: "concept", conceptId: concepts[1]!.id }, concepts[1]!);
  if (p.tag === "c01") p.sorting = decided({ kind: "drop", reason: "organisational" }, null);
}

// The model's proposals: what a pass of `sort` left on the undecided pairs.
const MODEL = "claude-haiku-4-5";
type Proposal = NonNullable<TagSorting["proposal"]>;
const toConcept = (c: Concept, note: string): Proposal => ({ kind: "concept", conceptId: c.id, model: MODEL, note });
const toNew = (fr: string, en: string, description: string, note: string): Proposal => ({
  kind: "new",
  newConcept: { fr: { label: fr, qualifier: "", description }, en: { label: en, qualifier: "", description: "" } },
  model: MODEL,
  note,
});
const toDrop = (dropReason: "organisational" | "task_kind" | "noise", note: string): Proposal => ({
  kind: "drop",
  dropReason,
  model: MODEL,
  note,
});
/** Proposals by tag: the first pass's, and what a run started here adds. */
const FIRST_PASS: Record<string, Proposal> = {
  pointeurs: toConcept(concepts[0]!, "Plural of an existing concept."),
  pointeur: toConcept(concepts[0]!, "Same notion as the validated concept."),
  héritage: toConcept(concepts[5]!, "Matches a proposed concept."),
  récursivité: toNew("Récursivité", "Recursion", "Fonction qui s'appelle elle-même.", "No concept covers it yet."),
  "lecture-de-code": toDrop("task_kind", "What the student does, not a notion."),
  c01: toDrop("organisational", "A chapter number."),
};
const strings = toNew("Chaîne de caractères", "String", "Suite de caractères terminée par \\0.", "Two spellings of one notion.");
const NEXT_PASS: Record<string, Proposal> = {
  chaînes: strings,
  chaines: strings,
  test: toDrop("noise", "A leftover test."),
  todo: toDrop("noise", "A reminder, not a notion."),
};
/** Proposes on every pair with no accepted decision, as a run does. */
function proposeFrom(pass: Record<string, Proposal>) {
  for (const p of pairs) {
    const proposal = pass[p.tag];
    if (!proposal || p.sorting?.decision != null) continue;
    p.sorting = { decision: null, concept: null, dropReason: null, proposal, decidedBy: null, decidedAt: null };
  }
}
proposeFrom(FIRST_PASS);

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

/** The teacher's new concept: `proposed`, in their language only. */
on("POST", "/app/api/concepts", (_m, raw): Concept => {
  const body = ConceptCreate.safeParse(raw);
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  const { lang, label, qualifier = "", description = "" } = body.data;
  // A qualifier tells a concept apart from a dropped tag (third addendum §4, amended).
  const drop = qualifier.trim() === ""
    ? pairs.find((p) => p.sorting?.decision === "drop" && conceptKey(p.tag) === conceptKey(label))
    : undefined;
  if (drop) {
    // `ConceptWriteRefusal`, as the server answers a label on the stop list.
    throw refuse(422, "concept_dropped", "This label was dropped from the vocabulary", {
      errors: [{ input: label, error: "concept_dropped", reason: drop.sorting!.dropReason }],
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

// The model pass (second addendum §3). Yesterday's run is done; a run
// started here advances one group per poll of its status, then proposes.
let run: ConceptSortRun | null = flags.empty
  ? null
  : { state: "done", groupsDone: 6, groupsTotal: 6, batchesFailed: 0, startedAt: iso(-D - H), finishedAt: iso(-D), error: null };

on("POST", "/app/api/admin/concept-sorting/propose", () => {
  if (flags.nollm) throw refuse(409, "llm_not_configured", "No model is configured", { reason: "not_configured" });
  if (run?.state === "running") throw refuse(409, "concept_sort_running", "A proposal run is already running");
  const open = new Set(pairs.filter((p) => p.sorting?.decision == null).map((p) => tagGroupKey(p.tag)));
  run = { state: "running", groupsDone: 0, groupsTotal: open.size, batchesFailed: 0, startedAt: iso(0), finishedAt: null, error: null };
  return { run };
});

on("GET", "/app/api/admin/concept-sorting/run", () => {
  if (run?.state === "running") {
    const groupsDone = Math.min(run.groupsDone + 1, run.groupsTotal);
    run = groupsDone < run.groupsTotal ? { ...run, groupsDone } : { ...run, groupsDone, state: "done", finishedAt: iso(0) };
    if (run.state === "done") proposeFrom(NEXT_PASS);
  }
  return { run };
});

function bare({ poolId, tag }: TagPair): TagPair {
  return { poolId, tag };
}
