/**
 * The demo CONTENT of `pnpm seed`: pools, questions, evaluations and the
 * answers six students gave. Pure data — not a single service call — so the
 * "what" is reviewable on its own and `./demo.ts` owns the "how".
 *
 * The question text is French on purpose: it is what a HEIG-VD teacher reads
 * on the screen (invariant 1 — only UI strings are translated, and demo
 * content IS a UI string). Everything around it stays English.
 *
 * Every `internalName` and every evaluation `title` is a STABLE key: the seed
 * looks them up before it writes, so running it twice changes nothing.
 */

import type { QuestionTypeId } from "@quiz/contracts";

/** Every registered type: the seed's union can never fall behind the registry. */
type QuestionTypeName = QuestionTypeId;

export interface QuestionSpec {
  /** Unique inside its pool, and the key the seed is idempotent on. */
  internalName: string;
  type: QuestionTypeName;
  /** Name of the category (folder) this question lives in. */
  category: string;
  /** 1 (trivial) to 5 (hard), as `questions.difficulty` stores it. */
  difficulty: number;
  /**
   * What the question exercises (ADR-081): French labels of `CONCEPTS`, the
   * seed's vocabulary. No organisational label nor kind of task (§1).
   */
  concepts: string[];
  explanation: string;
  /** Validated by the type's own schema when the question is published. */
  config: unknown;
}

/** One concept of the demo vocabulary, validated: both labels, both descriptions. */
export interface ConceptSpec {
  fr: { label: string; description: string };
  en: { label: string; description: string };
}

/**
 * The demo vocabulary (ADR-081): the concepts the demo questions exercise,
 * keyed by their French label, which `QuestionSpec.concepts` names.
 */
export const CONCEPTS: ConceptSpec[] = [
  c("pointeurs", "Variables qui contiennent une adresse", "pointers", "Variables holding an address"),
  c("mémoire", "Organisation et durée de vie de la mémoire", "memory", "How memory is laid out and how long it lives"),
  c("tableaux", "Suites d'éléments contigus en mémoire", "arrays", "Sequences of elements contiguous in memory"),
  c("sizeof", "Taille en octets d'un type ou d'un objet", "sizeof", "Size in bytes of a type or an object"),
  c("opérateurs", "Opérateurs du langage et leur priorité", "operators", "The language's operators and their precedence"),
  c("opérateurs bit à bit", "Masques, décalages et opérations sur les bits", "bitwise operators", "Masks, shifts and operations on bits"),
  c("mots-clés", "Mots réservés du langage", "keywords", "Reserved words of the language"),
  c("chaînes de caractères", "Tableaux de caractères terminés par un zéro", "strings", "Zero-terminated character arrays"),
  c("boucles", "Répétition: for, while, do-while", "loops", "Repetition: for, while, do-while"),
  c("structures de contrôle", "Conditions et branchements", "control structures", "Conditions and branching"),
  c("bibliothèque standard", "Fonctions de la bibliothèque standard du C", "standard library", "Functions of the C standard library"),
  c("pile", "Pile d'appels: variables locales et retours", "stack", "Call stack: local variables and returns"),
  c("types", "Types de données et conversions", "types", "Data types and conversions"),
  c("fonctions", "Définition, appel et passage de paramètres", "functions", "Definition, call and parameter passing"),
  c("loi d'Ohm", "Relation entre tension, courant et résistance", "Ohm's law", "Relation between voltage, current and resistance"),
  c("régime continu", "Circuits en courant continu", "DC analysis", "Circuits under direct current"),
  c("résistances", "Associations série et parallèle", "resistors", "Series and parallel combinations"),
  c("diviseur de tension", "Tension aux bornes d'une résistance d'un pont", "voltage divider", "Voltage across one resistor of a divider"),
  c("filtre RC", "Filtre du premier ordre résistance-condensateur", "RC filter", "First-order resistor-capacitor filter"),
  c("régime alternatif", "Circuits en régime sinusoïdal", "AC analysis", "Circuits under sinusoidal steady state"),
  c("diode", "Comportement d'une diode à jonction", "diode", "Behaviour of a junction diode"),
  c("semi-conducteurs", "Composants à semi-conducteurs", "semiconductors", "Semiconductor devices"),
];

function c(fr: string, frDescription: string, en: string, enDescription: string): ConceptSpec {
  return { fr: { label: fr, description: frDescription }, en: { label: en, description: enDescription } };
}

export interface PoolSpec {
  name: string;
  /** A lucide icon name, as the pool card shows it (F-POOL-05). */
  icon: string;
  /** Course code the pool is attached to, or `null` for a stand-alone pool. */
  courseCode: string | null;
  categories: string[];
  questions: QuestionSpec[];
  /**
   * Personas this pool is shared with, by key (`apps/api/auth/dev.ts`), so the
   * demo world has a pool seen from BOTH sides: its owner and a colleague.
   */
  sharedWith?: { persona: string; role: "reader" | "contributor" | "owner" }[];
}

export interface EvaluationSpec {
  /** Unique inside the classroom, and the key the seed is idempotent on. */
  title: string;
  mode: "exam" | "exercise";
  preset: "exam" | "exercise";
  /** Where the evaluation is left once it is built. */
  target: "draft" | "scheduled" | "lobby" | "closed";
  /** `internalName`s, in the order the items must appear. */
  questions: string[];
  /** Those of `questions` whose item is a bonus (ADR-052). */
  bonus?: string[];
  durationS?: number;
  /** `scheduled` only: the opening is that many days from the seed run. */
  opensInDays?: number;
  /** `scheduled` only: minutes the window stays open. */
  windowMinutes?: number;
}

/**
 * One student's paper on the closed evaluation. A question absent from
 * `answers`, or mapped to `null`, was left untouched — which the grading pass
 * settles as a validated zero (F-GRADE-01).
 */
