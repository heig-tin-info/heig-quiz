/**
 * The browser half of the `codeimage` question type, exported by
 * `@quiz/qt-code/client` beside `codeClient`. The three surfaces are
 * `React.lazy`, like `code`'s, so Monaco stays out of the initial bundle.
 */
import { lazy } from "react";

import type { QuestionTypeClient } from "@quiz/core/client";
import { typeIcon } from "@quiz/ui";
import { codeimageGrading } from "./grading.js";
import { isCodeImageAnswered } from "./schema.js";

import type {
  CodeImageAnswer,
  CodeImageConfig,
  CodeImageDetails,
  CodeImageSolution,
  CodeImageStudent,
} from "./schema.js";

/** A framed grid: a picture made of cells. Inline SVG, like `CodeIcon`. */
const CodeImageIcon = typeIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" opacity=".55" />
    <path d="M9 3h6v18H9zM3 9h18v6H3z" fill="currentColor" stroke="none" />
  </>,
);

export const codeimageClient: QuestionTypeClient<
  CodeImageConfig,
  CodeImageAnswer,
  CodeImageStudent,
  CodeImageSolution,
  CodeImageDetails
> = {
  id: "codeimage",
  labelKey: "qt.codeimage.label",
  hintKey: "qt.codeimage.hint",
  Icon: CodeImageIcon,

  Editor: lazy(() => import("./Editor.js")),
  Player: lazy(() => import("./Player.js")),
  Review: lazy(() => import("./Review.js")),

  /** Empty, not seeded — `code`'s rule: an untouched question stays "not answered". */
  emptyAnswer() {
    return { regions: [] };
  },

  isAnswered: isCodeImageAnswered,
  grading: codeimageGrading,
};
