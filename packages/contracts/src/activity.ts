/**
 * Activities (ADR-035 §2): what a classroom hosts for its students. Each kind
 * is owned by its module, keeps its own tables and state machine, and meets
 * the others only here, in a discriminated union on `kind`. There is no
 * shared table and no registry: a new kind adds a member to
 * {@link ActivityKindName} and one to {@link ActivitySummary}, and every
 * `switch` over them that forgets it stops compiling.
 *
 * Today one kind, `evaluation` (exam, exercise, and poll as its `mode`,
 * ADR-014). A poll is a mode of it, never a kind of its own.
 */
import { z } from "zod";

import { EvaluationMode, EvaluationState } from "./evaluation.js";

/** The kinds of activity. `project` joins with the projects (M3-02). */
export const ActivityKindName = z.enum(["evaluation"]);
export type ActivityKindName = z.infer<typeof ActivityKindName>;

/**
 * An evaluation as the Activities section lists it (issue #190): one of a
 * classroom the caller teaches, or one of their own anonymous polls. What it
 * needs to tell "live" (`isLiveNow` in `@quiz/domain`: `state`, `takeHome`,
 * `opensAt`, `updatedAt`) and to place the row in a week (`opensAt`,
 * `startedAt`, `closesAt`), and nothing more: the counts of the classroom
 * list cost a query each and the section does not show them. No template
 * ever: it is never run.
 */
export const EvaluationActivitySummary = z.object({
  kind: z.literal("evaluation"),
  id: z.uuid(),
  title: z.string(),
  mode: EvaluationMode,
  state: EvaluationState,
  /** Null for an anonymous poll, which belongs to no classroom (ADR-014). */
  classroom: z
    .object({ id: z.uuid(), name: z.string(), courseCode: z.string() })
    .nullable(),
  /** An exercise without a waiting room (`isTakeHome`): never "live". */
  takeHome: z.boolean(),
  opensAt: z.iso.datetime().nullable(),
  closesAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type EvaluationActivitySummary = z.infer<typeof EvaluationActivitySummary>;

/** One row of `GET /activities`, whatever its kind. */
export const ActivitySummary = z.discriminatedUnion("kind", [EvaluationActivitySummary]);
export type ActivitySummary = z.infer<typeof ActivitySummary>;

/** The kinds and the union's members are one list: `true` or a compile error. */
type SameKinds = [ActivityKindName] extends [ActivitySummary["kind"]]
  ? [ActivitySummary["kind"]] extends [ActivityKindName]
    ? true
    : false
  : false;
const SAME_KINDS: SameKinds = true;
void SAME_KINDS;

export const ActivityList = z.array(ActivitySummary);
export type ActivityList = z.infer<typeof ActivityList>;
