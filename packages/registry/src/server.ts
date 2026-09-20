/**
 * The static server-side question-type registry (PLAN-MVP §1.5, decision D1).
 *
 * This is the ONE place the API learns which question types exist. It depends
 * on `@quiz/core` and on the `qt-*` packages; nothing may depend on it from
 * inside `@quiz/core`, or the package graph would cycle.
 *
 * TODO(WP2): register `mcq`, `short` and `cloze` from `@quiz/qt-<id>` server entry.
 * Registering a type is two lines: an import and an entry in `serverRegistry`.
 */
import { codeServer } from "@quiz/qt-code/server";

import {
  defineServerRegistry,
  makeLookup,
  registeredIds,
  type AnyQuestionTypeServer,
  type QuestionTypeId,
} from "@quiz/core/server";

export const serverRegistry: Partial<Record<QuestionTypeId, AnyQuestionTypeServer>> =
  defineServerRegistry({
    // TODO(WP2): mcq: mcqServer, short: shortServer, cloze: clozeServer
    code: codeServer,
  });

/** Total lookup; an unregistered id throws `UnknownQuestionType`. */
export const questionType = makeLookup<AnyQuestionTypeServer>(serverRegistry);

/** The ids that are actually wired up right now (`mcq`, `short` and `cloze` land with WP2). */
export const registeredServerIds = (): string[] => registeredIds(serverRegistry);

export { QUESTION_TYPE_IDS } from "@quiz/core/server";
export type { QuestionTypeId } from "@quiz/core/server";
