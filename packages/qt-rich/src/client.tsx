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
const RichIcon = typeIcon(<path d="M5.5 3H15l3.5 3.5V21h-13zM15 3v3.5h3.5M8.5 11h7M8.5 14.5h7M8.5 18h4" />, "size-4");

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
