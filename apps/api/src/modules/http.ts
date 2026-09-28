/**
 * The three replies every route module used to spell out for itself.
 *
 * Before this file, `invalid()` and `emptyBody()` existed six times each and
 * `notFound()` twice, which is six places to change when the error envelope
 * moves. The bodies are unchanged: `{ error: "validation", details }` with
 * `details` built by `issuesOf()` from `@quiz/contracts`, the same function
 * the client parses with `ZodIssueLite` (invariant 7).
 *
 * One other 400 shape still lives inline in
 * `realtime/routes.ts`/`notifications/routes.ts` (bare
 * `{ error: "validation" }`).
 *
 * Then `DomainError`, the one refusal a service throws, and `sendFailure`,
 * the error tail every route shares: a module's own arms first (the 410 of
 * the clock, a `retry-after`), then any `DomainError` as
 * `{ error, message, ...details }`, then a logged 500.
 *
 * Below them, `studentRoute`/`teacherRoute`: the guarded-route preamble
 * (clock, params, body, loader, error tail) written once.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Base of everything a service refuses: a machine `code`, an HTTP `status`,
 * a sentence for the log and, in `details`, the machine half of a refusal
 * the screen translates rather than prints (#76). It travels in the body
 * beside `error` and `message`. The modules keep a thin subclass each
 * (`EvaluationError`, `LiveError`, …) so a route can still single out
 * its own family when it needs to.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message ?? code);
    this.name = "DomainError";
  }
}

/**
 * A module's own arms, tried before the shared tail: a reply when the error
 * is one it answers in its own shape, `null` to fall through.
 */
export type FailureArms = (reply: FastifyReply, error: unknown, now: Date) => FastifyReply | null;

/**
 * The error tail of every route: the module's `arms`, then a `DomainError`
 * with its status, then a 500. An unexpected error is logged through
 * `reply.log`, the request-scoped logger, so the line carries the `reqId`
 * the global handler's `req.log` did.
 */
export function sendFailure(
  reply: FastifyReply,
  error: unknown,
  now: Date,
  arms?: FailureArms,
): FastifyReply {
  const handled = arms?.(reply, error, now);
  if (handled) return handled;
  if (error instanceof DomainError) {
    return reply
      .code(error.status)
      .send({ error: error.code, message: error.message, ...error.details });
  }
  reply.log.error({ err: error, cause: (error as Error)?.cause }, "route failed");
  return reply.code(500).send({ error: "internal_error" });
}

// ---------------------------------------------------------------------------
// Route wrappers (audit B-02)
// ---------------------------------------------------------------------------

type Schema = z.ZodType;
type Parsed<S> = S extends Schema ? z.output<S> : undefined;

/** What a guarded handler receives: everything the preamble used to compute. */
export interface RouteContext<P, B, Q, S> {
  req: FastifyRequest;
  reply: FastifyReply;
  /** The server's clock, read once per request before anything else (invariant 5). */
  now: Date;
  params: P;
  body: B;
  query: Q;
  scope: S;
}

export interface RouteSpec<
  P extends Schema,
  S,
  B extends Schema | undefined,
  Q extends Schema | undefined,
> {
  /** A schema from `@quiz/contracts` (invariant 7); a mismatch is a 404, like a miss. */
  params: P;
  /** A schema from `@quiz/contracts`; a mismatch is `invalid()`. */
  body?: B;
  /**
   * Parse `emptyBody(req.body)`: no body means all defaults instead of a 400.
   * Only meaningful with a `body`, so without one the type forbids it.
   */
  optionalBody?: [B] extends [Schema] ? boolean : never;
  /** Parsed as `req.query ?? {}`; a mismatch is `invalid()`. */
  query?: Q;
  /**
   * The loader of invariant 6. It answers the 404 itself and returns null,
   * so the wrapper never turns a miss into anything else.
   */
  load: (req: FastifyRequest, reply: FastifyReply, params: z.output<P>) => Promise<S | null>;
}

/**
 * The two orders the routes have always used. A STUDENT route validates its
 * body before it touches the database (a malformed autosave is a 400 even on
 * somebody else's attempt); a TEACHER route loads its scope first (a caller
 * off the staff learns nothing, not even that their body was malformed).
 */
type Order = "body-first" | "scope-first";

/** An error that carries its own 4xx `statusCode`, the way Fastify's and its plugins' do. */
function isClientError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500;
}

function wrapper(order: Order) {
  return (app: FastifyInstance, arms?: FailureArms) =>
    <
      P extends Schema,
      S,
      B extends Schema | undefined = undefined,
      Q extends Schema | undefined = undefined,
    >(
      spec: RouteSpec<P, S, B, Q>,
      handler: (ctx: RouteContext<z.output<P>, Parsed<B>, Parsed<Q>, S>) => unknown,
    ) =>
      async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
        const now = app.clock.now();
        const params = spec.params.safeParse(req.params);
        if (!params.success) return notFound(reply);

        let body: unknown;
        let query: unknown;
        const parseInputs = (): FastifyReply | null => {
          if (spec.body) {
            const parsed = spec.body.safeParse(spec.optionalBody ? emptyBody(req.body) : req.body);
            if (!parsed.success) return invalid(reply, parsed.error);
            body = parsed.data;
          }
          if (spec.query) {
            const parsed = spec.query.safeParse(req.query ?? {});
            if (!parsed.success) return invalid(reply, parsed.error);
            query = parsed.data;
          }
          return null;
        };

        if (order === "body-first") {
          const refused = parseInputs();
          if (refused) return refused;
        }
        const scope = await spec.load(req, reply, params.data);
        if (scope === null) return reply;
        if (order === "scope-first") {
          const refused = parseInputs();
          if (refused) return refused;
        }

        try {
          return await handler({
            req,
            reply,
            now,
            params: params.data,
            body: body as Parsed<B>,
            query: query as Parsed<Q>,
            scope,
          });
        } catch (error) {
          // A Fastify client error (a multipart limit's 413, …) goes back to
          // the global error handler, which sends it as it always did; only
          // the rest goes through the shared tail.
          if (isClientError(error)) throw error;
          return sendFailure(reply, error, now, arms);
        }
      };
}

/**
 * `studentRoute(app, arms?)(spec, handler)` — params (404), body (400),
 * scope (the loader's 404), then the handler under `sendFailure`.
 */
export const studentRoute = wrapper("body-first");

/**
 * `teacherRoute(app, arms?)(spec, handler)` — params (404), scope (the
 * loader's 404), body/query (400), then the handler under `sendFailure`.
 */
export const teacherRoute = wrapper("scope-first");
