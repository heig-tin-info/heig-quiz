/**
 * `@quiz/qt-cloze/client` — the browser half of the `cloze` type.
 *
 * The three components are behind `React.lazy`, as the plan requires of every
 * registered type.
 */
import { lazy } from "react";
import type { QuestionTypeClient } from "@quiz/core/client";
import { isClozeAnswered } from "./schema.js";
import type {
  ClozeAnswer,
  ClozeConfig,
  ClozeDetails,
  ClozeSolution,
  ClozeStudent,
} from "./schema.js";

type ClozeClient = QuestionTypeClient<
  ClozeConfig,
  ClozeAnswer,
  ClozeStudent,
  ClozeSolution,
  ClozeDetails
>;

/** A line of text with a hole in it. */
function ClozeIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 7h6M15 7h6M3 17h18" />
      <rect x="10.5" y="4.5" width="3" height="5" rx="1" strokeDasharray="2 2" />
    </svg>
  );
}

export const clozeClient: ClozeClient = {
  id: "cloze",
  labelKey: "qt.cloze.label",
  hintKey: "qt.cloze.hint",
  Icon: ClozeIcon,

  Editor: lazy(async () => ({ default: (await import("./Editor.js")).ClozeEditor })),
  Player: lazy(async () => ({ default: (await import("./Player.js")).ClozePlayer })),
  Review: lazy(async () => ({ default: (await import("./Review.js")).ClozeReview })),

  emptyAnswer: (student) => ({ blanks: student.blanks.map(() => null) }),
  isAnswered: (answer) => answer !== null && isClozeAnswered(answer),

  /** One line for the dashboard cell: how many blanks carry something. */
  summarize: (answer, student) => {
    const filled =
      answer?.blanks.filter((blank) => blank !== null && blank.trim() !== "").length ?? 0;
    return `${filled}/${student.blanks.length}`;
  },
};

/*
 * The surfaces above are deliberately NOT re-exported as values: a static
 * `export { X } from "./Editor.js"` would pull them back into whatever imports
 * this module, undoing the `lazy` above (rollup: INEFFECTIVE_DYNAMIC_IMPORT).
 * A host that genuinely needs one imports the file directly. Types only here.
 */
export { ClozeFallbackText, splitBlocks, type ClozeTextRenderer } from "./text.js";
export {
  clozeEditorStrings,
  clozePlayerStrings,
  clozeReviewStrings,
  type ClozeEditorStringKey,
  type ClozePlayerStringKey,
  type ClozeReviewStringKey,
} from "./strings.js";
export type {
  ClozeAnswer,
  ClozeConfig,
  ClozeDetails,
  ClozeSolution,
  ClozeStudent,
} from "./schema.js";
