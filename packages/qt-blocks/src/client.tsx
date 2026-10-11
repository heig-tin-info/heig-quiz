/**
 * `@quiz/qt-blocks/client` — the browser half of the `blocks` type
 * ("Blocks" / « Blocs », docs/spec/04 §4.17, ADR-103).
 *
 * The three surfaces are behind `React.lazy`, and NOTHING exported here
 * reaches Blockly (ADR-103 §11): a static re-export of a surface, or of
 * `blocklyBundle.ts`, would pull Blockly back into whatever imports this
 * module — the pool list, the dashboard, the student shell — undoing the
 * `lazy` below (see `qt-code/src/client.tsx`).
 */
import { lazy } from "react";

import type { QuestionTypeClient } from "@quiz/core/client";
import { typeIcon } from "@quiz/ui";

import { blocksGrading } from "./grading.js";
import { isBlocksAnswered } from "./schema.js";
import type { BlocksAnswer, BlocksConfig, BlocksDetails, BlocksSolution, BlocksStudent } from "./schema.js";

/** Three stacked blocks under a hat: a program of blocks. */
const BlocksIcon = typeIcon(
  <>
    <path d="M4 4.5h7a2 2 0 0 1 2 2V8H4z" />
    <path d="M4 10h10v3.5H4zM7 15.5h10V19H7z" />
  </>,
);

export const blocksClient: QuestionTypeClient<BlocksConfig, BlocksAnswer, BlocksStudent, BlocksSolution, BlocksDetails> = {
  id: "blocks",
  labelKey: "qt.blocks.label",
  hintKey: "qt.blocks.hint",
  Icon: BlocksIcon,

  Editor: lazy(async () => ({ default: (await import("./Editor.js")).BlocksEditor })),
  Player: lazy(async () => ({ default: (await import("./Player.js")).BlocksPlayer })),
  Review: lazy(async () => ({ default: (await import("./Review.js")).BlocksReview })),

  /** The empty program: the player shows the starter for it (`isBlocksAnswered`). */
  emptyAnswer: () => ({ program: [] }),
  isAnswered: isBlocksAnswered,
  grading: blocksGrading,
};

export {
  blocksCanvasStrings,
  blocksEditorStrings,
  blocksGradingStrings,
  blocksPlayerStrings,
  blocksReviewStrings,
} from "./strings.js";
export { pseudoCode } from "./pseudo.js";
export { BlocksAnswer, emptyBlocksDraft, isBlocksAnswered } from "./schema.js";
export type { BlocksConfig, BlocksDetails, BlocksSolution, BlocksStudent } from "./schema.js";
