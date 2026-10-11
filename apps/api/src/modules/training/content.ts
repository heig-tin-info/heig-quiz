/**
 * The training content (ADR-105 §2, §3): the pool, its questions and the two
 * evaluations of the training course, typed by `./content-types.ts`.
 *
 * The question text is French on purpose, as `seed/content.ts` is: it is
 * what a teacher reads on the screen, and content IS a UI string (invariant
 * 1). Everything around it stays English.
 *
 * Each statement teaches a GESTURE of the platform, and its answer is read
 * off the screen around it; it points at the gesture, never at its wording,
 * so no key is a label of the interface (Assumption 5): every short key is a
 * number, every cloze blank a number or a drop-down (`./content.test.ts`).
 * Each explanation says what the teacher would configure to obtain the
 * behaviour the question showed, quoting the French labels of `fr.ts`.
 *
 * The opaque ids of the categorize cards and of the diagram scenes are
 * written by hand, so a second install writes the same config (ADR-036,
 * ADR-046 §2).
 */
import type { TrainingContent } from "./content-types.js";

const WELCOME = "Quiz d'accueil";
const LIVE = "Quiz en direct";

/**
 * The reference of `init-allumer-une-led`: R1 from `in+` to the anode of
 * D1, D1 down to the `in-` / `out-` rail, the output taken across the diode.
 * On the 20-unit grid of `packages/qt-circuit/src/library.ts`, so the
 * netlist extractor reads three nets and raises no issue.
 */
const LED_CIRCUIT = {
  components: [
    { id: "c1", kind: "R", x: 200, y: 100, m: [1, 0, 0, 1], name: "R1", value: "1k" },
    { id: "c2", kind: "D", x: 400, y: 240, m: [0, 1, -1, 0], name: "D1", value: "" },
  ],
  wires: [
    {
      id: "w1",
      a: { kind: "port", port: "in+" },
      b: { kind: "pin", c: "c1", p: 0 },
      via: [],
      points: [[0, 100], [160, 100]],
    },
    {
      id: "w2",
      a: { kind: "pin", c: "c1", p: 1 },
      b: { kind: "pin", c: "c2", p: 0 },
      via: [],
      points: [[240, 100], [400, 100], [400, 200]],
    },
    {
      id: "w3",
      a: { kind: "pin", c: "c2", p: 1 },
      b: { kind: "port", port: "in-" },
      via: [],
      points: [[400, 280], [400, 400], [0, 400]],
    },
    {
      id: "w4",
      a: { kind: "free", x: 400, y: 100 },
      b: { kind: "port", port: "out+" },
      via: [],
      points: [[400, 100], [800, 100]],
    },
    {
      id: "w5",
      a: { kind: "free", x: 400, y: 400 },
      b: { kind: "port", port: "out-" },
      via: [],
      points: [[400, 400], [800, 400]],
    },
  ],
};

/** The one editable region of `init-bonjour-quiz`, byte for byte (`qt-code`'s `reference.ts`). */
const HELLO_SOLUTION = '    printf("Bonjour Quiz\\n");\n';

/**
 * The flowchart of `init-vie-d-une-evaluation`: the life of an evaluation,
 * with the hand grading looping until everything is validated. The starter
 * holds the two terminals under ids of its own (ADR-046 §2).
 */
