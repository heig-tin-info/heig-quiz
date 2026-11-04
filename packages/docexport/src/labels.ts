/**
 * The fixed words of a document (ADR-121 §4, amended by ADR-125): a staff
 * document is English, like the CSV; a document a STUDENT holds — the
 * hand-out, their own copy — follows the requesting reader's interface
 * language. The renderers and the types' student hooks read their words
 * here, never inline, so a hand-out has one language throughout. Words
 * only a staff document holds (a program's tests, a policy) stay English
 * literals where they are written.
 *
 * Both dictionaries are typed {@link Labels}: a word missing in one of them
 * is a compile error.
 */
export interface Labels {
  question: string;
  statement: string;
  referenceSolution: string;
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
  /** Between a label and its value: `": "` in English, a narrow no-break space and `": "` in French. */
  colon: string;
}

export const EN_LABELS: Labels = {
  question: "Question",
  statement: "Statement",
  referenceSolution: "Reference solution",
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
  colon: ": ",
};

export const FR_LABELS: Labels = {
  question: "Question",
  statement: "Énoncé",
  referenceSolution: "Solution de référence",
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
  // A narrow no-break space before the colon, as the interface writes it.
  colon: " : ",
};

/** The languages a document is worded in. */
export type Lang = "en" | "fr";

/** The words of each language, as a document's `lang` picks them. */
export const LABELS: Readonly<Record<Lang, Labels>> = { en: EN_LABELS, fr: FR_LABELS };

/** `Label: value`, with the language's own colon. */
export const labelled = (labels: Labels, label: string, value: string): string => `${label}${labels.colon}${value}`;
