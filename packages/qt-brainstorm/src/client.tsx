/**
 * `@quiz/qt-brainstorm/client` — the browser half of the `brainstorm` type.
 * The three components are behind `React.lazy`, as every registered type's.
 */
import { lazy } from "react";

import type { QuestionTypeClient } from "@quiz/core/client";
import { typeIcon } from "@quiz/ui";

import { brainstormGrading } from "./grading.js";
import {
  isBrainstormAnswered,
  type BrainstormAnswer,
  type BrainstormConfig,
  type BrainstormDetails,
  type BrainstormSolution,
  type BrainstormStudent,
} from "./schema.js";

type BrainstormClient = QuestionTypeClient<
  BrainstormConfig,
  BrainstormAnswer,
  BrainstormStudent,
  BrainstormSolution,
  BrainstormDetails
>;

/** Three bubbles of different sizes: ideas, and how many share them. */
const BrainstormIcon = typeIcon(
  <>
    <circle cx="9" cy="10" r="5.5" />
    <circle cx="17" cy="7" r="3" />
    <circle cx="17" cy="16.5" r="3.5" />
  </>,
  "size-4",
);

export const brainstormClient: BrainstormClient = {
  id: "brainstorm",
  labelKey: "qt.brainstorm.label",
  hintKey: "qt.brainstorm.hint",
  Icon: BrainstormIcon,

  Editor: lazy(async () => ({ default: (await import("./Editor.js")).BrainstormEditor })),
  Player: lazy(async () => ({ default: (await import("./Player.js")).BrainstormPlayer })),
  Review: lazy(async () => ({ default: (await import("./Review.js")).BrainstormReview })),

  emptyAnswer: () => ({ ideas: [] }),
  isAnswered: isBrainstormAnswered,
  summarize: (answer) => (answer?.ideas ?? []).join(" · "),
  grading: brainstormGrading,
};

export {
  brainstormEditorStrings,
  brainstormGradingStrings,
  brainstormPlayerStrings,
  brainstormReviewStrings,
} from "./strings.js";
export { emptyBrainstormDraft } from "./schema.js";
export type { BrainstormAnswer, BrainstormConfig, BrainstormStudent } from "./schema.js";
