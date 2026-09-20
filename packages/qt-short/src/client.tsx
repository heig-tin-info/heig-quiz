/**
 * `@quiz/qt-short/client` — the browser half of the `short` type.
 *
 * The three components are behind `React.lazy`, as the plan requires of every
 * registered type.
 */
import { lazy } from "react";
import type { QuestionTypeClient } from "@quiz/core/client";
import type {
  ShortAnswer,
  ShortConfig,
  ShortDetails,
  ShortSolution,
  ShortStudent,
} from "./schema.js";

export type ShortClient = QuestionTypeClient<
  ShortConfig,
  ShortAnswer,
  ShortStudent,
  ShortSolution,
  ShortDetails
>;

/** A caret in a field: the mark of a typed answer. */
function ShortIcon({ className = "size-4" }: { className?: string }) {
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
      <path d="M3 6.5h18v11H3zM7 10v4M10.5 10h-3M10.5 14h-3" />
    </svg>
  );
}

export const shortClient: ShortClient = {
  id: "short",
  labelKey: "qt.short.label",
  hintKey: "qt.short.hint",
  Icon: ShortIcon,

  Editor: lazy(async () => ({ default: (await import("./Editor.js")).ShortEditor })),
  Player: lazy(async () => ({ default: (await import("./Player.js")).ShortPlayer })),
  Review: lazy(async () => ({ default: (await import("./Review.js")).ShortReview })),

  emptyAnswer: () => ({ text: "" }),
  isAnswered: (answer) => answer !== null && answer.text.trim() !== "",
  summarize: (answer) => {
    const text = answer?.text.trim() ?? "";
    return text === "" ? "—" : text.length > 40 ? `${text.slice(0, 39)}…` : text;
  },
};

export { ShortEditor, type ShortEditorProps } from "./Editor.js";
export { ShortPlayer, type ShortPlayerProps } from "./Player.js";
export { ShortReview, type ShortReviewProps } from "./Review.js";
export {
  shortEditorStrings,
  shortPlayerStrings,
  shortReviewStrings,
  type ShortEditorStringKey,
  type ShortPlayerStringKey,
  type ShortReviewStringKey,
} from "./strings.js";
export type {
  ShortAnswer,
  ShortConfig,
  ShortDetails,
  ShortMatcher,
  ShortSolution,
  ShortStudent,
} from "./schema.js";
