/**
 * The fixed words of a document (ADR-121 §4, ADR-125 §7, both amended
 * 2026-11-04): every document — the hand-out, a student's copy, and the
 * staff's key, answers and copies alike — follows the requesting reader's
 * interface language. The renderers and every hook of a type read their
 * words here, never inline, so a document has one language throughout.
 * What the platform stores as a code (a policy's name, an attempt state's
 * value, a math problem's code) is printed as stored.
 *
 * Both dictionaries are typed {@link Labels}: a word missing in one of them
 * is a compile error.
 */
export interface Labels {
  /**
   * The language these words are in (ADR-126 §7): a type's hook words the
   * fixed words of a figure or of its pseudo-code by it.
   */
  lang: Lang;
  question: string;
  statement: string;
  answerKey: string;
  explanation: string;
  yourAnswer: string;
  points: string;
  /** The unit after a number of points: `2 pt`. */
  pointsShort: string;
  /** The points of an answer nothing has graded yet. */
  notGraded: string;
  noAnswer: string;
  name: string;
  firstName: string;
  /** Column heads of a breakdown, blank by blank. */
  blank: string;
  expected: string;
  result: string;
  right: string;
  wrong: string;
  /** What a statement tells a student before they answer. */
  severalAnswers: string;
  negativeMarking: string;
  expectNumber: string;
  expectDate: string;
  expectTime: string;
  symbols: string;
  lengthLimit: string;
  characters: string;
  /** A student's copy (ADR-125 §18): its summary and what an item says of itself. */
  grade: string;
  awaitingGrading: string;
  comment: string;
  bonus: string;
  notCounted: string;
  /** What stands for a statement or an answer a type cannot print. */
  notPrintable: string;
  /** A staff document (ADR-121): an answer, a comment, an attempt and its state. */
  answer: string;
  staffComment: string;
  attempt: string;
  state: string;
  stateNotStarted: string;
  stateInProgress: string;
  stateSubmitted: string;
  stateExpired: string;
  noAttempt: string;
  unreadableAnswer: string;
  /** How a choice question's policy scored an answer. */
  policy: string;
  fraction: string;
  rightTicks: string;
  wrongTicks: string;
  rightChoices: string;
  wrongChoices: string;
  negativeMarkingShort: string;
  /** A blank's answer, on the staff's reading. */
  given: string;
  /** A program's tests. */
  test: string;
  visibility: string;
  arguments: string;
  visible: string;
  hidden: string;
  passed: string;
  failed: string;
  noTests: string;
  testsPassed: string;
  compileFailed: string;
  answerMisfit: string;
  /** An essay's key. */
  rubric: string;
  criterion: string;
  weight: string;
  graderNote: string;
  /** A short answer's matching. */
  noMatch: string;
  matchedAnswer: string;
  /** A formula that could not be read. */
  notRead: string;
  /** Between a label and its value: `": "` in English, a narrow no-break space and `": "` in French. */
  colon: string;
  /**
   * A printed `blocks` question (ADR-126 §8): how to read its maps, what its
   * hidden warehouses are, the blocks it offers, its starting program, how
   * to write the program by hand. The block words are the type's own.
   */
  blocksMapLegend: string;
  blocksHiddenWarehouses: string;
  blocksAllOrNothing: string;
  blocksToolbox: string;
  blocksStarter: string;
  blocksAnswerHint: string;
}

export const EN_LABELS: Labels = {
  lang: "en",
  question: "Question",
  statement: "Statement",
  answerKey: "Answer key",
  explanation: "Explanation",
  yourAnswer: "Your answer",
  points: "Points",
  pointsShort: "pt",
  notGraded: "not graded",
  noAnswer: "No answer.",
  name: "Name",
  firstName: "First name",
  blank: "Blank",
  expected: "Expected",
  result: "Result",
  right: "right",
  wrong: "wrong",
  severalAnswers: "Several answers may be right.",
  negativeMarking: "A wrong answer costs points. No answer costs nothing.",
  expectNumber: "Answer with a number.",
  expectDate: "Answer with a date.",
  expectTime: "Answer with a time.",
  symbols: "Symbols",
  lengthLimit: "Length limit",
  characters: "characters",
  grade: "Grade",
  awaitingGrading: "Questions awaiting grading",
  comment: "Your teacher's comment",
  bonus: "bonus",
  notCounted: "not counted",
  notPrintable: "Not printable: read it in Quiz.",
  answer: "Answer",
  staffComment: "Comment",
  attempt: "Attempt",
  state: "State",
  stateNotStarted: "Not started",
  stateInProgress: "In progress",
  stateSubmitted: "Handed in",
  stateExpired: "Expired",
  noAttempt: "No attempt.",
  unreadableAnswer: "The stored answer cannot be read.",
  policy: "Policy",
  fraction: "Fraction",
  rightTicks: "Right ticks",
  wrongTicks: "Wrong ticks",
  rightChoices: "Right choices",
  wrongChoices: "Wrong choices",
  negativeMarkingShort: "negative marking",
  given: "Given",
  test: "Test",
  visibility: "Visibility",
  arguments: "Arguments",
  visible: "visible",
  hidden: "hidden",
  passed: "passed",
  failed: "failed",
  noTests: "No tests.",
  testsPassed: "Tests passed",
  compileFailed: "Compilation failed.",
  answerMisfit: "The answer no longer fits the question's template.",
  rubric: "Grading instructions",
  criterion: "Criterion",
  weight: "Weight",
  graderNote: "Grading prompt",
  noMatch: "No accepted answer matched.",
  matchedAnswer: "Matched accepted answer",
  notRead: "Not read",
  colon: ": ",
  blocksMapLegend: "Grey: racks. Black: the robot, its arrow pointing ahead. Dashed: the dock.",
  blocksHiddenWarehouses: "Hidden warehouses, tested at grading",
  blocksAllOrNothing: "The points only when the robot reaches the dock in every warehouse.",
  blocksToolbox: "Blocks you may use",
  blocksStarter: "Starting program",
  blocksAnswerHint: "Write the program in pseudo-code: one block a line, its body indented.",
};

