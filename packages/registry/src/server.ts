/**
 * The static server-side question-type registry (PLAN-MVP §1.5, decision D1).
 *
 * This is the ONE place the API learns which question types exist. It depends
 * on `@quiz/core` and on the `qt-*` packages; nothing may depend on it from
 * inside `@quiz/core`, or the package graph would cycle.
 *
 * TODO(WP3): register `code` from `@quiz/qt-code/server`.
 * Registering a type is two lines: an import and an entry in `serverRegistry`.
 */
import {
  defineServerRegistry,
  makeLookup,
  registeredIds,
  type AnyQuestionTypeServer,
  type QuestionTypeId,
} from "@quiz/core/server";
import { clozeServer } from "@quiz/qt-cloze/server";
import { mcqServer } from "@quiz/qt-mcq/server";
import { shortServer } from "@quiz/qt-short/server";

export const serverRegistry: Partial<Record<QuestionTypeId, AnyQuestionTypeServer>> =
  defineServerRegistry({
    mcq: mcqServer,
    short: shortServer,
    cloze: clozeServer,
    // TODO(WP3): code: codeServer
  });

/** Total lookup; an unregistered id throws `UnknownQuestionType`. */
export const questionType = makeLookup<AnyQuestionTypeServer>(serverRegistry);

/** The ids that are actually wired up right now (`code` lands with WP3). */
export const registeredServerIds = (): string[] => registeredIds(serverRegistry);

export { QUESTION_TYPE_IDS } from "@quiz/core/server";
export type { QuestionTypeId } from "@quiz/core/server";
