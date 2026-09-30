/**
 * `@quiz/qt-categorize/client` — the browser half of the `categorize` type
 * ("Categorize" / « Classement », docs/spec/04 §4.13).
 *
 * The three components are behind `React.lazy`, as the plan requires of every
 * registered type: the pool list, the dashboard and the student shell import
 * the registry, not the editors, so dnd-kit is fetched only with the type.
 */
import { lazy } from "react";
import type { QuestionTypeClient } from "@quiz/core/client";
import { typeIcon } from "@quiz/ui";
import { categorizeGrading } from "./grading.js";
import { isCategorizeAnswered } from "./schema.js";
import type {
  CategorizeAnswer,
  CategorizeConfig,
  CategorizeDetails,
  CategorizeSolution,
  CategorizeStudent,
} from "./schema.js";

type CategorizeClient = QuestionTypeClient<
  CategorizeConfig,
  CategorizeAnswer,
  CategorizeStudent,
  CategorizeSolution,
  CategorizeDetails
>;

/** Three columns, the first two holding a card each: sorting into bins. */
const CategorizeIcon = typeIcon(
  <>
    <path d="M2.5 3.5h5v17h-5zM9.5 3.5h5v17h-5zM16.5 3.5h5v17h-5z" opacity=".55" />
    <g fill="currentColor" stroke="none">
      <rect x="3.5" y="5.5" width="3" height="3" rx=".6" />
      <rect x="3.5" y="10" width="3" height="3" rx=".6" />
      <rect x="10.5" y="5.5" width="3" height="3" rx=".6" />
      <rect x="17.5" y="5.5" width="3" height="3" rx=".6" />
      <rect x="17.5" y="10" width="3" height="3" rx=".6" />
      <rect x="17.5" y="14.5" width="3" height="3" rx=".6" />
    </g>
  </>,
  "size-4",
);

export const categorizeClient: CategorizeClient = {
  id: "categorize",
  labelKey: "qt.categorize.label",
  hintKey: "qt.categorize.hint",
  Icon: CategorizeIcon,

  Editor: lazy(async () => ({ default: (await import("./Editor.js")).CategorizeEditor })),
  Player: lazy(async () => ({ default: (await import("./Player.js")).CategorizePlayer })),
  Review: lazy(async () => ({ default: (await import("./Review.js")).CategorizeReview })),

  emptyAnswer: () => ({ columns: {} }),
  isAnswered: isCategorizeAnswered,
  grading: categorizeGrading,
};

/* The surfaces stay out of the values exported here, or the `lazy` above is undone (see qt-mcq). */
export {
  categorizeEditorStrings,
  categorizeGradingStrings,
  categorizePlayerStrings,
  categorizeReviewStrings,
} from "./strings.js";
export { emptyCategorizeDraft } from "./schema.js";
export type {
  CategorizeAnswer,
  CategorizeConfig,
  CategorizeDetails,
  CategorizeSolution,
  CategorizeStudent,
} from "./schema.js";
