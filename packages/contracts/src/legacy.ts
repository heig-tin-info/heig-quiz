/**
 * The legacy URL resolver's schemas (merge task M8-02, docs/merge/06 §6.6):
 * `GET /legacy/classroom/*`, where Caddy sends what a human clicked on
 * `classroom.chevallier.io`. The rule of each old path lives in
 * `@quiz/domain` (`legacyRule`); the route answers a 302 to a Quiz path, a
 * 410 for a dead API, or the 404 of a missing entity.
 */
import { z } from "zod";

/** The wildcard: the old path after `/legacy/classroom`, a query string excluded. */
export const LegacyClassroomParams = z.object({ "*": z.string().max(2048) });
export type LegacyClassroomParams = z.infer<typeof LegacyClassroomParams>;

/** The body of a 410: the old surface is gone, and Quiz is where to go. */
export const LegacyGone = z.object({ error: z.literal("moved"), to: z.string() });
export type LegacyGone = z.infer<typeof LegacyGone>;