export const FR_LABELS: Labels = {
  lang: "fr",
  question: "Question",
  statement: "Énoncé",
  answerKey: "Corrigé",
  explanation: "Explication",
  yourAnswer: "Votre réponse",
  points: "Points",
  pointsShort: "pt",
  notGraded: "pas encore noté",
  noAnswer: "Pas de réponse.",
  name: "Nom",
  firstName: "Prénom",
  blank: "Trou",
  expected: "Attendu",
  result: "Résultat",
  right: "juste",
  wrong: "faux",
  severalAnswers: "Plusieurs réponses peuvent être justes.",
  negativeMarking: "Une réponse fausse coûte des points. Ne pas répondre ne coûte rien.",
  expectNumber: "Répondez par un nombre.",
  expectDate: "Répondez par une date.",
  expectTime: "Répondez par une heure.",
  symbols: "Symboles",
  lengthLimit: "Longueur maximale",
  characters: "caractères",
  grade: "Note",
  awaitingGrading: "Questions en attente de correction",
  comment: "Commentaire de l'enseignant",
  bonus: "bonus",
  notCounted: "non comptée",
  notPrintable: "Non imprimable : à lire dans Quiz.",
  answer: "Réponse",
  staffComment: "Commentaire",
  attempt: "Tentative",
  state: "État",
  stateNotStarted: "Pas commencée",
  stateInProgress: "En cours",
  stateSubmitted: "Rendue",
  stateExpired: "Expirée",
  noAttempt: "Pas de tentative.",
  unreadableAnswer: "La réponse enregistrée est illisible.",
  policy: "Règle de notation",
  fraction: "Fraction",
  rightTicks: "Coches justes",
  wrongTicks: "Coches fausses",
  rightChoices: "Choix justes",
  wrongChoices: "Choix faux",
  negativeMarkingShort: "points négatifs",
  given: "Réponse donnée",
  test: "Test",
  visibility: "Visibilité",
  arguments: "Arguments",
  visible: "visible",
  hidden: "caché",
  passed: "réussi",
  failed: "échoué",
  noTests: "Aucun test.",
  testsPassed: "Tests réussis",
  compileFailed: "La compilation a échoué.",
  answerMisfit: "La réponse ne correspond plus au modèle de la question.",
  rubric: "Consignes de correction",
  criterion: "Critère",
  weight: "Poids",
  graderNote: "Prompt de correction",
  noMatch: "Aucune réponse acceptée ne correspond.",
  matchedAnswer: "Correspond à la réponse acceptée",
  notRead: "Illisible",
  blocksMapLegend: "Gris : rayonnages. Noir : le robot, sa flèche devant. Pointillés : le quai.",
  blocksHiddenWarehouses: "Entrepôts cachés, testés à la correction",
  blocksAllOrNothing: "Points attribués seulement si le robot atteint le quai dans chaque entrepôt.",
  blocksToolbox: "Blocs à disposition",
  blocksStarter: "Programme de départ",
  blocksAnswerHint: "Écrivez le programme en pseudo-code : un bloc par ligne, son contenu en retrait.",
  // A narrow no-break space before the colon, as the interface writes it.
  colon: " : ",
};

/** The languages a document is worded in. */
export type Lang = "en" | "fr";

/** The words of each language, as a document's `lang` picks them. */
export const LABELS: Readonly<Record<Lang, Labels>> = { en: EN_LABELS, fr: FR_LABELS };

/** `Label: value`, with the language's own colon. */
export const labelled = (labels: Labels, label: string, value: string): string => `${label}${labels.colon}${value}`;
