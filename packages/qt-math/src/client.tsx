/**
 * `@quiz/qt-math/client` — the browser half of the `math` type.
 *
 * The three components are behind `React.lazy`: the math field (MathLive)
 * and the parser (Compute Engine) weigh more than a megabyte together and
 * must never enter the initial bundle (N-PERF-05).
 */
import { lazy } from "react";

import type { QuestionTypeClient } from "@quiz/core/client";
import { typeIcon } from "@quiz/ui";

import { mathGrading } from "./grading.js";
import { isMathAnswered, type MathAnswer, type MathConfig, type MathDetails, type MathSolution, type MathStudent } from "./schema.js";

type MathClient = QuestionTypeClient<MathConfig, MathAnswer, MathStudent, MathSolution, MathDetails>;

/** A square root over a line: the mark of a formula. */
const MathIcon = typeIcon(
  <>
    <path d="M3 13l3 6 4-14h11" />
    <path d="M13 11l6 6M19 11l-6 6" />
  </>,
  "size-4",
);

export const mathClient: MathClient = {
  id: "math",
  labelKey: "qt.math.label",
  hintKey: "qt.math.hint",
  Icon: MathIcon,

  Editor: lazy(async () => ({ default: (await import("./Editor.js")).MathEditor })),
  Player: lazy(async () => ({ default: (await import("./Player.js")).MathPlayer })),
  Review: lazy(async () => ({ default: (await import("./Review.js")).MathReview })),
  Key: lazy(async () => ({ default: (await import("./Key.js")).MathKey })),

  emptyAnswer: () => ({ latex: "" }),
  isAnswered: isMathAnswered,
  grading: mathGrading,
};

/* Strings and the empty draft only: a static re-export of a surface would undo the `lazy` above. */
export { MATH_PROBLEM_KEYS, mathEditorStrings, mathGradingStrings, mathKeyStrings, mathPlayerStrings, mathProblemStrings, mathReviewStrings } from "./strings.js";
export { emptyMathDraft } from "./schema.js";
export type { MathAnswer, MathConfig, MathDetails, MathPlot, MathSolution, MathStudent, MathSymbol } from "./schema.js";