interface PaperSpec {
  /** Persona key from `auth/dev.ts`. */
  persona: string;
  /** False = closed by the teacher rather than handed in (an expired attempt). */
  submits: boolean;
  answers: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The reference answers, reused by the papers below
// ---------------------------------------------------------------------------

const SUM_SOLUTION = `
int somme(const int *t, int n) {
    int total = 0;
    for (int i = 0; i < n; i++) {
        total += t[i];
    }
    return total;
}
`;

const SUM_OFF_BY_ONE = `
int somme(const int *t, int n) {
    int total = 0;
    for (int i = 0; i <= n; i++) {
        total += t[i];
    }
    return total;
}
`;

const VOWELS_SOLUTION = `
int voyelles(const char *s) {
    int n = 0;
    for (const char *p = s; *p != '\\0'; p++) {
        char c = *p;
        if (c == 'a' || c == 'e' || c == 'i' || c == 'o' || c == 'u' || c == 'y') n++;
    }
    return n;
}
`;

const REVERSE_SOLUTION = `
void inverser(char *s) {
    int n = 0;
    while (s[n] != '\\0') n++;
    for (int i = 0; i < n / 2; i++) {
        char c = s[i];
        s[i] = s[n - 1 - i];
        s[n - 1 - i] = c;
    }
}
`;

const CHECKERBOARD_SOLUTION = `
int case_noire(int x, int y) {
    return (x + y) % 2 == 0;
}
`;

/**
 * The pixels of the checkerboard's target, in the compact encoding of a
 * `codeimage` config (one hex digit per `bw` pixel, row-major): what "Use as target"
 * stores after running the reference above. 1 is white, 0 black, and the
 * top-left cell is black.
 */
const CHECKERBOARD_TARGET = Array.from({ length: 16 * 16 }, (_, i) =>
  ((i % 16) + Math.floor(i / 16)) % 2 === 0 ? "0" : "1",
).join("");

/**
 * The RC low-pass of `elec-filtre-rc-passe-bas`: R1 from `in+` to `out+`, C1
 * from that node down to the `in-` / `out-` rail. Its geometry is on the
 * 20-unit grid of `packages/qt-circuit/src/library.ts`, so the netlist
 * extractor reads three nets and raises no issue. The papers below redraw it
 * with other values.
 */
function rcLowPass(r: string, c: string) {
  return {
    components: [
      { id: "c1", kind: "R", x: 300, y: 100, m: [1, 0, 0, 1], name: "R1", value: r },
      { id: "c2", kind: "C", x: 480, y: 180, m: [0, 1, -1, 0], name: "C1", value: c },
    ],
    wires: [
      {
        id: "w1",
        a: { kind: "port", port: "in+" },
        b: { kind: "pin", c: "c1", p: 0 },
        via: [],
        points: [[0, 100], [260, 100]],
      },
      {
        id: "w2",
        a: { kind: "pin", c: "c1", p: 1 },
        b: { kind: "port", port: "out+" },
        via: [],
        points: [[340, 100], [800, 100]],
      },
      {
        id: "w3",
        a: { kind: "pin", c: "c2", p: 0 },
        b: { kind: "free", x: 480, y: 100 },
        via: [],
        points: [[480, 160], [480, 100]],
      },
      {
        id: "w4",
        a: { kind: "pin", c: "c2", p: 1 },
        b: { kind: "port", port: "in-" },
        via: [],
        points: [[480, 200], [480, 400], [0, 400]],
      },
      {
        id: "w5",
        a: { kind: "free", x: 480, y: 400 },
        b: { kind: "port", port: "out-" },
        via: [],
        points: [[480, 400], [800, 400]],
      },
    ],
  };
}
const RC_LOW_PASS = rcLowPass("1.59k", "100n");

/** A checkerboard upside down: every cell the wrong colour. */
const CHECKERBOARD_INVERTED = `
int case_noire(int x, int y) {
    return (x + y) % 2 == 1;
}
`;

/** Stripes: only the column counts. */
const CHECKERBOARD_STRIPES = `
int case_noire(int x, int y) {
    return x % 2 == 0;
}
`;

/**
 * The essays of "Test 0", written to fall on every side of a grader's
 * rubric: complete, partial, a few words, and off the point. With
 * `LLM_PROVIDER=stub` the stub grader (`modules/llm/stub.ts`) proposes, in
 * that order, full marks with high confidence, half the points with medium
 * confidence, zero with low confidence, and zero with high confidence.
 */
/*
 * The flowchart of `somme` (docs/04 §4.14): its reference, the starter the
 * student opens (the two terminals only) and three answers. Every id is
 * opaque and written by hand, so a second seed run writes the same config;
 * the starter's ids are not the reference's (ADR-046 §2), and an answer
 * keeps the starter's ids for the two terminals it started from.
 */
const SUM_FLOW_REFERENCE = {
  nodes: [
    { id: "t6f2ka9w", t: "terminal", x: 340, y: 20, name: "Début" },
    { id: "a1m8zq4e", t: "action", x: 340, y: 100, name: "s ← 0 ; i ← 0" },
    { id: "d7c3nx5r", t: "decision", x: 340, y: 180, name: "i < n ?" },
    { id: "a9v2hb6j", t: "action", x: 340, y: 320, name: "s ← s + t[i]" },
    { id: "a4p7wd1s", t: "action", x: 340, y: 400, name: "i ← i + 1" },
    { id: "a8k5gy3o", t: "action", x: 560, y: 200, name: "Retourner s" },
    { id: "t0e9ru2l", t: "terminal", x: 560, y: 300, name: "Fin" },
  ],
  links: [
    { id: "f3x6mc8b", type: "flow", a: "t6f2ka9w", b: "a1m8zq4e" },
    { id: "f5n1qs7t", type: "flow", a: "a1m8zq4e", b: "d7c3nx5r" },
    { id: "f2j8vl4h", type: "flow", a: "d7c3nx5r", b: "a9v2hb6j", name: "oui" },
    { id: "f9w4ke6d", type: "flow", a: "a9v2hb6j", b: "a4p7wd1s" },
    { id: "f7r0ty3g", type: "flow", a: "a4p7wd1s", b: "d7c3nx5r", via: [{ x: 260, y: 420 }, { x: 260, y: 200 }] },
    { id: "f1b5oz9u", type: "flow", a: "d7c3nx5r", b: "a8k5gy3o", name: "non" },
    { id: "f6h3pa0c", type: "flow", a: "a8k5gy3o", b: "t0e9ru2l" },
  ],
};

const SUM_FLOW_START = { id: "s2d7fe4k", t: "terminal", x: 340, y: 20, name: "Début" };
const SUM_FLOW_END = { id: "s8q1lw6n", t: "terminal", x: 560, y: 300, name: "Fin" };
const SUM_FLOW_STARTER = { nodes: [SUM_FLOW_START, SUM_FLOW_END], links: [] };

/** The right flowchart, drawn from the starter. */
const SUM_FLOW_RIGHT = {
  nodes: [
    SUM_FLOW_START,
    { id: "k3r8bv2x", t: "action", x: 340, y: 100, name: "s ← 0 ; i ← 0" },
    { id: "k7n4cz9q", t: "decision", x: 340, y: 180, name: "i < n ?" },
    { id: "k1w6dy5m", t: "action", x: 340, y: 320, name: "s ← s + t[i]" },
    { id: "k9t2ex7p", t: "action", x: 340, y: 400, name: "i ← i + 1" },
    { id: "k5h0fu3j", t: "action", x: 560, y: 200, name: "Retourner s" },
    SUM_FLOW_END,
  ],
  links: [
    { id: "l2m9ga4r", type: "flow", a: "s2d7fe4k", b: "k3r8bv2x" },
    { id: "l8c3hb7w", type: "flow", a: "k3r8bv2x", b: "k7n4cz9q" },
    { id: "l5q1ic0z", type: "flow", a: "k7n4cz9q", b: "k1w6dy5m", name: "oui" },
    { id: "l0v6jd2s", type: "flow", a: "k1w6dy5m", b: "k9t2ex7p" },
    { id: "l7x4ke8n", type: "flow", a: "k9t2ex7p", b: "k7n4cz9q", via: [{ x: 260, y: 420 }, { x: 260, y: 200 }] },
    { id: "l3z8lf1y", type: "flow", a: "k7n4cz9q", b: "k5h0fu3j", name: "non" },
    { id: "l9a2mg6v", type: "flow", a: "k5h0fu3j", b: "s8q1lw6n" },
  ],
};

/** The loop forgets `i ← i + 1`, and the "non" branch is not labelled. */
const SUM_FLOW_NO_INCREMENT = {
  nodes: SUM_FLOW_RIGHT.nodes.filter((n) => n.id !== "k9t2ex7p"),
  links: [
    ...SUM_FLOW_RIGHT.links.filter((l) => !["l0v6jd2s", "l7x4ke8n", "l3z8lf1y"].includes(l.id)),
    { id: "l4b7nh3u", type: "flow", a: "k1w6dy5m", b: "k7n4cz9q", via: [{ x: 260, y: 340 }, { x: 260, y: 200 }] },
    { id: "l6d1oi5t", type: "flow", a: "k7n4cz9q", b: "k5h0fu3j" },
  ],
};

const ESSAYS = {
  complete:
    "Chaque appel de fonction empile un cadre sur la pile : l'adresse de retour et les " +
    "variables locales. La pile a une taille bornée (quelques Mo), donc une récursion " +
    "infinie finit par la dépasser. L'écriture suivante touche la page de garde, une page " +
    "non allouée : le processeur lève une faute de page et le noyau envoie `SIGSEGV`, ce " +
    "qui arrête le programme.",
  partial:
    "Chaque appel récursif empile des données sur la pile, dont la taille est limitée. " +
    "Au bout d'un moment elle déborde et le programme plante.",
  brief: "Stack overflow.",
  offTopic:
    "Le compilateur détecte la boucle infinie et refuse de générer l'exécutable, " +
    "d'où l'erreur au lancement.",
};

// ---------------------------------------------------------------------------
// Pool 1 — Programmation C (attached to PRG1)
// ---------------------------------------------------------------------------

const POINTERS = "Pointeurs et mémoire";
const STRINGS = "Chaînes de caractères";
const TYPES = "Types et opérateurs";

const C_POOL: PoolSpec = {
  name: "Programmation C",
  icon: "cpu",
  courseCode: "PRG1",
  categories: [POINTERS, STRINGS, TYPES],
  questions: [
    {
      internalName: "prg1-pointeur-non-initialise",
      type: "mcq",
      category: POINTERS,
      difficulty: 2,
      concepts: ["pointeurs", "mémoire"],
      explanation:
        "Seules les variables statiques et globales sont mises à zéro au démarrage. " +
        "Un pointeur automatique contient ce qui traînait sur la pile : le déréférencer " +
        "est un comportement indéfini, pas un plantage garanti.",
      config: {
        configVersion: 2,
        prompt: "Que vaut un pointeur non initialisé déclaré à l'intérieur d'une fonction ?",
        mode: "single",
        policy: "all_or_nothing",
        shuffleChoices: true,
        choices: [
          {
            text: "Une adresse indéterminée : le déréférencer est un comportement indéfini.",
            correct: true,
          },
          { text: "`NULL` : la norme C garantit l'initialisation à zéro.", correct: false },
          { text: "L'adresse du dernier bloc libéré par `free`.", correct: false },
          { text: "Toujours `0x0`, comme une variable globale.", correct: false },
        ],
      },
    },
    {
      internalName: "prg1-sizeof-parametre-tableau",
      type: "mcq",
      category: TYPES,
      difficulty: 3,
      concepts: ["tableaux", "sizeof", "pointeurs"],
      explanation:
        "Un paramètre de type tableau est ajusté en pointeur : `int t[10]` devient `int *t`. " +
        "`sizeof` mesure donc un pointeur, soit 8 octets sur une machine 64 bits.",
      config: {
        configVersion: 2,
        prompt:
          "```c\nvoid f(int t[10]) {\n    printf(\"%zu\\n\", sizeof t);\n}\n```\n\n" +
          "Qu'affiche cet appel sur une machine 64 bits ?",
        mode: "single",
        policy: "all_or_nothing",
        shuffleChoices: true,
        choices: [
          { text: "`8`", correct: true },
          { text: "`40`", correct: false },
          { text: "`10`", correct: false },
          { text: "`4`", correct: false },
        ],
      },
    },
    {
      internalName: "prg1-operateurs-bit-a-bit",
      type: "mcq",
      category: TYPES,
      difficulty: 4,
      concepts: ["opérateurs", "opérateurs bit à bit"],
      explanation:
        "`x` vaut `0b110`. `x >> 2` vaut 1, `x & 1` vaut 0 donc `!(x & 1)` vaut 1, " +
        "et `6 % 5` vaut 1. En revanche `x & 3` vaut 2 et `x ^ 6` vaut 0.",
      config: {
        configVersion: 2,
        prompt:
          "Soit `unsigned x = 6;`. Cochez **toutes** les expressions qui valent `1`.",
        mode: "multiple",
        policy: "true_false",
        shuffleChoices: true,
        choices: [
          { text: "`x >> 2`", correct: true },
          { text: "`x & 3`", correct: false },
          { text: "`!(x & 1)`", correct: true },
          { text: "`x % 5`", correct: true },
          { text: "`x ^ 6`", correct: false },
        ],
      },
    },
    {
      internalName: "prg1-mot-cle-constante",
      type: "short",
      category: TYPES,
      difficulty: 1,
      concepts: ["mots-clés"],
      explanation:
        "`const` qualifie le type : le compilateur refuse toute écriture à travers " +
        "ce nom. Il ne place pas forcément la valeur en mémoire morte.",
      config: {
        configVersion: 2,
        prompt:
          "Quel mot-clé du C déclare une variable dont la valeur ne doit pas être modifiée ?",
        kind: "text",
        placeholder: "un mot-clé",
        constraints: { maxLength: 20 },
        prefilters: { trim: true, lowercase: true },
        matchers: [{ kind: "exact", value: "const" }],
      },
    },
    {
      internalName: "prg1-octets-chaine-litterale",
      type: "short",
      category: STRINGS,
      difficulty: 2,
      concepts: ["chaînes de caractères", "mémoire"],
      explanation:
        "Quatre caractères plus le `\\0` terminal : une chaîne littérale de n caractères " +
        "occupe n + 1 octets.",
      config: {
        configVersion: 2,
        prompt:
          "Combien d'octets la chaîne littérale `\"HEIG\"` occupe-t-elle en mémoire ?",
        kind: "number",
        placeholder: "un nombre d'octets",
        constraints: { min: 1, integer: true },
        matchers: [{ kind: "number", value: 5, tolerance: 0 }],
      },
    },
    {
      internalName: "prg1-boucle-for",
      type: "cloze",
      category: TYPES,
      difficulty: 2,
      concepts: ["boucles", "structures de contrôle"],
      explanation:
        "La condition doit être stricte : avec `<=` la boucle afficherait aussi `10`.",
      config: {
        configVersion: 2,
        caseSensitive: false,
        text:
          "Complétez la boucle qui affiche les entiers de `0` à `9` :\n\n" +
          "```c\nfor (int i = {{0}}; i {{<}} 10; i{{++}}) {\n" +
          "    printf(\"%d\\n\", i);\n}\n```",
      },
    },
    {
      internalName: "prg1-fonctions-string-h",
      type: "cloze",
      category: STRINGS,
      difficulty: 2,
      concepts: ["chaînes de caractères", "bibliothèque standard"],
      explanation:
        "`strlen` ne compte pas le `\\0`, mais `\"HEIG-VD\"` occupe bien 8 octets : " +
        "sept caractères plus le terminateur.",
      config: {
        configVersion: 2,
        caseSensitive: false,
        text:
          "En C, la fonction {{strlen}} renvoie la longueur d'une chaîne, " +
          "{{strcpy}} la copie et {{strcmp}} compare deux chaînes. " +
          "Ces trois fonctions sont déclarées dans l'en-tête " +
          "{{string.h|<string.h>}}. La chaîne `\"HEIG-VD\"` occupe {{#8}} octets en mémoire.",
      },
    },
    {
      internalName: "prg1-code-somme-tableau",
      type: "code",
      category: POINTERS,
      difficulty: 3,
      concepts: ["pointeurs", "tableaux"],
      explanation:
        "Un simple parcours indexé suffit. Attention à la borne : `i < n`, jamais `i <= n`.",
      config: {
        configVersion: 1,
        language: "c",
        action: "run",
        prompt:
          "Complétez la fonction `somme` : elle reçoit un tableau de `n` entiers et " +
          "renvoie leur somme. Le `main` lit `n`, puis les `n` valeurs, sur l'entrée standard.",
        template:
          "// @@lock\n#include <stdio.h>\n\nint somme(const int *t, int n);\n\n" +
          "int main(void) {\n    int n;\n    if (scanf(\"%d\", &n) != 1) return 1;\n" +
          "    int t[128];\n    for (int i = 0; i < n; i++) {\n" +
          "        if (scanf(\"%d\", &t[i]) != 1) return 1;\n    }\n" +
          "    printf(\"%d\\n\", somme(t, n));\n    return 0;\n}\n// @@endlock\n" +
          "\nint somme(const int *t, int n) {\n    // votre code ici\n    return 0;\n}\n",
        referenceSolution: SUM_SOLUTION,
        limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
        tests: {
          mode: "io",
          cases: [
            { name: "trois valeurs", stdin: "3\n1 2 3\n", expected: "6\n", visible: true, points: 1 },
            { name: "une seule valeur", stdin: "1\n42\n", expected: "42\n", visible: true, points: 1 },
            { name: "valeurs négatives", stdin: "4\n-1 -2 3 4\n", expected: "4\n", visible: false, points: 1 },
            { name: "tableau vide", stdin: "0\n", expected: "0\n", visible: false, points: 2 },
          ],
        },
      },
    },
    {
      internalName: "prg1-code-compter-voyelles",
      type: "code",
      category: STRINGS,
      difficulty: 3,
      concepts: ["chaînes de caractères", "boucles"],
      explanation:
        "Le parcours s'arrête sur le `\\0`. Le `y` compte comme voyelle dans cet énoncé.",
      config: {
        configVersion: 1,
        language: "c",
        action: "run",
        prompt:
          "Complétez `voyelles` : elle renvoie le nombre de voyelles minuscules " +
          "(`a e i o u y`) de la chaîne reçue. Le `main` lit une ligne sur l'entrée standard.",
        template:
          "// @@lock\n#include <stdio.h>\n#include <string.h>\n\nint voyelles(const char *s);\n\n" +
          "int main(void) {\n    char ligne[256];\n" +
          "    if (fgets(ligne, sizeof ligne, stdin) == NULL) ligne[0] = '\\0';\n" +
          "    ligne[strcspn(ligne, \"\\n\")] = '\\0';\n" +
          "    printf(\"%d\\n\", voyelles(ligne));\n    return 0;\n}\n// @@endlock\n" +
          "\nint voyelles(const char *s) {\n    // votre code ici\n    return 0;\n}\n",
        referenceSolution: VOWELS_SOLUTION,
        limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
        tests: {
          mode: "io",
          cases: [
            { name: "mot simple", stdin: "bonjour\n", expected: "3\n", visible: true, points: 1 },
            { name: "aucune voyelle", stdin: "rythm\n", expected: "1\n", visible: true, points: 1 },
            { name: "chaîne vide", stdin: "\n", expected: "0\n", visible: false, points: 1 },
            { name: "phrase entière", stdin: "heig vd yverdon\n", expected: "6\n", visible: false, points: 2 },
          ],
        },
      },
    },
    {
      internalName: "prg1-code-inverser-chaine",
      type: "code",
      category: STRINGS,
      difficulty: 4,
      concepts: ["chaînes de caractères", "pointeurs"],
      explanation:
        "L'inversion se fait en place : on échange le caractère i avec le caractère " +
        "n - 1 - i jusqu'au milieu de la chaîne.",
      config: {
        configVersion: 1,
        language: "c",
        action: "run",
        prompt:
          "Complétez `inverser` : elle inverse **en place** la chaîne reçue. " +
          "Aucune allocation n'est autorisée.",
        template:
          "// @@lock\n#include <stdio.h>\n#include <string.h>\n\nvoid inverser(char *s);\n\n" +
          "int main(void) {\n    char ligne[256];\n" +
          "    if (fgets(ligne, sizeof ligne, stdin) == NULL) ligne[0] = '\\0';\n" +
          "    ligne[strcspn(ligne, \"\\n\")] = '\\0';\n" +
          "    inverser(ligne);\n    printf(\"%s\\n\", ligne);\n    return 0;\n}\n// @@endlock\n" +
          "\nvoid inverser(char *s) {\n    // votre code ici\n}\n",
        referenceSolution: REVERSE_SOLUTION,
        limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
        tests: {
          mode: "io",
          cases: [
            { name: "mot court", stdin: "heig\n", expected: "gieh\n", visible: true, points: 1 },
            { name: "palindrome", stdin: "radar\n", expected: "radar\n", visible: true, points: 1 },
            { name: "un seul caractère", stdin: "x\n", expected: "x\n", visible: false, points: 1 },
            { name: "chaîne vide", stdin: "\n", expected: "\n", visible: false, points: 2 },
          ],
        },
      },
    },
    {
      internalName: "prg1-image-damier",
      type: "codeimage",
      category: TYPES,
      difficulty: 2,
      concepts: ["boucles"],
      explanation:
        "Une case est noire quand la somme de ses coordonnées est paire : " +
        "`(x + y) % 2 == 0`. Le `main` écrit 1 pour une case blanche, 0 pour une noire.",
      config: {
        configVersion: 1,
        language: "c",
        prompt:
          "Complétez `case_noire` pour que le programme dessine un **damier** de 16 × 16 cases, " +
          "la case en haut à gauche étant noire. Le `main` écrit un entier par case, " +
          "ligne par ligne : 0 pour noir, 1 pour blanc.",
        template:
          "// @@lock\n#include <stdio.h>\n\nint case_noire(int x, int y);\n\n" +
          "int main(void) {\n    for (int y = 0; y < 16; y++) {\n" +
          "        for (int x = 0; x < 16; x++) {\n" +
          "            printf(\"%d \", case_noire(x, y) ? 0 : 1);\n        }\n" +
          "        printf(\"\\n\");\n    }\n    return 0;\n}\n// @@endlock\n" +
          "\nint case_noire(int x, int y) {\n    // votre code ici\n    return 0;\n}\n",
        referenceSolution: CHECKERBOARD_SOLUTION,
        image: { width: 16, height: 16, palette: "bw" },
        target: { width: 16, height: 16, palette: "bw", pixels: CHECKERBOARD_TARGET },
      },
    },
    {
      internalName: "prg1-redaction-pile",
      type: "rich",
      category: POINTERS,
      difficulty: 3,
      concepts: ["pile", "mémoire"],
      explanation:
        "La pile d'un thread a une taille fixe ; une récursion sans fin l'épuise, et " +
        "l'écriture suivante touche la page de garde, ce qui déclenche une erreur de segmentation.",
      // Graded by hand (issue #192), or proposed by the LLM service when the
      // process has one (`LLM_PROVIDER=stub` in development): the rubric and
      // the model answer are what the grader reads, never the student.
      config: {
        configVersion: 1,
        prompt:
          "Expliquez en quelques phrases pourquoi une **récursion infinie** fait planter un " +
          "programme C, et ce que le système d'exploitation y voit.",
        rubric:
          "- **2 pts** : la pile a une taille bornée et chaque appel y empile un cadre.\n" +
          "- **1 pt** : le dépassement touche une page non allouée (page de garde).\n" +
          "- **1 pt** : le noyau envoie `SIGSEGV`, le programme s'arrête.",
        reference:
          "Chaque appel empile un cadre (adresse de retour, variables locales). La pile " +
          "ayant une taille fixe, une récursion sans fin finit par écrire au-delà, dans une " +
          "page de garde non allouée : le processeur lève une faute de page que le noyau " +
          "transforme en `SIGSEGV`.",
        maxChars: 1500,
        format: "markdown",
      },
    },
    {
      internalName: "prg1-classement-types-c",
      type: "categorize",
      category: TYPES,
      difficulty: 2,
      concepts: ["types", "pointeurs"],
      explanation:
        "`int` et `size_t` sont des entiers ; `double` et `float` des " +
        "flottants ; `char *`, `void *` et `int (*)(void)` (un pointeur de fonction) des " +
        "pointeurs. `string` n'est pas un type C : il n'existe qu'en C++.",
      // ADR-036: the ids are opaque on purpose — the student's view carries
      // them, so they must say nothing about where a card goes. Written by
      // hand rather than minted, so a second seed run writes the same config.
      // Eight cards: up to eight, the grading table draws a column per card
      // (ADR-044 §2), which is what the guide shows.
      config: {
        configVersion: 1,
        prompt: "Classez chaque type C dans sa **catégorie**. Un type qui n'existe pas en C reste de côté.",
        columns: [
          { id: "q7m2xk4a", label: "Entier", cards: ["f3n8wz1c", "j2r5hd7s"] },
          { id: "c9t1vp6z", label: "Virgule flottante", cards: ["a4k7mq2x", "y8e3gn5w"] },
          { id: "h5w8re3n", label: "Pointeur", cards: ["p1x6jc0v", "d7s4lb8k", "m0g9fu3t"] },
        ],
        cards: [
          { id: "f3n8wz1c", text: "`int`" },
          { id: "j2r5hd7s", text: "`size_t`" },
          { id: "a4k7mq2x", text: "`double`" },
          { id: "y8e3gn5w", text: "`float`" },
          { id: "p1x6jc0v", text: "`char *`" },
          { id: "d7s4lb8k", text: "`void *`" },
          { id: "m0g9fu3t", text: "`int (*)(void)`" },
          { id: "e2z5oa7r", text: "`string`" },
        ],
        ordered: false,
        shuffleCards: true,
        shuffleColumns: false,
        policy: "inherit",
      },
    },
    {
      // A Parsons problem (docs/guide/recipes.md): `categorize` with "Order
      // matters", one column per block of code, and wrong lines as
      // distractors. Ids are hand-written and opaque, as above.
      internalName: "prg1-parsons-echanger",
      type: "categorize",
      category: POINTERS,
      difficulty: 2,
      concepts: ["pointeurs", "fonctions"],
      explanation:
        "`echanger` reçoit des adresses : l'appel passe `&x` et `&y`, et la fonction lit " +
        "et écrit les valeurs par `*a` et `*b`, avec une variable temporaire. `echanger(x, y)` " +
        "passerait des copies des valeurs, et `int tmp = a;` copierait une adresse dans un " +
        "entier. Le programme affiche `2 1`.",
      config: {
        configVersion: 1,
        prompt:
          "La fonction `void echanger(int *a, int *b)` échange les deux entiers dont elle " +
          "reçoit les adresses. Remettez dans l'ordre les lignes de son corps, puis celles du " +
          "corps de `main`, qui l'appelle et affiche `2 1`. Deux lignes sont fausses : " +
          "laissez-les de côté.",
        columns: [
          { id: "w4j9ta2e", label: "Corps de echanger", cards: ["r2x7ma4q", "g5c1wy9t", "n6e4pz2h"] },
          { id: "e7p3nq8v", label: "Corps de main", cards: ["s3h8ov1x", "y1d6lc7m", "o4t9re3j"] },
        ],
        cards: [
          { id: "r2x7ma4q", text: "`int tmp = *a;`" },
          { id: "g5c1wy9t", text: "`*a = *b;`" },
          { id: "n6e4pz2h", text: "`*b = tmp;`" },
          { id: "s3h8ov1x", text: "`int x = 1, y = 2;`" },
          { id: "y1d6lc7m", text: "`echanger(&x, &y);`" },
          { id: "o4t9re3j", text: "`printf(\"%d %d\\n\", x, y);`" },
          { id: "k7a5gm0w", text: "`echanger(x, y);`" },
          { id: "z0q8vi6d", text: "`int tmp = a;`" },
        ],
        ordered: true,
        shuffleCards: true,
        shuffleColumns: false,
        policy: "inherit",
      },
    },
    {
      internalName: "prg1-organigramme-somme",
      type: "diagram",
      category: TYPES,
      difficulty: 2,
      concepts: ["boucles"],
      explanation:
        "La boucle teste `i < n` AVANT d'ajouter `t[i]` : un tableau vide rend 0. " +
        "Sans `i ← i + 1`, la boucle ne se termine jamais.",
      // Graded by hand (ADR-046): the answers of "Test 0" arrive as proposals
      // of 0 points, except the untouched starter, which is a validated 0.
      config: {
        configVersion: 1,
        prompt:
          "Complétez l'**organigramme** de la fonction `somme`, qui additionne les `n` " +
          "éléments du tableau `t` et retourne leur somme.",
        kind: "flow",
        reference: SUM_FLOW_REFERENCE,
        starter: SUM_FLOW_STARTER,
        rubric:
          "- **1 pt** : initialisation de `s` et de `i`, test `i < n` avant le corps.\n" +
          "- **1 pt** : corps et incrément dans la boucle, retour de `s` sur la branche « non ».",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Pool 2 — Électronique (a second pool, shared with a colleague)
// ---------------------------------------------------------------------------

const DC = "Régime continu";
const SEMICONDUCTORS = "Semi-conducteurs";

const ELECTRONICS_POOL: PoolSpec = {
  name: "Électronique",
  icon: "circuit-board",
  // Attached to PRG1 too, so "Test 0" may hold its circuit (F-EVAL-01).
  courseCode: "PRG1",
  // Shared with the administrator persona, so the demo shows a pool from the
  // colleague's side too: `admin@heig-vd.ch` may edit it, not manage it.
  sharedWith: [{ persona: "admin", role: "contributor" }],
  categories: [DC, SEMICONDUCTORS],
  questions: [
    {
      internalName: "elec-loi-ohm",
      type: "mcq",
      category: DC,
      difficulty: 1,
      concepts: ["loi d'Ohm", "régime continu"],
      explanation: "U = R · I = 2200 Ω × 0,005 A = 11 V.",
      config: {
        configVersion: 2,
        prompt:
          "Une résistance de 2,2 kΩ est traversée par un courant de 5 mA. " +
          "Quelle tension mesure-t-on à ses bornes ?",
        mode: "single",
        policy: "all_or_nothing",
        shuffleChoices: true,
        choices: [
          { text: "11 V", correct: true },
          { text: "0,44 V", correct: false },
          { text: "110 V", correct: false },
          { text: "2,2 V", correct: false },
        ],
      },
    },
    {
      internalName: "elec-resistances-parallele",
      type: "short",
      category: DC,
      difficulty: 2,
      concepts: ["résistances", "régime continu"],
      explanation: "Deux résistances égales en parallèle valent la moitié de l'une d'elles.",
      config: {
        configVersion: 2,
        prompt:
          "Deux résistances de 1 kΩ sont montées en parallèle. " +
          "Quelle est la résistance équivalente, en ohms ?",
        kind: "number",
        placeholder: "en ohms",
        constraints: { min: 0 },
        matchers: [{ kind: "number", value: 500, tolerance: 1 }],
      },
    },
    {
      internalName: "elec-pont-diviseur",
      type: "mcq",
      category: DC,
      difficulty: 2,
      concepts: ["diviseur de tension", "régime continu"],
      explanation: "U_sortie = 12 V × 1k / (1k + 2k) = 4 V, à vide.",
      config: {
        configVersion: 2,
        prompt:
          "Un pont diviseur alimenté sous 12 V est formé de R1 = 2 kΩ (côté source) et " +
          "R2 = 1 kΩ (côté masse). Quelle tension lit-on aux bornes de R2, à vide ?",
        mode: "single",
        policy: "all_or_nothing",
        shuffleChoices: true,
        choices: [
          { text: "4 V", correct: true },
          { text: "8 V", correct: false },
          { text: "6 V", correct: false },
          { text: "12 V", correct: false },
        ],
      },
    },
    {
      internalName: "elec-filtre-rc-passe-bas",
      type: "circuit",
      category: DC,
      difficulty: 3,
      concepts: ["filtre RC", "régime alternatif"],
      explanation:
        "La fréquence de coupure vaut f = 1 / (2 π R C) ≈ 1 kHz pour R = 1,59 kΩ et " +
        "C = 100 nF. La résistance est en série, le condensateur en parallèle sur la sortie.",
      /*
       * Graded BY HAND (`mode: "manual"`), and that is the point of the demo:
       * the type works with no container engine anywhere (decision D14). The
       * reference is still there — it is what "Simulate the reference" runs
       * when a runner exists, and what a simulated grade would compare
       * against — and the single stimulus is visible, so a student who does
       * have a runner may press "Simulate".
       *
       * The reference is the RC low-pass itself (`RC_LOW_PASS`). With a
       * stimulus to run, even a manual grading asks the runner for the
       * curves (ADR-019): without one, the answers of "Test 0" arrive as
       * proposals with reason `runner_unavailable`.
       */
      config: {
        configVersion: 1,
        prompt:
          "Câblez un filtre **passe-bas** du premier ordre entre l'entrée et la sortie du " +
          "quadripôle, de fréquence de coupure 1 kHz. La sortie est prise aux bornes du " +
          "condensateur.",
        palette: { kinds: ["R", "C", "L", "GND"], maxComponents: 4 },
        supplies: { vcc: null, vee: null },
        commonGround: true,
        stimuli: [
          {
            name: "sinus 1 kHz",
            source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
            sourceOhms: 0,
            load: { kind: "resistor", ohms: 1_000_000 },
            analysis: { stopMs: 5, skipMs: 0, points: 500 },
            points: 2,
            visible: true,
          },
        ],
        reference: RC_LOW_PASS,
        grading: {
          mode: "manual",
          tolerance: 0.05,
          rubric:
            "Résistance en série et condensateur en parallèle sur la sortie ; " +
            "produit R·C cohérent avec 1 kHz à 10 % près ; masse commune câblée.",
        },
        showExpected: false,
        simulationsPerMinute: 10,
      },
    },
    {
      internalName: "elec-diode-silicium",
      type: "cloze",
      category: SEMICONDUCTORS,
      difficulty: 2,
      concepts: ["diode", "semi-conducteurs"],
      explanation:
        "La tension de seuil d'une jonction au silicium est de l'ordre de 0,7 V ; " +
        "elle vaut environ 0,3 V pour le germanium.",
      /*
       * The question that shows a dropdown inside a TABLE CELL. The `|` of the
       * hole is the very character a markdown row is split on, and it survives
       * for two independent reasons: `parseCloze` replaces the whole hole by a
       * sentinel before markdown runs (decision D5), and the rich editor takes
       * the pipe out of the row before the table lexer sees it
       * (apps/web/src/markdown/clozeHole.ts).
       */
      config: {
        configVersion: 2,
        caseSensitive: false,
        text:
          "Une diode au silicium conduit lorsqu'elle est polarisée en " +
          "{{direct|sens direct}} ; sa tension de seuil vaut alors environ {{#0.7:0.1}} V.\n\n" +
          "| Polarisation | État de la diode          |\n" +
          "| ------------ | ------------------------- |\n" +
          "| Directe      | {{=passante|bloquée}}     |\n" +
          "| Inverse      | {{passante|=bloquée}}     |",
      },
    },
  ],
};

export const POOLS: PoolSpec[] = [C_POOL, ELECTRONICS_POOL];

// ---------------------------------------------------------------------------
// Evaluations in classroom PRG1-2026
// ---------------------------------------------------------------------------

/** The one that is closed and graded; named here so `./demo.ts` can find it. */
export const CLOSED_TITLE = "Test 0 — bases du C";

export const EVALUATIONS: EvaluationSpec[] = [
  {
    title: "Test 1 — pointeurs",
    mode: "exam",
    preset: "exam",
    target: "draft",
    durationS: 2700,
    questions: [
      "prg1-pointeur-non-initialise",
      "prg1-sizeof-parametre-tableau",
      "prg1-code-somme-tableau",
      "prg1-boucle-for",
      "prg1-mot-cle-constante",
    ],
  },
  {
    title: "Test 2 — chaînes",
    mode: "exam",
    preset: "exam",
    target: "scheduled",
    opensInDays: 2,
    windowMinutes: 90,
    questions: [
      "prg1-octets-chaine-litterale",
      "prg1-fonctions-string-h",
      "prg1-code-compter-voyelles",
      "prg1-code-inverser-chaine",
    ],
  },
  {
    title: "Quiz d'entraînement",
    mode: "exercise",
    preset: "exercise",
    target: "lobby",
    questions: [
      "prg1-pointeur-non-initialise",
      "prg1-operateurs-bit-a-bit",
      "prg1-boucle-for",
    ],
  },
  {
    title: CLOSED_TITLE,
    mode: "exam",
    preset: "exam",
    target: "closed",
    durationS: 2700,
    // The ORDER matters beyond the seed: `apps/web/scripts/docs-screenshots.mjs`
    // reaches each grading scene by moving N questions forward.
    questions: [
      "prg1-pointeur-non-initialise",
      "prg1-mot-cle-constante",
      "prg1-octets-chaine-litterale",
      "prg1-boucle-for",
      "prg1-code-somme-tableau",
      "prg1-classement-types-c",
      "prg1-image-damier",
      "elec-filtre-rc-passe-bas",
      "prg1-redaction-pile",
      "prg1-organigramme-somme",
    ],
    // The circuit is electronics in a C test: the natural bonus question.
    bonus: ["elec-filtre-rc-passe-bas"],
  },
];

/**
 * The six papers of `Test 0`. Gabriel is absent — no attempt row at all —
 * so the results screen shows what an absence looks like, and Chloé never
 * hands in, so closing the evaluation expires one attempt.
 *
 * The `mcq` payload carries CANONICAL choice indices (decision D3), so
 * index 0 is the correct choice of `prg1-pointeur-non-initialise` whatever
 * order the student saw.
 */
export const PAPERS: PaperSpec[] = [
  {
    persona: "lea",
    submits: true,
    answers: {
      "prg1-pointeur-non-initialise": { selected: [0] },
      "prg1-mot-cle-constante": { text: "const" },
      "prg1-octets-chaine-litterale": { text: "5" },
      "prg1-boucle-for": { blanks: ["0", "<", "++"] },
      "prg1-code-somme-tableau": { regions: [SUM_SOLUTION] },
      "prg1-classement-types-c": {
        columns: {
          q7m2xk4a: ["f3n8wz1c", "j2r5hd7s"],
          c9t1vp6z: ["a4k7mq2x", "y8e3gn5w"],
          h5w8re3n: ["p1x6jc0v", "d7s4lb8k", "m0g9fu3t"],
        },
      },
      "prg1-image-damier": { regions: [CHECKERBOARD_SOLUTION] },
      "elec-filtre-rc-passe-bas": { schematic: RC_LOW_PASS },
      "prg1-redaction-pile": { text: ESSAYS.complete },
      "prg1-organigramme-somme": { scene: SUM_FLOW_RIGHT },
    },
  },
  {
    persona: "noah",
    submits: true,
    answers: {
      "prg1-pointeur-non-initialise": { selected: [1] },
      "prg1-mot-cle-constante": { text: "const" },
      "prg1-octets-chaine-litterale": { text: "4" },
      "prg1-boucle-for": { blanks: ["0", "<", "i++"] },
      "prg1-code-somme-tableau": { regions: [SUM_OFF_BY_ONE] },
      "prg1-classement-types-c": {
        columns: {
          q7m2xk4a: ["f3n8wz1c"],
          c9t1vp6z: ["a4k7mq2x", "y8e3gn5w", "j2r5hd7s"],
          h5w8re3n: ["p1x6jc0v", "d7s4lb8k", "e2z5oa7r"],
        },
      },
      "prg1-image-damier": { regions: [CHECKERBOARD_INVERTED] },
      // The right drawing, a capacitor ten times too small: 10 kHz.
      "elec-filtre-rc-passe-bas": { schematic: rcLowPass("1.59k", "10n") },
      "prg1-redaction-pile": { text: ESSAYS.partial },
      "prg1-organigramme-somme": { scene: SUM_FLOW_NO_INCREMENT },
    },
  },
  {
    persona: "emma",
    submits: true,
    answers: {
      "prg1-pointeur-non-initialise": { selected: [0] },
      "prg1-mot-cle-constante": { text: "constant" },
      "prg1-octets-chaine-litterale": { text: "5" },
      "prg1-boucle-for": { blanks: ["0", "<", "++"] },
      // The code question was never opened.
      "prg1-classement-types-c": {
        columns: {
          q7m2xk4a: ["f3n8wz1c", "j2r5hd7s", "m0g9fu3t"],
          c9t1vp6z: ["a4k7mq2x", "y8e3gn5w"],
          h5w8re3n: ["p1x6jc0v"],
        },
      },
      "prg1-image-damier": { regions: [CHECKERBOARD_STRIPES] },
      // The resistor alone: no capacitor, no filter.
      "elec-filtre-rc-passe-bas": {
        schematic: { components: RC_LOW_PASS.components.slice(0, 1), wires: RC_LOW_PASS.wires.slice(0, 2) },
      },
      "prg1-redaction-pile": { text: ESSAYS.brief },
      // Opened, touched and put back: the starter as it was, a validated 0.
      "prg1-organigramme-somme": { scene: SUM_FLOW_STARTER },
    },
  },
  {
    persona: "louis",
    submits: true,
    answers: {
      "prg1-pointeur-non-initialise": { selected: [0] },
      // `prg1-mot-cle-constante` left blank.
      "prg1-octets-chaine-litterale": { text: "5" },
      "prg1-boucle-for": { blanks: ["0", "<=", "++"] },
      "prg1-code-somme-tableau": { regions: [SUM_SOLUTION] },
      "prg1-classement-types-c": {
        columns: {
          q7m2xk4a: ["f3n8wz1c", "j2r5hd7s"],
          c9t1vp6z: ["a4k7mq2x", "y8e3gn5w"],
          h5w8re3n: ["p1x6jc0v", "d7s4lb8k", "m0g9fu3t", "e2z5oa7r"],
        },
      },
      // The image question was never opened.
      // A resistor ten times too large: 100 Hz.
      "elec-filtre-rc-passe-bas": { schematic: rcLowPass("15.9k", "100n") },
      "prg1-redaction-pile": { text: ESSAYS.offTopic },
    },
  },
  {
    persona: "chloe",
    submits: false,
    answers: {
      "prg1-pointeur-non-initialise": { selected: [2] },
      "prg1-mot-cle-constante": { text: "CONST" },
      "prg1-octets-chaine-litterale": { text: "5" },
      // Cloze left blank, code and picture left as the skeleton.
      "prg1-code-somme-tableau": {
        regions: ["\nint somme(const int *t, int n) {\n    return 0;\n}\n"],
      },
      "prg1-classement-types-c": {
        columns: { q7m2xk4a: ["f3n8wz1c"], c9t1vp6z: ["y8e3gn5w"] },
      },
      "prg1-image-damier": {
        regions: ["\nint case_noire(int x, int y) {\n    // votre code ici\n    return 0;\n}\n"],
      },
      // Circuit and essay left untouched.
    },
  },
  // `gabriel` is absent on purpose: no paper, no attempt.
];
