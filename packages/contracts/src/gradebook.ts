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
 * A course may name **components of the mean** (ADR-131): with one, a
 * column counts only inside its component, and the mean has two levels. The
 * staff read them on the table and edit them on the course
 * (`GradebookComponents`); a student reads the name of the component of each
 * of their columns that counts, and its weight and mean only with the
 * published mean.
 *
 * A cell is a `grade` (the Swiss grade to the tenth), an `absent` (the
 * school's a1.0: 1.0 marked as an absence, which counts as 1.0), `excused`
 * (a staff mark: named, and in no mean, #969) or `empty`.
 * A column is addressed by its activity: `kind` + `activityId`.
 */
import { z } from "zod";

import {
  COMPONENT_NAME_MAX,
  FINAL_SCORE_SOURCES,
  GRADEBOOK_COLUMN_KINDS,
  GRADEBOOK_MARK_KINDS,
  WEIGHT_DEFAULT,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from "@quiz/domain";

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

const ColumnSettingsFields = z.object({
  weight: GradebookWeight,
  counts: z.boolean(),
  position: z.number().int().min(0).max(1000).nullable(),
  componentId: z.uuid().nullable(),
});
/** A patch names at least one field. */
const notEmpty = (patch: object) => Object.keys(patch).length > 0;

/**
 * `PATCH …/gradebook/columns/:kind/:activityId` (F-GBOOK-06): at least one
 * field. `componentId`: a component of the classroom's course (`404
 * component` otherwise), or null to take the column out of any (ADR-131).
 * Open from the draft on: the settings of an activity not listed yet are
 * stored, and its column takes them when it appears (ADR-131).
 */
export const GradebookColumnPatch = ColumnSettingsFields.partial().refine(notEmpty, "nothing to change");
export type GradebookColumnPatch = z.infer<typeof GradebookColumnPatch>;

/**
 * `PATCH /templates/:id/gradebook` (ADR-131 §15): the settings an evaluation
 * template's instances inherit — a column's without its position, which
 * orders a classroom's gradebook and a template has none (strict: a
 * position is refused, not dropped). `componentId`: a
 * component of the template's course (`404 component` otherwise).
 */
export const GradebookTemplateColumnPatch = ColumnSettingsFields.omit({ position: true })
  .partial()
  .strict()
  .refine(notEmpty, "nothing to change");
export type GradebookTemplateColumnPatch = z.infer<typeof GradebookTemplateColumnPatch>;

/**
 * `PUT …/gradebook/columns/:kind/:activityId/marks/:eid`: an absence, an
 * excuse (the cell counts in no mean, #969), or the teacher's own score out
 * of a maximum. `override: true` is required when a grade lies beneath the
 * mark (`409 grade_exists` otherwise): replacing a real grade is deliberate.
 * The comment is staff-only.
 */
export const GradebookMarkPut = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["absent", "excused"]),
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

// ---------------------------------------------------------------- the course's components (ADR-131)

/** A component's name: trimmed, 1 to 40 characters; unique in its course whatever its case (`409 component_name_taken`). */
export const GradebookComponentName = z.string().trim().min(1).max(COMPONENT_NAME_MAX);

/** `…/courses/:id/gradebook/components/:componentId`. */
export const GradebookComponentParams = z.object({ id: z.uuid(), componentId: z.uuid() });
export type GradebookComponentParams = z.infer<typeof GradebookComponentParams>;

/** `POST /courses/:id/gradebook/components` (the course's owner): a name, and a weight, 100 % by default. */
export const GradebookComponentCreate = z.object({
  name: GradebookComponentName,
  weight: GradebookWeight.default(WEIGHT_DEFAULT),
});
export type GradebookComponentCreate = z.infer<typeof GradebookComponentCreate>;

/** `PATCH …/components/:componentId` (the course's owner): a new name, a new weight, or both. */
export const GradebookComponentPatch = z
  .object({ name: GradebookComponentName, weight: GradebookWeight })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "nothing to change");
export type GradebookComponentPatch = z.infer<typeof GradebookComponentPatch>;

/** One component as the course's staff edit it; `inUse`: a column of some classroom of the course is in it, a draft's included, so it cannot be deleted. */
export const GradebookCourseComponent = z.object({
  id: z.uuid(),
  name: z.string(),
  /** A whole percentage, 0 to 100, relative to the other components'. */
  weight: GradebookWeight,
  inUse: z.boolean(),
});
export type GradebookCourseComponent = z.infer<typeof GradebookCourseComponent>;

/** `GET /courses/:id/gradebook/components`, and every write's answer: the course's components in creation order. */
export const GradebookComponents = z.array(GradebookCourseComponent);
export type GradebookComponents = z.infer<typeof GradebookComponents>;

/**
 * `GET …/gradebook/columns/:kind/:activityId` (F-GBOOK-06, ADR-131): one
 * column's settings as an activity's settings edit them, from the draft on —
 * stored, or its mode's defaults — with the components of the course to put
 * it in, whether the column is released, and whether the classroom's mean is
 * published: together, whether a change moves what the students read.
 * `GET /templates/:id/gradebook` answers the same for an evaluation template
 * (ADR-131 §15), `released` and `meanPublished` false: no student reads it.
 */
export const GradebookColumnSettings = z.object({
  weight: GradebookWeight,
  counts: z.boolean(),
  componentId: z.uuid().nullable(),
  /** False for a draft. */
  released: z.boolean(),
  meanPublished: z.boolean(),
  /** The course's components, as their list reads them (staff data). */
  components: GradebookComponents,
});
export type GradebookColumnSettings = z.infer<typeof GradebookColumnSettings>;

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
  /** Another component of the course has that name, whatever its case (ADR-131). */
  "component_name_taken",
  /** A column of some classroom of the course is in the component: it cannot be deleted (ADR-131). */
  "component_in_use",
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
  /** The stored flag; whether the column counts toward a mean is `countsInMean` of it and `componentId` (ADR-131). */
  counts: z.boolean(),
  position: z.number().int().nullable(),
  /** The component of the mean the column is in (ADR-131), null for none. */
  componentId: z.uuid().nullable(),
  /** The class's mean of the column: its released cells' grades (an absence 1.0, an empty or excused cell left out); null before the release or with none. */
  classMean: z.number().nullable(),
  /**
   * ADR-139: an exam's OPEN contestations, the class's (a teacher's test
   * walk left out), or a project's (§13, on its live repositories); 0 for
   * any other column. Staff only: no student column carries it.
   */
  openContestations: z.number().int().nonnegative(),
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
  kind: z.enum(["grade", "absent", "excused", "empty"]),
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
  /**
   * A teacher's staff seat (ADR-018, amended 2026-11-17): its cells are
   * computed as a student's, and it stays out of every class mean and of
   * the CSV; a mark on it is refused. The table lists these rows after the
   * students'.
   */
  staff: z.boolean(),
  /** By activity id; one cell per column. */
  cells: z.record(z.string(), GradebookStaffCell),
  /** The weighted mean of the released, counted columns the student has a grade in — of the component means once the course has components (ADR-131); null with none. */
  mean: z.number().nullable(),
  /** Each component's mean for the student, by component id, to the tenth; null with none; empty without a component. */
  componentMeans: z.record(z.string(), z.number().nullable()),
});
export type GradebookStaffRow = z.infer<typeof GradebookStaffRow>;