const EVALUATION_FLOW_REFERENCE = {
  nodes: [
    { id: "t4k9ma2x", t: "terminal", x: 340, y: 20, name: "Création" },
    { id: "a7w3nc5e", t: "action", x: 340, y: 100, name: "Configurer et ouvrir" },
    { id: "a2q8rd6h", t: "action", x: 340, y: 180, name: "Les étudiants répondent" },
    { id: "a9c1se4v", t: "action", x: 340, y: 260, name: "Fermeture à l'échéance" },
    { id: "d5m6tf8j", t: "decision", x: 340, y: 340, name: "Tout est validé ?" },
    { id: "a3p0ug7b", t: "action", x: 560, y: 340, name: "Corriger à la main" },
    { id: "a8r2vh1n", t: "action", x: 340, y: 460, name: "Publier les résultats" },
    { id: "t1x5wi9o", t: "terminal", x: 340, y: 540, name: "Résultats lus" },
  ],
  links: [
    { id: "f6y7xj3s", type: "flow", a: "t4k9ma2x", b: "a7w3nc5e" },
    { id: "f0b4yk8t", type: "flow", a: "a7w3nc5e", b: "a2q8rd6h" },
    { id: "f3d9zl2u", type: "flow", a: "a2q8rd6h", b: "a9c1se4v" },
    { id: "f8e1am6w", type: "flow", a: "a9c1se4v", b: "d5m6tf8j" },
    { id: "f2g5bn0y", type: "flow", a: "d5m6tf8j", b: "a3p0ug7b", name: "non" },
    { id: "f7h8co4z", type: "flow", a: "a3p0ug7b", b: "d5m6tf8j", via: [{ x: 560, y: 420 }, { x: 440, y: 420 }] },
    { id: "f1j2dp9a", type: "flow", a: "d5m6tf8j", b: "a8r2vh1n", name: "oui" },
    { id: "f5k6eq3c", type: "flow", a: "a8r2vh1n", b: "t1x5wi9o" },
  ],
};

const EVALUATION_FLOW_STARTER = {
  nodes: [
    { id: "s9n3fr7d", t: "terminal", x: 340, y: 20, name: "Création" },
    { id: "s4o8gs1f", t: "terminal", x: 340, y: 540, name: "Résultats lus" },
  ],
  links: [],
};

