/**
 * `@quiz/qt-mcq/client` — the browser half of the `mcq` type (PLAN-MVP §1.4).
 *
 * The three components are behind `React.lazy`, as the plan requires of every
 * registered type: the pool list, the dashboard and the student shell import
 * the registry, not the editors, so nothing but the played type is fetched.
 */
import { lazy } from "react";
import type { QuestionTypeClient } from "@quiz/core/client";
import { typeIcon } from "@quiz/ui";
import { isMcqAnswered } from "./schema.js";
import type { McqAnswer, McqConfig, McqDetails, McqSolution, McqStudent } from "./schema.js";

type McqClient = QuestionTypeClient<McqConfig, McqAnswer, McqStudent, McqSolution, McqDetails>;

/** A ticked list: the mark of a multiple-choice question in a type picker. */
const McqIcon = typeIcon(<path d="m3 7 2 2 3-3M3 17l2 2 3-3M12 8h9M12 18h9" />, "size-4");

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
  isAnswered: isMcqAnswered,
};

/*
 * The surfaces above are deliberately NOT re-exported as values: a static
 * `export { X } from "./Editor.js"` would pull them back into whatever imports
 * this module, undoing the `lazy` above (rollup: INEFFECTIVE_DYNAMIC_IMPORT).
 * A host that genuinely needs one imports the file directly. Types only here.
 */
export {
  mcqEditorStrings,
  mcqPlayerStrings,
  mcqReviewStrings,
  mcqStatsStrings,
} from "./strings.js";
/*
 * The empty configuration is a VALUE a host needs to write a question with no
 * draft behind it — the poll launcher's unsaved question. `schema.ts` holds no
 * React, so exporting it undoes no `lazy`.
 */
export { emptyMcqDraft } from "./schema.js";
export type { McqAnswer, McqConfig, McqDetails, McqSolution, McqStudent } from "./schema.js";

/*
 * The letter of a choice is a VALUE the hosts need: the poll projection letters
 * its rows on the wall exactly as the editor, the player and the review letter
 * theirs. One definition (`schema.ts`), one way out for a browser.
 */
export { choiceLetter } from "./ui.js";
