/**
 * Registry helpers (PLAN-MVP §1.5, decision D1).
 *
 * `packages/core` holds the helpers; the static wiring lives in
 * `packages/registry` so that `core` never imports a `qt-*` package. Adding a
 * question type still means "create the package, register it in two places".
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- see AnyQuestionTypeServer. */
import type { QuestionTypeClient } from "./client.js";
import type { QuestionTypeServer } from "./contract.js";
import { UnknownQuestionType } from "./errors.js";

/**
 * The type-erased shape stored in a registry.
 *
 * `any` is unavoidable here and confined to these two aliases: a registry holds
 * types with five mutually unrelated type parameters, and the method parameters
 * of {@link QuestionTypeServer} are contravariant, so `unknown` would make
 * every concrete type unassignable. Call sites always go back through the
 * concrete type (`loadConfig`/`saveConfig` parse with the type's own schema).
 */
export type AnyQuestionTypeServer = QuestionTypeServer<any, any, any, any, any>;
export type AnyQuestionTypeClient = QuestionTypeClient<any, any, any, any, any>;

/** Identity with a constraint: it only exists to type-check the map at its definition site. */
export function defineServerRegistry<T extends Record<string, AnyQuestionTypeServer>>(m: T): T {
  return m;
}

export function defineClientRegistry<T extends Record<string, AnyQuestionTypeClient>>(m: T): T {
  return m;
}

/** Total lookup: an unregistered id is an {@link UnknownQuestionType}, never `undefined`. */
export function makeLookup<T extends { id: string }>(
  m: Readonly<Record<string, T | undefined>>,
): (id: string) => T {
  return (id: string): T => {
    const t = m[id];
    if (!t) throw new UnknownQuestionType(id);
    return t;
  };
}

/** The ids actually registered, in registration order. */
export function registeredIds(m: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(m);
}