/** A component of the mean as the staff's table reads it (ADR-131). */
export const GradebookStaffComponent = z.object({
  id: z.uuid(),
  name: z.string(),
  weight: GradebookWeight,
  /** The plain mean of the students' means of the component, a student with none left out; null with none. Staff only. */
  classMean: z.number().nullable(),
});
export type GradebookStaffComponent = z.infer<typeof GradebookStaffComponent>;

/** `GET /app/api/classrooms/:id/gradebook`: the staff's table. */
export const GradebookStaff = z.object({
  classroomId: z.uuid(),
  archived: z.boolean(),
  /** Whether students read their own mean (F-GBOOK-05). */
  meanPublished: z.boolean(),
  /** Every component of the course, in creation order (ADR-131); none: the one-level mean. */
  components: z.array(GradebookStaffComponent),
  columns: z.array(GradebookColumn),
  /** One row per claimed student seat, by last then first name, then each claimed staff seat (`staff`), out of every class mean. */
  rows: z.array(GradebookStaffRow),
  /** The class's overall mean: the mean of the students' means, a student with none left out; null with none. */
  classMean: z.number().nullable(),
});
export type GradebookStaff = z.infer<typeof GradebookStaff>;

// ---------------------------------------------------------------- the student's cells

/**
 * One cell as the student reads it (F-RES-04): `grade` and `absent` carry a
 * grade; `excused` — the teacher excused the student, the cell counts in
 * no mean (#969); `withheld` — released under the feedback policy `none`, the grade
 * is not shared; `indicative` — not released, the feedback page already shows
 * the points: `points` and `max`, no grade; `empty` — nothing to show.
 * Never the source, the teacher's comment, nor a mark of an unreleased column.
 */
export const GradebookStudentCell = z.object({
  kind: z.enum(["grade", "absent", "excused", "empty", "withheld", "indicative"]),
  grade: z.number().nullable(),
  points: z.number().nullable(),
  max: z.number().nullable(),
});
export type GradebookStudentCell = z.infer<typeof GradebookStudentCell>;

/**
 * A column as a student reads it: whether it counts toward the mean always
 * (the flag alone, so the tab draws practice apart; ADR-074, amendment of
 * 2026-10-13) — `countsInMean`, so a column in no component of a course that
 * has some does not (ADR-131) — and the component it counts in, by id, null
 * when it does not count or the course has none; its `weight` only once the
 * mean is published.
 */
export const GradebookStudentColumn = z.object({
  kind: GradebookActivityKind,
  activityId: z.uuid(),
  mode: GradebookColumnKind,
  title: z.string(),
  date: z.iso.datetime(),
  weight: GradebookWeight.optional(),
  counts: z.boolean(),
  componentId: z.uuid().nullable(),
});
export type GradebookStudentColumn = z.infer<typeof GradebookStudentColumn>;

/**
 * A component of the mean as a student reads it (ADR-131): its name always;
 * its `weight` and the student's own `mean` (null: none yet) only once the
 * mean is published — the keys do not exist otherwise. Never its class mean.
 */
export const GradebookStudentComponent = z.object({
  id: z.uuid(),
  name: z.string(),
  weight: GradebookWeight.optional(),
  mean: z.number().nullable().optional(),
});
export type GradebookStudentComponent = z.infer<typeof GradebookStudentComponent>;

/**
 * `GET /app/api/student/classrooms/:id/gradebook`: the caller's own cells
 * of the classroom. `mean` is present only when the teacher publishes it
 * (null: no grade yet); the key does not exist otherwise. `components`: only
 * those that hold one of the caller's columns that count, in creation order.
 */
export const GradebookStudent = z.object({
  classroomId: z.uuid(),
  components: z.array(GradebookStudentComponent),
  columns: z.array(GradebookStudentColumn),
  /** By activity id. */
  cells: z.record(z.string(), GradebookStudentCell),
  mean: z.number().nullable().optional(),
});
export type GradebookStudent = z.infer<typeof GradebookStudent>;
