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

export type QuestionTypeName = "mcq" | "short" | "cloze" | "code";

export interface QuestionSpec {
  /** Unique inside its pool, and the key the seed is idempotent on. */
  internalName: string;
  type: QuestionTypeName;
  /** Name of the category (folder) this question lives in. */
  category: string;
  /** 1 (trivial) to 5 (hard), as `questions.difficulty` stores it. */
  difficulty: number;
  tags: string[];
  explanation: string;
  /** Validated by the type's own schema when the question is published. */
  config: unknown;
}

export interface PoolSpec {
  name: string;
  /** Course code the pool is attached to, or `null` for a stand-alone pool. */
  courseCode: string | null;
  categories: string[];
  questions: QuestionSpec[];
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
export interface PaperSpec {
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

// ---------------------------------------------------------------------------
// Pool 1 — Programmation C (attached to PRG1)
// ---------------------------------------------------------------------------

const POINTERS = "Pointeurs et mémoire";
const STRINGS = "Chaînes de caractères";
const TYPES = "Types et opérateurs";

export const C_POOL: PoolSpec = {
  name: "Programmation C",
  courseCode: "PRG1",
  categories: [POINTERS, STRINGS, TYPES],
  questions: [
    {
      internalName: "prg1-pointeur-non-initialise",
      type: "mcq",
      category: POINTERS,
      difficulty: 2,
      tags: ["pointeurs", "mémoire"],
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
      tags: ["tableaux", "sizeof", "pointeurs"],
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
      tags: ["opérateurs", "bits"],
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
      tags: ["mots-clés"],
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
      tags: ["chaînes", "mémoire"],
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
      tags: ["boucles", "structures de contrôle"],
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
      tags: ["chaînes", "bibliothèque standard"],
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
      tags: ["pointeurs", "tableaux"],
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
      tags: ["chaînes", "boucles"],
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
      tags: ["chaînes", "pointeurs"],
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
  ],
};

// ---------------------------------------------------------------------------
// Pool 2 — Électronique (stand-alone: a second pool in the teacher's list)
// ---------------------------------------------------------------------------

const DC = "Régime continu";
const SEMICONDUCTORS = "Semi-conducteurs";

export const ELECTRONICS_POOL: PoolSpec = {
  name: "Électronique",
  courseCode: null,
  categories: [DC, SEMICONDUCTORS],
  questions: [
    {
      internalName: "elec-loi-ohm",
      type: "mcq",
      category: DC,
      difficulty: 1,
      tags: ["loi d'ohm", "régime continu"],
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
      tags: ["résistances", "régime continu"],
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
      tags: ["diviseur de tension", "régime continu"],
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
      internalName: "elec-diode-silicium",
      type: "cloze",
      category: SEMICONDUCTORS,
      difficulty: 2,
      tags: ["diode", "semi-conducteurs"],
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
    questions: [
      "prg1-pointeur-non-initialise",
      "prg1-mot-cle-constante",
      "prg1-octets-chaine-litterale",
      "prg1-boucle-for",
      "prg1-code-somme-tableau",
    ],
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
    },
  },
  {
    persona: "chloe",
    submits: false,
    answers: {
      "prg1-pointeur-non-initialise": { selected: [2] },
      "prg1-mot-cle-constante": { text: "CONST" },
      "prg1-octets-chaine-litterale": { text: "5" },
      // Cloze left blank, code left as the skeleton.
      "prg1-code-somme-tableau": {
        regions: ["\nint somme(const int *t, int n) {\n    return 0;\n}\n"],
      },
    },
  },
  // `gabriel` is absent on purpose: no paper, no attempt.
];
