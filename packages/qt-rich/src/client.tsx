/**
 * `@quiz/qt-rich/client` — the browser half of the `rich` type ("Essay").
 *
 * The three components are behind `React.lazy`, as the plan requires of every
 * registered type.
 */
import { lazy } from "react";
import type { QuestionTypeClient } from "@quiz/core/client";
import { typeIcon } from "@quiz/ui";
import { richGrading } from "./grading.js";
import { isRichAnswered } from "./schema.js";
import type { RichAnswer, RichConfig, RichDetails, RichSolution, RichStudent } from "./schema.js";

type RichClient = QuestionTypeClient<RichConfig, RichAnswer, RichStudent, RichSolution, RichDetails>;

/** A page with its lines of text, the last one short: something to write. */
const RichIcon = typeIcon(<path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h3" />, "size-4");

export const richClient: RichClient = {
  id: "rich",
  labelKey: "qt.rich.label",
  hintKey: "qt.rich.hint",
  Icon: RichIcon,

  Editor: lazy(async () => ({ default: (await import("./Editor.js")).RichEditor })),
  Player: lazy(async () => ({ default: (await import("./Player.js")).RichPlayer })),
  Review: lazy(async () => ({ default: (await import("./Review.js")).RichReview })),

  emptyAnswer: () => ({ text: "" }),
  isAnswered: isRichAnswered,
  grading: richGrading,
};

/* The surfaces stay out of the values exported here, or the `lazy` above is undone (see qt-short). */
export { richEditorStrings, richGradingStrings, richPlayerStrings, richReviewStrings } from "./strings.js";
export { emptyRichDraft } from "./schema.js";
export type { RichAnswer, RichConfig, RichDetails, RichFormat, RichSolution, RichStudent } from "./schema.js";
