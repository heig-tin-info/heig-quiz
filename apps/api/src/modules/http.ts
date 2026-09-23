/**
 * The three replies every route module used to spell out for itself.
 *
 * Before this file, `invalid()` and `emptyBody()` existed six times each and
 * `notFound()` twice, which is six places to change when the error envelope
 * moves. The bodies are unchanged: `{ error: "validation", details }` with
 * `details` built by `issuesOf()` from `@quiz/contracts`, the same function
 * the client parses with `ZodIssueLite` (invariant 7).
 *
 * Two other 400 shapes still live inline in `courses.ts`/`org/routes.ts`
 * (`{ error: "validation", issues }`, the raw zod issues) and in
 * `realtime/routes.ts`/`notifications/routes.ts` (bare
 * `{ error: "validation" }`). Aligning them is a wire change and gets its
 * own commit, with a matching look at the web error rendering.
 */
import type { FastifyReply } from "fastify";
import type { z } from "zod";

import { issuesOf } from "@quiz/contracts";

/** `400 validation` with the issues an editor can underline. */
export function invalid(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "validation", details: issuesOf(error) });
}

/**
 * Fastify hands over `undefined` for a bodyless POST, and every schema of
 * `@quiz/contracts` whose fields are all optional accepts `{}` — so this is
 * what makes "no body" mean "all defaults" instead of a 400.
 */
export const emptyBody = (body: unknown) => (body === undefined || body === null ? {} : body);

/**
 * The only refusal a caller without access ever sees (invariant 6): an
 * entity they may not reach is indistinguishable from one that never existed.
 */
export function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "not_found" });
}
