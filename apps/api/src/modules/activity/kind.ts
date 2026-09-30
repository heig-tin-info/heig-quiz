/**
 * What every kind of activity offers the rest of the platform (ADR-035 §2–3).
 *
 * THIN on purpose: an interface that the module owning a kind implements,
 * not a shared table nor a registry in the style of the question types. Two
 * kinds share too little behaviour to pay for more: each keeps its own
 * tables, state machine and routes, and meets the others only where a page
 * lists them together.
 *
 * A member lands with the first task that calls it through `KINDS`
 * (`docs/merge/09-tasks.md`, M1-03 "As delivered"): the student's cards with
 * M5-01, the gradebook entries with M5-03, the deadlines with M3-05. A method
 * that takes a classroom id is reached only after the route has loaded the
 * classroom (`staffAccess` or `readableClassroom`, invariant 6).
 */
import type { ActivityKindName, ActivitySummary } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import type { Caller } from "../guards.js";

/** The member of the union a kind lists. */
export type SummaryOf<K extends ActivityKindName> = Extract<ActivitySummary, { kind: K }>;

export interface ActivityKind<K extends ActivityKindName> {
  readonly kind: K;

  /**
   * The Activities section: what the caller manages in their own name,
   * across their classrooms (an admin sees their own, not the platform's).
   * The scope is the kind's access predicate for `caller`, loaded, never
   * filtered afterwards (invariant 6).
   */
  listForTeacher(db: Db, caller: Caller, now: Date): Promise<SummaryOf<K>[]>;
}
