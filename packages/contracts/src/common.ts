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
 * An item of an evaluation as the staff sees it: the grading queue, the
 * results, the dashboard and the inspector all name it this way.
 */
export const StaffItemRef = z.object({
  id: z.uuid(),
  position: z.number().int(),
  internalName: z.string(),
  type: z.string(),
  points: z.number(),
});
export type StaffItemRef = z.infer<typeof StaffItemRef>;

/** An account named to the staff: a pool's member or candidate, a course's staff seat. */
export const PersonRef = z.object({
  userId: z.uuid(),
  email: z.string(),
  givenName: z.string(),
  familyName: z.string(),
});
export type PersonRef = z.infer<typeof PersonRef>;

/**
 * A zod issue, reduced to what a UI can show. `PUT /questions/:id/draft`
 * returns these for a config that was stored anyway (decision D16), so the
 * editor can underline the fields without knowing zod.
 */
export const ZodIssueLite = z.object({
  path: z.array(z.string()),
  code: z.string(),
  message: z.string(),
  /** What a `too_small` / `too_big` measured: `string`, `array`, `number`… */
  origin: z.string().optional(),
  /** The bound a `too_small` / `too_big` enforced, so the UI can say it in its own words. */
  limit: z.number().optional(),
});
export type ZodIssueLite = z.infer<typeof ZodIssueLite>;

/**
 * A zod error reduced to {@link ZodIssueLite}. It lives beside the schema it
 * produces so that both sides of invariant 7 agree on the shape: the API
 * builds its `400 validation` body with it, and the client parses the result
 * with `ZodIssueLite`. Anything that is not a `ZodError` collapses to a
 * single issue with an empty path, so a caller never has to branch.
 */
/** The code of an issue that did not come from zod: its message is the error's own. */
export const NOT_ZOD_ISSUE = "invalid";

export function issuesOf(error: unknown): ZodIssueLite[] {
  if (error instanceof z.ZodError) {
    return error.issues.map((i) => {
      const bound = i.code === "too_small" ? i.minimum : i.code === "too_big" ? i.maximum : undefined;
      return {
        path: i.path.map(String),
        code: i.code,
        message: i.message,
        ...(i.code === "too_small" || i.code === "too_big" ? { origin: i.origin } : {}),
        ...(bound === undefined ? {} : { limit: Number(bound) }),
      };
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return [{ path: [], code: NOT_ZOD_ISSUE, message }];
}

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

// --- The staff directory: teachers picked by name (F-POOL-05, ADR-068) ---

/**
 * `GET /pools/:id/candidates?q=` and `GET /courses/:id/staff/candidates?q=`:
 * a few letters of a name or an address.
 */
export const TeacherCandidateQuery = z.object({ q: z.string().trim().max(100).default("") });
export type TeacherCandidateQuery = z.infer<typeof TeacherCandidateQuery>;

/**
 * A teacher or admin account that holds no seat on the pool or the course
 * yet: what the picker of a share sheet or of the course's staff offers.
 */
export const TeacherCandidate = z.object({
  userId: z.uuid(),
  email: z.string(),
  givenName: z.string(),
  familyName: z.string(),
});
export type TeacherCandidate = z.infer<typeof TeacherCandidate>;

export const TeacherCandidates = z.array(TeacherCandidate);
export type TeacherCandidates = z.infer<typeof TeacherCandidates>;
