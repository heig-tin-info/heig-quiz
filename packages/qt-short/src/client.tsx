/**
 * `@quiz/qt-short/client` — the browser half of the `short` type.
 *
 * The three components are behind `React.lazy`, as the plan requires of every
 * registered type.
 */
import { lazy } from "react";
import type { QuestionTypeClient } from "@quiz/core/client";
import { isShortAnswered } from "./schema.js";
import type {
  ShortAnswer,
  ShortConfig,
  ShortDetails,
  ShortSolution,
  ShortStudent,
} from "./schema.js";

type ShortClient = QuestionTypeClient<
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
  isAnswered: (answer) => answer !== null && isShortAnswered(answer),
  summarize: (answer) => {
    const text = answer?.text.trim() ?? "";
    return text === "" ? "—" : text.length > 40 ? `${text.slice(0, 39)}…` : text;
  },
};

/*
 * The surfaces above are deliberately NOT re-exported as values: a static
 * `export { X } from "./Editor.js"` would pull them back into whatever imports
 * this module, undoing the `lazy` above (rollup: INEFFECTIVE_DYNAMIC_IMPORT).
 * A host that genuinely needs one imports the file directly. Types only here.
 */
export {
  shortEditorStrings,
  shortPlayerStrings,
  shortReviewStrings,
  type ShortEditorStringKey,
  type ShortPlayerStringKey,
  type ShortReviewStringKey,
} from "./strings.js";
/*
 * The empty configuration is a VALUE a host needs to write a question with no
 * draft behind it — the poll launcher's unsaved question. `schema.ts` holds no
 * React, so exporting it undoes no `lazy`.
 */
export { emptyShortDraft } from "./schema.js";
export type {
  ShortAnswer,
  ShortConfig,
  ShortConstraints,
  ShortDetails,
  ShortKind,
  ShortMatcher,
  ShortPrefilters,
  ShortSolution,
  ShortStudent,
} from "./schema.js";
