/**
 * The `gradebook` module's payloads (F-GBOOK, D06, ADR-074; merge task
 * M5-03a): one table per classroom — a column per evaluation or project, a
 * row per claimed student seat — and its two readers.
 *
 * - The STAFF table (`GradebookStaff`), on the course's `staffAccess`: every
 *   cell with its source, the staff marks, every student's mean, and the
 *   class means (per column and overall, #545) — never in a student payload.
 * - The STUDENT's own cells (`GradebookStudent`), the gradebook's student
 *   exit (spec 05 §5.7): only what F-RES-04 lets a student read, no source,
 *   no teacher's comment, no mark of an unreleased column, no unreleased
 *   grade, and the mean only when the teacher publishes it — the key is
 *   absent from the JSON otherwise.
 *
 * A cell is a `grade` (the Swiss grade to the tenth), an `absent` (the
 * school's a1.0: 1.0 marked as an absence, which counts as 1.0) or `empty`.
 * A column is addressed by its activity: `kind` + `activityId`.
 */
import { z } from "zod";

import { FINAL_SCORE_SOURCES, GRADEBOOK_COLUMN_KINDS, GRADEBOOK_MARK_KINDS, WEIGHT_MAX, WEIGHT_MIN } from "@quiz/domain";

/** What a column is of; a poll never has one. */
export const GradebookColumnKind = z.enum(GRADEBOOK_COLUMN_KINDS);
export type GradebookColumnKind = z.infer<typeof GradebookColumnKind>;

/** How a column's activity is addressed in a route: an evaluation or a project. */
export const GradebookActivityKind = z.enum(["evaluation", "project"]);
export type GradebookActivityKind = z.infer<typeof GradebookActivityKind>;

export const GradebookMarkKind = z.enum(GRADEBOOK_MARK_KINDS);
export type GradebookMarkKind = z.infer<typeof GradebookMarkKind>;

/** A column's weight: a whole percentage, 0 to 100, relative to the others' (#545). */
export const GradebookWeight = z.number().int().min(WEIGHT_MIN).max(WEIGHT_MAX);

/** `…/gradebook/columns/:kind/:activityId`, under a classroom. */
export const GradebookColumnParams = z.object({
  id: z.uuid(),
  kind: GradebookActivityKind,
  activityId: z.uuid(),
});
export type GradebookColumnParams = z.infer<typeof GradebookColumnParams>;

/** `…/gradebook/columns/:kind/:activityId/marks/:eid`: a mark on a roster line. */
export const GradebookMarkParams = GradebookColumnParams.extend({ eid: z.uuid() });
export type GradebookMarkParams = z.infer<typeof GradebookMarkParams>;

/** `PATCH …/gradebook`: the classroom's settings (F-GBOOK-06). */
export const GradebookSettingsPatch = z.object({ meanPublished: z.boolean() });
export type GradebookSettingsPatch = z.infer<typeof GradebookSettingsPatch>;

/** `PATCH …/gradebook/columns/:kind/:activityId` (F-GBOOK-06): at least one field. */
export const GradebookColumnPatch = z
  .object({
    weight: GradebookWeight,
    counts: z.boolean(),
    position: z.number().int().min(0).max(1000).nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "nothing to change");
export type GradebookColumnPatch = z.infer<typeof GradebookColumnPatch>;

/**
 * `PUT …/gradebook/columns/:kind/:activityId/marks/:eid`: an absence, or the
 * teacher's own score out of a maximum. `override: true` is required when a
 * grade lies beneath the mark (`409 grade_exists` otherwise): replacing a
 * real grade is deliberate. The comment is staff-only.
 */
export const GradebookMarkPut = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("absent"),
    comment: z.string().trim().max(2000).nullish(),
    override: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("score"),
    points: z.number().min(0).max(100000),
    max: z.number().positive().max(100000),
    comment: z.string().trim().max(2000).nullish(),
    override: z.boolean().optional(),
  }),
]);
export type GradebookMarkPut = z.infer<typeof GradebookMarkPut>;

/** The gradebook routes' refusals, worded by the web app (invariant 1). */
export const GRADEBOOK_REFUSALS = [
  /** A write on an archived classroom. */
  "classroom_archived",
  /** A mark over a real grade without `override: true`. */
  "grade_exists",
  /** A score above its maximum. */
  "score_above_max",
  /** A mark over a real grade of a released column: an owner's, as the release is (ADR-068). */
  "owner_required",
] as const;
export const GradebookErrorCode = z.enum(GRADEBOOK_REFUSALS);
export type GradebookErrorCode = z.infer<typeof GradebookErrorCode>;

// ---------------------------------------------------------------- the staff's table

