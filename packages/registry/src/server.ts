/**
 * The static server-side question-type registry (PLAN-MVP §1.5, decision D1).
 *
 * This is the ONE place the API learns which question types exist. It depends
 * on `@quiz/core` and on the `qt-*` packages; nothing may depend on it from
 * inside `@quiz/core`, or the package graph would cycle.
 *
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
import { clozeServer } from "@quiz/qt-cloze/server";
import { mcqServer } from "@quiz/qt-mcq/server";
import { shortServer } from "@quiz/qt-short/server";

export const serverRegistry: Partial<Record<QuestionTypeId, AnyQuestionTypeServer>> =
  defineServerRegistry({
    mcq: mcqServer,
    short: shortServer,
    cloze: clozeServer,
    code: codeServer,
  });

/** Total lookup; an unregistered id throws `UnknownQuestionType`. */
export const questionType = makeLookup<AnyQuestionTypeServer>(serverRegistry);

/** The ids that are actually wired up right now (all four MVP types). */
export const registeredServerIds = (): string[] => registeredIds(serverRegistry);

/**
 * Registers a question type from a TEST, and returns the undo.
 *
 * `packages/registry` is the static wiring of the platform: production code
 * only ever reads `serverRegistry`, which is built at module load from the
 * `qt-*` imports above. Tests of the API need a type to exercise the
 * read/write pipeline (`loadConfig`/`saveConfig`, publish, grading) without
 * depending on a `qt-*` package that another work package owns — hence this
 * hook, and only this hook.
 *
 * It is a NO-OP under `NODE_ENV=production`: a deployed instance cannot have
 * its question types changed at runtime, whatever calls this.
 *
 * ```ts
 * const restore = registerForTests(fakeShort);
 * afterAll(restore);
 * ```
 */
export function registerForTests(type: AnyQuestionTypeServer): () => void {
  // `@quiz/registry` carries no Node type definitions (it is imported by the
  // browser half too), hence the structural read of the ambient process.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (env?.["NODE_ENV"] === "production") return () => {};
  const previous = serverRegistry[type.id];
  serverRegistry[type.id] = type;
  return () => {
    if (previous) serverRegistry[type.id] = previous;
    else delete serverRegistry[type.id];
  };
}

export { QUESTION_TYPE_IDS } from "@quiz/core/server";
export type { QuestionTypeId } from "@quiz/core/server";
