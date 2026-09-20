/**
 * The static browser-side question-type registry (PLAN-MVP §1.5, decision D1).
 *
 * TODO(WP2): register `mcq`, `short` and `cloze` from `@quiz/qt-<id>` client entry.
 * TODO(WP3): register `code` from `@quiz/qt-code/client`.
 * Every entry must expose `Editor`/`Player`/`Review` through `React.lazy`, so
 * that Monaco never enters the initial bundle (N-PERF-05).
 */
import {
  defineClientRegistry,
  makeLookup,
  type AnyQuestionTypeClient,
  type QuestionTypeId,
} from "@quiz/core/client";

export { QUESTION_TYPE_IDS } from "@quiz/core/client";
export type { QuestionTypeId } from "@quiz/core/client";

export const clientRegistry: Partial<Record<QuestionTypeId, AnyQuestionTypeClient>> =
  defineClientRegistry({
    // TODO(WP2/WP3): mcq: mcqClient, short: shortClient, cloze: clozeClient, code: codeClient
  });

/** Total lookup; an unregistered id throws `UnknownQuestionType`. */
export const questionTypeClient = makeLookup<AnyQuestionTypeClient>(clientRegistry);