export const TRAINING_CONTENT: TrainingContent = {
  pool: {
    name: "Prise en main de Quiz",
    description:
      "Les questions du cours d'initiation : chacune montre un geste de la plateforme, " +
      "et sa correction dit quel réglage le produit.",
    icon: "graduation-cap",
  },
  questions: [
    // -----------------------------------------------------------------------
    // The welcome quiz: one question per automatically graded type
    // -----------------------------------------------------------------------
    {
      internalName: "init-ce-que-voit-l-etudiant",
      type: "mcq",
      category: WELCOME,
      difficulty: 1,
      explanation:
        "Le nom interne, les concepts et la difficulté ne quittent jamais le serveur, quelle que " +
        "soit la configuration. L'explication n'apparaît qu'avec la correction, et seulement si " +
        "le réglage « Retour à l'étudiant » de l'étape « Modalité » la montre. Dans l'éditeur, " +
        "« Aperçu étudiant » montre exactement ce qui part.",
      // `true_false`: each choice is its own item, so the trainee sees a partial score.
      config: {
        configVersion: 2,
        prompt:
          "Vous répondez à cette question **comme un étudiant**. Parmi les éléments d'une " +
          "question, lesquels un étudiant voit-il pendant son épreuve ? Cochez **tout** ce qui " +
          "s'applique.",
        mode: "multiple",
        policy: "true_false",
        shuffleChoices: true,
        choices: [
          { text: "L'énoncé", correct: true },
          { text: "Les choix de réponse", correct: true },
          { text: "Le nom interne de la question", correct: false },
          { text: "Les concepts qu'elle exerce", correct: false },
          { text: "Sa difficulté", correct: false },
          { text: "Son explication, avant la correction", correct: false },
        ],
      },
    },
    {
      internalName: "init-compter-les-questions",
      type: "short",
      category: WELCOME,
      difficulty: 1,
      explanation:
        "Le sommaire des questions — à gauche du lecteur, ou en bandeau sur un petit écran — " +
        "les liste toutes dans l'ordre de l'évaluation et dit lesquelles ont une réponse ; vous " +
        "pouvez y circuler comme vous voulez parce que le réglage « Navigation » de cet " +
        "exercice est « Libre » ; « Sans retour », à l'étape « Modalité », interdirait de " +
        "revenir en arrière.",
      // The key is this question's own position in the welcome quiz, which a
      // copy keeps: an added question goes at the end (`evaluation/items.ts`)
      // and the item order is never shuffled by default. Pinned by the test.
      config: {
        configVersion: 3,
        prompt:
          "Regardez le **sommaire** du lecteur, qui liste les questions de ce quiz et vous " +
          "laisse passer de l'une à l'autre. À quelle position cette question se trouve-t-elle " +
          "dans la liste ?",
        kind: "number",
        placeholder: "une position",
        constraints: { min: 1, integer: true },
        matchers: [{ kind: "number", value: 2, tolerance: 0 }],
      },
    },
    {
      internalName: "init-cycle-de-vie-d-une-question",
      type: "cloze",
      category: WELCOME,
      difficulty: 2,
      explanation:
        "Chaque publication numérote une version et n'en modifie jamais une autre ; un " +
        "brouillon n'atteint jamais un étudiant. Une évaluation fige la version du moment où " +
        "la question est ajoutée : quand une version plus récente existe, son étape " +
        "« Questions » signale la version disponible et vous choisissez de mettre à jour ou " +
        "non — ce que la mission 3 vous fera faire.",
      config: {
        configVersion: 2,
        caseSensitive: false,
        text:
          "Une question vit dans une banque, et c'est sa **version publiée** qui atteint les " +
          "étudiants : avant la première publication, aucun étudiant ne la lit. Publier le " +
          "brouillon crée la version numéro {{#1}} ; corriger ensuite une faute et publier de " +
          "nouveau crée la version numéro {{#2}}, et la précédente reste intacte.\n\n" +
          "Quand une évaluation ajoute une question, elle en **fige** la version : si une " +
          "version plus récente paraît, l'évaluation {{remplace|=garde}} la version figée et " +
          "vous {{=propose|impose}} la mise à jour.",
      },
    },
    {
      internalName: "init-qui-fait-quoi",
      type: "categorize",
      category: WELCOME,
      difficulty: 1,
      explanation:
        "Le serveur tient l'horloge, enregistre et corrige ; l'enseignant décide, valide et " +
        "publie ; l'étudiant répond. Cette question est notée « Par carte » : une carte mal " +
        "placée ne coûte que sa part. La question peut aussi laisser l'évaluation choisir " +
        "entre « Par carte » et « Exact ».",
      // ADR-036: the ids are opaque on purpose — the student's view carries
      // them, so they must say nothing about where a card goes.
      config: {
        configVersion: 1,
        prompt:
          "Pendant une évaluation, qui fait quoi ? Glissez chaque geste dans la colonne de " +
          "celui qui le fait.",
        columns: [
          { id: "k3v8xq2m", label: "L'étudiant", cards: ["b7n4dw9e", "h2s6gy1r", "p9c3lz5t"] },
          { id: "w6j1te7a", label: "L'enseignant", cards: ["m4f8ka0u", "y1d5ob3x", "r8g2pe6k"] },
          { id: "z5q9rh4c", label: "Le serveur", cards: ["e3t7nv2j", "u0l6mc8s", "c6w2xi4h"] },
        ],
        cards: [
          { id: "b7n4dw9e", text: "Répond aux questions" },
          { id: "h2s6gy1r", text: "Rend sa copie" },
          { id: "p9c3lz5t", text: "Recommence un exercice, si la reprise est permise" },
          { id: "m4f8ka0u", text: "Publie les résultats" },
          { id: "y1d5ob3x", text: "Valide les corrections proposées" },
          { id: "r8g2pe6k", text: "Ajoute cinq minutes à un étudiant" },
          { id: "e3t7nv2j", text: "Ferme la tentative à l'échéance" },
          { id: "u0l6mc8s", text: "Corrige le code rendu" },
          { id: "c6w2xi4h", text: "Enregistre chaque réponse à mesure qu'elle est saisie" },
        ],
        ordered: false,
        shuffleCards: true,
        shuffleColumns: false,
        policy: "per_item",
      },
    },
    {
      internalName: "init-note-suisse",
      type: "math",
      category: WELCOME,
      difficulty: 1,
      explanation:
        "Toute écriture équivalente est acceptée : la réponse est comparée au corrigé par sa " +
        "valeur, en quelques points tirés au hasard dans les intervalles des symboles, jamais " +
        "par son orthographe — $1 + \\frac{5p}{n}$ ou $\\frac{n + 5p}{n}$ passent aussi. " +
        "L'enseignant déclare les symboles et leur intervalle, une ou plusieurs réponses " +
        "acceptées, et une tolérance. Le barème de l'évaluation applique cette formule, " +
        "arrondie au dixième et plafonnée à 6.",
      // The key is compared by value at sample points (ADR-102).
      config: {
        configVersion: 1,
        prompt:
          "La note suisse, de 1 à 6, se calcule à partir des points : un étudiant obtient $p$ " +
          "points sur un total de $n$, et sa note vaut 1 pour aucun point, 6 pour tous. Donnez " +
          "sa **note** en fonction de $p$ et $n$.",
        symbols: [
          { name: "p", min: 0, max: 20 },
          { name: "n", min: 20, max: 100 },
        ],
        answers: [{ value: "1 + 5 \\cdot \\frac{p}{n}", points: 1 }],
      },
    },
    {
      internalName: "init-allumer-une-led",
      type: "circuit",
      category: WELCOME,
      difficulty: 2,
      explanation:
        "Un montage est noté par **simulation** : votre schéma et celui de référence sont " +
        "traduits en netlist côté serveur et simulés sous chaque stimulus, puis les tensions de " +
        "sortie sont comparées, à une tolérance près. Ici la tension aux bornes de la diode " +
        "(environ 0,7 V entre son anode et sa cathode) devait coïncider avec celle du montage " +
        "de référence ; le réglage « Montrer le signal attendu » superpose la courbe de " +
        "référence à la vôtre. Sans simulateur configuré, la note arrive comme une proposition " +
        "que l'enseignant valide.",
      /*
       * Graded by simulation, with the reference's output shown: what the
       * type does when a runner exists. A DC source makes a flat transient,
       * so the comparison is the absolute RMS gap in volts (`grade.ts`
       * divides by 1 when the swing is nil): a missing resistor fails, a
       * 470 Ω one passes.
       */
      config: {
        configVersion: 1,
        prompt:
          "Faites s'allumer une diode (la LED du montage, représentée par la diode au silicium " +
          "de la palette) avec la pile de 5 V branchée à gauche. Glissez une **résistance** et " +
          "une **diode** dans la boîte, puis câblez : la borne du haut de l'entrée vers la " +
          "résistance, la résistance vers la diode, la diode vers la borne du bas, qui est la " +
          "masse. Le triangle de la diode doit pointer vers la masse. Reliez enfin les deux " +
          "bornes de droite, où se lit la sortie, aux deux côtés de la diode, puis **Simuler** " +
          "pour lire la tension à ses bornes.",
        palette: { kinds: ["R", "D", "GND"], maxComponents: 3 },
        supplies: { vcc: null, vee: null },
        commonGround: true,
        stimuli: [
          {
            name: "pile 5 V",
            source: { kind: "dc", volts: 5 },
            sourceOhms: 0,
            load: { kind: "open" },
            analysis: { kind: "tran", stopMs: 5, skipMs: 0, points: 500 },
            points: 1,
            visible: true,
          },
        ],
        reference: LED_CIRCUIT,
        grading: { mode: "simulation", tolerance: 0.05, rubric: "" },
        showExpected: true,
        simulationsPerMinute: 10,
      },
    },
    {
      internalName: "init-bonjour-quiz",
      type: "code",
      category: WELCOME,
      difficulty: 1,
      explanation:
        "Le gabarit verrouille ce qui se trouve entre `@@lock` et `@@endlock` ; l'étudiant " +
        "n'édite que la zone libre, et la source envoyée au correcteur est reconstruite côté " +
        "serveur. Le bouton d'essai exécute le programme dans le navigateur ou sur le serveur " +
        "(réglage « Essais de l'étudiant » de la question) ; la note, elle, vient toujours du " +
        "serveur, cas visibles et cachés confondus. Dans l'éditeur, votre solution de référence " +
        "sert à « Essayer » la question avant de la publier.",
      // The student's trials run in the browser (`runno`): the welcome quiz
      // needs no runner for the gesture it teaches, and the grade stays the server's.
      config: {
        configVersion: 1,
        language: "c",
        runtime: "runno",
        action: "run",
        prompt:
          "Remplacez les points de suspension pour que le programme affiche exactement la ligne " +
          "`Bonjour Quiz`. Avant de valider, **exécutez-le** : le cas de test visible vous dit " +
          "tout de suite si la sortie est la bonne — c'est ce que vos étudiants feront.",
        template:
          "// @@lock\n#include <stdio.h>\n\nint main(void) {\n// @@endlock\n" +
          '    printf("...\\n");\n' +
          "// @@lock\n    return 0;\n}\n// @@endlock\n",
        referenceSolution: HELLO_SOLUTION,
        limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
        tests: {
          mode: "io",
          cases: [{ name: "la ligne attendue", stdin: "", expected: "Bonjour Quiz\n", visible: true, points: 1 }],
        },
      },
    },
    // -----------------------------------------------------------------------
    // The live quiz: the two hand-graded types (two welcome questions are reused)
    // -----------------------------------------------------------------------
    {
      internalName: "init-consigne-avant-un-quiz",
      type: "rich",
      category: LIVE,
      difficulty: 1,
      explanation:
        "Une rédaction est notée à la main, à partir de la grille, que seul l'enseignant lit, " +
        "et de la réponse modèle, que l'étudiant ne voit que si le retour à l'étudiant montre " +
        "le corrigé ; quand la plateforme dispose d'un modèle de langage, une proposition de " +
        "note et sa justification vous attendent dans le panneau de correction, et vous la " +
        "validez ou l'ajustez. Les conditions d'un quiz se déclarent aussi dans l'évaluation, " +
        "sous « Conditions » à l'étape « Modalité » : les étudiants les lisent dans la salle " +
        "d'attente.",
      // Graded by hand, with the LLM proposal when the gateway is configured
      // (ADR-063). The rubric is the grader's; the model answer reaches a
      // student only under a shown key (ADR-037).
      config: {
        configVersion: 1,
        prompt:
          "Rédigez, en **deux phrases**, ce que vous diriez à vos étudiants juste avant un quiz " +
          "noté : ce qui est autorisé, et ce qui se passe à l'échéance.",
        rubric:
          "- **1 pt** : ce qui est autorisé ou interdit est dit clairement.\n" +
          "- **1 pt** : l'échéance est annoncée, et ce qu'elle entraîne (la copie est rendue telle quelle).",
        reference:
          "Vous pouvez utiliser vos notes et la calculatrice, mais aucun échange entre vous. " +
          "À l'échéance, vos réponses sont enregistrées telles qu'elles sont : rien ne se perd, " +
          "rien ne s'ajoute.",
        maxChars: 600,
        format: "markdown",
      },
    },
    {
      internalName: "init-vie-d-une-evaluation",
      type: "diagram",
      category: LIVE,
      difficulty: 2,
      explanation:
        "Un organigramme est noté à la main : le correcteur compare votre dessin au schéma de " +
        "référence, grille à l'appui ; un modèle de langage, s'il est configuré, propose une " +
        "note à partir de leur forme texte. Le dessin de départ (les deux terminaux) est un " +
        "réglage de la question, comme la notation choisie — organigramme, classes, états…",
      config: {
        configVersion: 1,
        prompt:
          "Dessinez l'**organigramme** de la vie d'une évaluation, de sa création à la lecture " +
          "des résultats par les étudiants : ouverture, réponses, fermeture à l'échéance, " +
          "correction à la main jusqu'à ce que tout soit validé, puis publication. Partez des " +
          "deux terminaux fournis.",
        kind: "flow",
        reference: EVALUATION_FLOW_REFERENCE,
        starter: EVALUATION_FLOW_STARTER,
        rubric:
          "- **1 pt** : l'ordre ouverture → réponses → fermeture → correction → publication.\n" +
          "- **1 pt** : la correction à la main boucle jusqu'à ce que tout soit validé, et la " +
          "publication vient après.",
      },
    },
  ],
  evaluations: [
    {
      key: "welcome",
      title: "Le quiz d'accueil",
      mode: "exercise",
      target: "scheduled",
      questions: [
        "init-ce-que-voit-l-etudiant",
        "init-compter-les-questions",
        "init-cycle-de-vie-d-une-question",
        "init-qui-fait-quoi",
        "init-note-suisse",
        "init-allumer-une-led",
        "init-bonjour-quiz",
      ],
    },
    {
      key: "live",
      title: "Le quiz en direct",
      mode: "exam",
      target: "draft",
      // The two hand-graded types, then two automatically graded ones of the
      // welcome quiz, so the grading panel shows validated and pending answers
      // side by side. Not the short: its key is its position in the welcome quiz.
      questions: [
        "init-consigne-avant-un-quiz",
        "init-vie-d-une-evaluation",
        "init-ce-que-voit-l-etudiant",
        "init-cycle-de-vie-d-une-question",
      ],
    },
  ],
};
