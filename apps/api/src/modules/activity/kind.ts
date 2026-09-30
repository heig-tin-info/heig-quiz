/**
 * What every kind of activity offers the rest of the platform (ADR-035 §2–3).
 *
 * THIN on purpose: an interface that the module owning a kind implements,
 * not a shared table nor a registry in the style of the question types. Two
 * kinds share too little behaviour to pay for more: each keeps its own
 * tables, state machine and routes, and meets the others only where a page
 * lists them together (the Activities section, a classroom, a student's
 * classroom page, later the gradebook).
 *
 * The lists that mix kinds return the `ActivitySummary` union of
 * `@quiz/contracts`. What a student sees and what a gradebook reads differ
 * too much between kinds to share a shape yet: each kind names its own
 * (`Cards`, `Entry`), and the page that shows them holds the union.
 */
import type { ActivityKindName, ActivitySummary } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import type { TickTask } from "../../ticker.js";
import type { Caller } from "../guards.js";

/** The member of the union a kind lists. */
export type SummaryOf<K extends ActivityKindName> = Extract<ActivitySummary, { kind: K }>;

export interface ActivityKind<K extends ActivityKindName, Cards, Entry> {
  readonly kind: K;

  /**
   * The Activities section: what the caller manages in their own name,
   * across their classrooms (an admin sees their own, not the platform's).
   * The scope is the kind's access predicate for `caller`, loaded, never
   * filtered afterwards (invariant 6).
   */
  listForTeacher(db: Db, caller: Caller, now: Date): Promise<SummaryOf<K>[]>;

  /**
   * One classroom's activities of this kind, for its staff. The route has
   * loaded the classroom through `staffAccess` already: the classroom is the
   * whole scope.
   */
  listForClassroom(db: Db, classroomId: string, now: Date): Promise<SummaryOf<K>[]>;

  /**
   * What a student sees of this kind in one classroom where they hold a
   * claimed seat, which the caller has established (the student's own
   * enrollment, 404 otherwise). Only through the kind's student view: no
   * draft, nothing of another student (invariant 4).
   */
  studentCards(db: Db, userId: string, classroomId: string, now: Date): Promise<Cards>;

  /**
   * The student's released results of this kind in one classroom, as the
   * kind already exposes them. What counts and how (D05, D06) belongs to the
   * gradebook, not here.
   */
  gradebookEntries(db: Db, userId: string, classroomId: string): Promise<Entry[]>;

  /**
   * The tasks this kind runs on THE ticker (ADR-006) to close its deadlines
   * — a project's sweeps (M3-05). Absent for a kind whose deadlines the
   * ticker's own tasks close already, as the evaluations' (`LIVE_TASKS`).
   */
  readonly deadlines?: readonly TickTask[];
}
