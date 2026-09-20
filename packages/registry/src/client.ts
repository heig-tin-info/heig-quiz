/**
 * The static browser-side question-type registry (PLAN-MVP §1.5, decision D1).
 *
 * Every entry must expose `Editor`/`Player`/`Review` through `React.lazy`, so
 * that Monaco never enters the initial bundle (N-PERF-05).
 * Every entry exposes `Editor`/`Player`/`Review` through `React.lazy`, so that
 * Monaco never enters the initial bundle (N-PERF-05).
 */
import { codeClient } from "@quiz/qt-code/client";

import {
  defineClientRegistry,
  makeLookup,
  type AnyQuestionTypeClient,
  type QuestionTypeId,
} from "@quiz/core/client";
import { clozeClient } from "@quiz/qt-cloze/client";
import { mcqClient } from "@quiz/qt-mcq/client";
import { shortClient } from "@quiz/qt-short/client";

export { QUESTION_TYPE_IDS } from "@quiz/core/client";
export type { QuestionTypeId } from "@quiz/core/client";

export const clientRegistry: Partial<Record<QuestionTypeId, AnyQuestionTypeClient>> =
  defineClientRegistry({
    mcq: mcqClient,
    short: shortClient,
    cloze: clozeClient,
    code: codeClient,
  });

/** Total lookup; an unregistered id throws `UnknownQuestionType`. */
export const questionTypeClient = makeLookup<AnyQuestionTypeClient>(clientRegistry);
