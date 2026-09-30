/**
 * The static browser-side question-type registry (PLAN-MVP §1.5, decision D1).
 *
 * Every entry must expose `Editor`/`Player`/`Review` through `React.lazy`, so
 * that Monaco never enters the initial bundle (N-PERF-05).
 * Every entry exposes `Editor`/`Player`/`Review` through `React.lazy`, so that
 * Monaco never enters the initial bundle (N-PERF-05).
 */
import { circuitClient } from "@quiz/qt-circuit/client";
import { codeClient, codeimageClient } from "@quiz/qt-code/client";

import {
  defineClientRegistry,
  makeLookup,
  type AnyQuestionTypeClient,
  type QuestionTypeId,
} from "@quiz/core/client";
import { categorizeClient } from "@quiz/qt-categorize/client";
import { clozeClient } from "@quiz/qt-cloze/client";
import { diagramClient } from "@quiz/qt-diagram/client";
import { mcqClient } from "@quiz/qt-mcq/client";
import { richClient } from "@quiz/qt-rich/client";
import { shortClient } from "@quiz/qt-short/client";

export { QUESTION_TYPE_IDS } from "@quiz/core/client";
export type { QuestionTypeId } from "@quiz/core/client";

export const clientRegistry: Partial<Record<QuestionTypeId, AnyQuestionTypeClient>> =
  defineClientRegistry({
    mcq: mcqClient,
    short: shortClient,
    cloze: clozeClient,
    code: codeClient,
    circuit: circuitClient,
    codeimage: codeimageClient,
    rich: richClient,
    categorize: categorizeClient,
    diagram: diagramClient,
  });

/** Total lookup; an unregistered id throws `UnknownQuestionType`. */
export const questionTypeClient = makeLookup<AnyQuestionTypeClient>(clientRegistry);
