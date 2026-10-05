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
 * M5-01 (the home too since M3-09a), the gradebook entries with M5-03, the
 * deadlines with M3-05. A method that takes a classroom id is reached only
 * after the route has loaded the classroom (`staffAccess` or
 * `readableClassroom`, invariant 6).
 */
import type {
  ActivityKindName,
  ActivitySummary,
  GradebookColumnKind,
  GradebookSource,
  GradebookStudentCell,
  StudentActivities,
  StudentActivityCard,
} from "@quiz/contracts";
import type { CellOutcome, StudentActivityGroup } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import type { Caller } from "../guards.js";

/** The member of the union a kind lists. */
export type SummaryOf<K extends ActivityKindName> = Extract<ActivitySummary, { kind: K }>;

/** The student's card of a kind. */
export type CardOf<K extends ActivityKindName> = Extract<StudentActivityCard, { kind: K }>;

/** The groups of the student's Activities, holding the cards of one kind. */
export type StudentCardsOf<K extends ActivityKindName> = Pick<StudentActivities, "polls"> & {
  [G in StudentActivityGroup]: CardOf<K>[];
};

/** Whose Activities, and how far they reach. */
export interface StudentScope {
  /** One classroom (the classroom page, loaded through `readableClassroom`); every classroom of the caller's seats otherwise (the home). */
  classroomId?: string | undefined;
  /**
   * A confined session (`seb`, `kiosk`; ADR-027, ADR-051): opened to sit one
   * exam, it reads its evaluations and nothing that leads outside — no
   * project, whose card links to GitHub (N-SEC-20). The classroom page
   * never reaches here confined (`readableClassroom` refuses it).
   */
  confined: boolean;
}

/** A claimed student seat of the classroom: the roster line and its account. */
export interface GradebookSeat {
  enrollmentId: string;
  userId: string;
}

/**
 * What a column of the gradebook says of its activity (F-GBOOK-01), before
 * the gradebook's own settings and marks: the facts, and `markGrade`, how
 * the activity's OWN scale turns a teacher's score out of a maximum into a
 * grade (an evaluation's, a project's: never one scale for both).
 */
export interface GradebookEntryFacts {
  kind: ActivityKindName;
  activityId: string;
  mode: GradebookColumnKind;
  title: string;
  /** Opening (evaluation) or start (project): the default order of the columns. */
  date: Date;
  /** The results are released (an evaluation's release, a project's). */
  released: boolean;
  markGrade(points: number, max: number): number;
}

/** What the activity itself gives a seat, under any staff mark: read, never recomputed. */
export interface GradebookBeneath {
  outcome: CellOutcome;
  points: number | null;
  /** What the points are out of. */
  max: number | null;
  source: GradebookSource | null;
  /** The grade moved since the release (F-GBOOK-03). */
  changedAfterRelease: boolean;
  /** A real grade lies here: a mark over it needs an explicit override. */
  hasGrade: boolean;
}

/** One column as the staff read it: the facts, and the cells of the seats. */
export interface GradebookEntry extends GradebookEntryFacts {
  /** The seats' LIVE cells: a column follows its activity (F-GBOOK-03). */
  staffCells(db: Db, seats: readonly GradebookSeat[]): Promise<Map<string, GradebookBeneath>>;
}

/**
 * One column as a student reads it: the facts and the caller's own cell,
 * already through the student view of the kind (F-RES-04, N-SEC-20).
 * `markShown`: a staff mark may show here, the column being released and
 * the feedback policy not `none`.
 */
export interface StudentGradebookEntry extends GradebookEntryFacts {
  cell: GradebookStudentCell;
  markShown: boolean;
}

export interface ActivityKind<K extends ActivityKindName> {
  readonly kind: K;

  /**
   * The Activities section: what the caller manages in their own name,
   * across their classrooms (an admin sees their own, not the platform's).
   * The scope is the kind's access predicate for `caller`, loaded, never
   * filtered afterwards (invariant 6).
   */
  listForTeacher(db: Db, caller: Caller, now: Date): Promise<SummaryOf<K>[]>;

  /**
   * The student's Activities (F-ORG-14, F-ORG-15): the caller's own cards,
   * drawn through their claimed seats — in every classroom for the home, in
   * `scope.classroomId` alone for the classroom page (so a staff member
   * without a seat there gets none). The student payload whoever asks: no
   * draft, nothing of another student.
   */
  studentCards(db: Db, caller: Caller, now: Date, scope: StudentScope): Promise<StudentCardsOf<K>>;

  /**
   * The gradebook's columns of this kind in a classroom (M5-03a, F-GBOOK):
   * what the activity says of itself and, per column, the staff's cells. The
   * staff payload, so the classroom is loaded through `staffAccess` first.
   */
  gradebookEntries(db: Db, classroomId: string): Promise<GradebookEntry[]>;

  /**
   * The caller's own columns and cells of this kind in a classroom (M5-03a,
   * F-GBOOK-05): only what the kind's student view lets a student read. The
   * classroom is loaded through `readableClassroom` first, and `seat` is the
   * caller's claimed student seat.
   */
  studentGradebookEntries(
    db: Db,
    userId: string,
    seat: GradebookSeat,
    classroomId: string,
    now: Date,
  ): Promise<StudentGradebookEntry[]>;
}
