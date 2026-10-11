/**
 * English defaults for the `math` components; `apps/web` passes its French
 * entries through the `strings` prop (`StringOverrides`, `@quiz/core/client`).
 *
 * The problem sentences are ONE dictionary (`mathProblemStrings`), spread
 * into the three surfaces' so each stays complete; the host translates them
 * once, under `qt.math.problem.*`, the way the MCQ policies are worded once.
 */

/** How an expression that could not be read is told, under the field (`problems.ts`). */
export const mathProblemStrings = {
  problemEmpty: "Type an expression.",
  problemTooLong: "Too long: at most {max} characters.",
  problemSyntax: "This expression cannot be read. Check the parentheses and the operators.",
  problemUnknownSymbol: "Unknown variable: {names}. The variables are {symbols}.",
  problemUnsupported: "Not available here: {names}. Write a plain expression of the variables.",
  problemForbiddenFunction: "Not allowed here: {names}.",
  interpreted: "Read as",
} as const;

export type MathProblemStringKey = keyof typeof mathProblemStrings;
export const MATH_PROBLEM_KEYS = Object.keys(mathProblemStrings) as MathProblemStringKey[];

export const mathEditorStrings = {
  ...mathProblemStrings,
  prompt: "Statement",
  symbols: "Variables",
  symbolsHint: "The names the answer may use, and the interval each is sampled in to compare the answers.",
  symbolName: "Name",
  symbolMin: "From",
  symbolMax: "To",
  addSymbol: "Add a variable",
  removeSymbol: "Remove the variable {name}",
  answers: "Accepted answers",
  answersHint: "Compared in order; the first that matches wins. Any equivalent form is accepted.",
  answer: "Expression",
  points: "Points",
  addAnswer: "Add an accepted answer",
  removeAnswer: "Remove accepted answer {n}",
  latex: "LaTeX",
  tolerance: "Tolerance",
  toleranceHint: "Relative. 1e-6 for an exact formula; 0.01 lets a rounded constant through.",
  samples: "Sample points",
  samplesHint: "Points drawn in the variables' intervals to compare the answers.",
  forbidden: "Forbidden functions",
  forbiddenHint: "Told to the student while typing; an answer using one is worth 0.",
  maxLength: "Max length",
  plot: "Graph",
  plotNone: "None",
  plotAnswer: "Answer",
  plotTarget: "With target",
  plotHint: "With one variable: the student's expression is drawn as they type; the target draws the first accepted answer's curve too.",
  symbolsCount: "{n} variables",
  "symbolsCount.one": "1 variable",
  answersCount: "{n} answers",
  "answersCount.one": "1 answer",
} as const;

export type MathEditorStringKey = keyof typeof mathEditorStrings;

export const mathPlayerStrings = {
  ...mathProblemStrings,
  label: "Your answer",
  hint: "Type the expression; the variables are {symbols}. Angles in radians, log is base 10, ln is natural.",
  latex: "LaTeX",
  graph: "Graph",
  yourCurve: "Your answer",
  targetCurve: "Target",
  /** Under the field when a teacher's preview shows the key (`answerKey`, #554). */
  expected: "Accepted answers",
} as const;

export type MathPlayerStringKey = keyof typeof mathPlayerStrings;

export const mathReviewStrings = {
  ...mathProblemStrings,
  yourAnswer: "Your answer",
  noAnswer: "No answer",
  accepted: "Accepted",
  rejected: "Not accepted",
  partially: "Partially accepted",
  notReadable: "Not readable",
  expected: "Accepted answers",
  matchedBy: "Matched accepted answer",
  score: "Score",
} as const;

export type MathReviewStringKey = keyof typeof mathReviewStrings;

/** The words of the grading table's one column (ADR-044). */
export const mathGradingStrings = {
  answer: "Answer",
  empty: "empty",
} as const;
