/**
 * Building blocks shared by every route schema (PLAN-MVP §4).
 *
 * The same objects validate the request on the server and type the call on
 * the client (invariant 7): a route change breaks both sides at compile time.
 */
import { z } from "zod";

/** `/…/:id` — the only path shape the loaders of `guards.ts` accept. */
export const IdParam = z.object({ id: z.uuid() });
export type IdParam = z.infer<typeof IdParam>;

/**
 * A zod issue, reduced to what a UI can show. `PUT /questions/:id/draft`
 * returns these for a config that was stored anyway (decision D16), so the
 * editor can underline the fields without knowing zod.
 */
export const ZodIssueLite = z.object({
  path: z.array(z.string()),
  code: z.string(),
  message: z.string(),
});
export type ZodIssueLite = z.infer<typeof ZodIssueLite>;

/** Cursor pagination: `nextCursor === null` means "last page". */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/**
 * A repeated query parameter (`?tag=a&tag=b`) or a comma-separated one
 * (`?tag=a,b`). Fastify hands over a string for one occurrence and an array
 * for several, and the filter bar of the web app produces both.
 */
export const StringList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(",")))
  .pipe(z.array(z.string().trim().min(1)));

/** Same, for the numeric filters (difficulty). */
export const IntList = z
  .union([z.string(), z.array(z.string()), z.array(z.number())])
  .transform((v) =>
    Array.isArray(v) ? v.map(Number) : v.split(",").map((s) => Number(s.trim())),
  )
  .pipe(z.array(z.number().int()));

/** `?flag=1` / `?flag=true` — anything else is false. */
export const BoolFlag = z
  .union([z.string(), z.boolean()])
  .transform((v) => v === true || v === "1" || v === "true");