/** One column: an evaluation or a project of the classroom, with its settings. */
export const GradebookColumn = z.object({
  kind: GradebookActivityKind,
  activityId: z.uuid(),
  /** What the column is of: exam, exercise or project. */
  mode: GradebookColumnKind,
  title: z.string(),
  /** The activity's date (evaluation: opening or creation; project: start), the default order. */
  date: z.iso.datetime(),
  /** The results are released (an evaluation's release, a project's release): only then do the grades show and count. */
  released: z.boolean(),
  /** A whole percentage, 0 to 100. */
  weight: GradebookWeight,
  counts: z.boolean(),
  position: z.number().int().nullable(),
  /** The class's mean of the column: its released cells' grades (an absence 1.0, an empty cell left out); null before the release or with none. */
  classMean: z.number().nullable(),
});
export type GradebookColumn = z.infer<typeof GradebookColumn>;

/** A staff mark as the staff read it. */
export const GradebookMark = z.object({
  kind: GradebookMarkKind,
  points: z.number().nullable(),
  max: z.number().nullable(),
  comment: z.string().nullable(),
  /** The teacher who set it, by name. */
  setBy: z.string().nullable(),
  setAt: z.iso.datetime(),
});
export type GradebookMark = z.infer<typeof GradebookMark>;

/** Where a staff cell comes from (I42): a stored mark, a derived absence, the evaluation's results, or a project's final score. */
export const GradebookSource = z.enum(["mark", "derived", "results", ...FINAL_SCORE_SOURCES]);
export type GradebookSource = z.infer<typeof GradebookSource>;

/**
 * One cell as the staff read it. In an unreleased column the activity's
 * grades are not shown (`kind: "empty"`) unless a staff mark stands there.
 * `hasGrade`: a real grade lies beneath the cell (so a mark over it needs
 * `override: true`).
 */
export const GradebookStaffCell = z.object({
  kind: z.enum(["grade", "absent", "empty"]),
  grade: z.number().nullable(),
  points: z.number().nullable(),
  /** What the points are out of. */
  max: z.number().nullable(),
  source: GradebookSource.nullable(),
  /** A project's grade moved since its release (F-GBOOK-03, F-PROJ-14); an evaluation's is `modifiedAfterRelease` of its results. */
  changedAfterRelease: z.boolean(),
  hasGrade: z.boolean(),
  mark: GradebookMark.nullable(),
});
export type GradebookStaffCell = z.infer<typeof GradebookStaffCell>;

export const GradebookStaffRow = z.object({
  enrollmentId: z.uuid(),
  email: z.string(),
  nom: z.string(),
  prenom: z.string(),
  /** By activity id; one cell per column. */
  cells: z.record(z.string(), GradebookStaffCell),
  /** The weighted mean of the released, counted columns the student has a grade in; null with none. */
  mean: z.number().nullable(),
});
export type GradebookStaffRow = z.infer<typeof GradebookStaffRow>;

/** `GET /app/api/classrooms/:id/gradebook`: the staff's table. */
export const GradebookStaff = z.object({
  classroomId: z.uuid(),
  archived: z.boolean(),
  /** Whether students read their own mean (F-GBOOK-05). */
  meanPublished: z.boolean(),
  columns: z.array(GradebookColumn),
  /** One row per claimed student seat, by last then first name; never a staff seat (ADR-018 §3). */
  rows: z.array(GradebookStaffRow),
  /** The class's overall mean: the mean of the students' means, a student with none left out; null with none. */
  classMean: z.number().nullable(),
});
export type GradebookStaff = z.infer<typeof GradebookStaff>;

// ---------------------------------------------------------------- the student's cells

/**
 * One cell as the student reads it (F-RES-04): `grade` and `absent` carry a
 * grade; `withheld` — released under the feedback policy `none`, the grade
 * is not shared; `indicative` — not released, the feedback page already shows
 * the points: `points` and `max`, no grade; `empty` — nothing to show.
 * Never the source, the teacher's comment, nor a mark of an unreleased column.
 */
export const GradebookStudentCell = z.object({
  kind: z.enum(["grade", "absent", "empty", "withheld", "indicative"]),
  grade: z.number().nullable(),
  points: z.number().nullable(),
  max: z.number().nullable(),
});
export type GradebookStudentCell = z.infer<typeof GradebookStudentCell>;

/** A column as a student reads it: `weight` and `counts` only once the mean is published. */
export const GradebookStudentColumn = z.object({
  kind: GradebookActivityKind,
  activityId: z.uuid(),
  mode: GradebookColumnKind,
  title: z.string(),
  date: z.iso.datetime(),
  weight: GradebookWeight.optional(),
  counts: z.boolean().optional(),
});
export type GradebookStudentColumn = z.infer<typeof GradebookStudentColumn>;

/**
 * `GET /app/api/student/classrooms/:id/gradebook`: the caller's own cells
 * of the classroom. `mean` is present only when the teacher publishes it
 * (null: no grade yet); the key does not exist otherwise.
 */
export const GradebookStudent = z.object({
  classroomId: z.uuid(),
  columns: z.array(GradebookStudentColumn),
  /** By activity id. */
  cells: z.record(z.string(), GradebookStudentCell),
  mean: z.number().nullable().optional(),
});
export type GradebookStudent = z.infer<typeof GradebookStudent>;
