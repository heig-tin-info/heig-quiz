/**
 * `@quiz/qt-mcq/client` — the browser half of the `mcq` type (PLAN-MVP §1.4).
 *
 * The three components are behind `React.lazy`, as the plan requires of every
 * registered type: the pool list, the dashboard and the student shell import
 * the registry, not the editors, so nothing but the played type is fetched.
 */
import { lazy } from "react";
import type { QuestionTypeClient } from "@quiz/core/client";
import type { McqAnswer, McqConfig, McqDetails, McqSolution, McqStudent } from "./schema.js";
import { choiceLetter } from "./ui.js";

export type McqClient = QuestionTypeClient<McqConfig, McqAnswer, McqStudent, McqSolution, McqDetails>;

/** A ticked list: the mark of a multiple-choice question in a type picker. */
function McqIcon({ className = "size-4" }: { className?: string }) {
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
      <path d="m3 7 2 2 3-3M3 17l2 2 3-3M12 8h9M12 18h9" />
    </svg>
  );
}

export const mcqClient: McqClient = {
  id: "mcq",
  labelKey: "qt.mcq.label",
  hintKey: "qt.mcq.hint",
  Icon: McqIcon,

  Editor: lazy(async () => ({ default: (await import("./Editor.js")).McqEditor })),
  Player: lazy(async () => ({ default: (await import("./Player.js")).McqPlayer })),
  Review: lazy(async () => ({ default: (await import("./Review.js")).McqReview })),
  Stats: lazy(async () => ({ default: (await import("./Stats.js")).McqStats })),

  emptyAnswer: () => ({ selected: [] }),
  isAnswered: (answer) => answer !== null && answer.selected.length > 0,

  /** One line for the dashboard cell: the letters of what was ticked. */
  summarize: (answer, student) => {
    const selected = answer?.selected ?? [];
    if (selected.length === 0) return "—";
    const position = new Map(student.choices.map((choice, index) => [choice.id, index]));
    return selected
      .map((id) => choiceLetter(position.get(id) ?? id))
      .sort()
      .join(", ");
  },
};

/*
 * The surfaces above are deliberately NOT re-exported as values: a static
 * `export { X } from "./Editor.js"` would pull them back into whatever imports
 * this module, undoing the `lazy` above (rollup: INEFFECTIVE_DYNAMIC_IMPORT).
 * A host that genuinely needs one imports the file directly. Types only here.
 */
export type { McqEditorProps } from "./Editor.js";
export type { McqPlayerProps } from "./Player.js";
export type { McqReviewProps } from "./Review.js";
export type { McqStatsProps } from "./Stats.js";
export {
  mcqEditorStrings,
  mcqPlayerStrings,
  mcqReviewStrings,
  mcqStatsStrings,
  type McqEditorStringKey,
  type McqPlayerStringKey,
  type McqReviewStringKey,
  type McqStatsStringKey,
} from "./strings.js";
export type { McqAnswer, McqConfig, McqDetails, McqSolution, McqStudent } from "./schema.js";

/*
 * The letter of a choice is a VALUE the hosts need: the poll projection letters
 * its rows on the wall exactly as the editor, the player and the review letter
 * theirs. One definition (`schema.ts`), one way out for a browser.
 */
export { choiceLetter } from "./ui.js";
