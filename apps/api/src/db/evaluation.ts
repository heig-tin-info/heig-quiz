/**
 * Evaluations and their items (PLAN-MVP §3.3). Owned by the `evaluation`
 * module; `live`, `grading` and `results` read them by join and never write
 * them (CLAUDE.md, Conventions).
 *
 * Two properties live in the schema rather than in the service:
 *   - `evaluation_items` freezes ONE published question version
 *     (`question_version_id`), so the wording a student saw can never change
 *     under them (F-EVAL-03);
 *   - `evaluations_live_idx` is the partial index the ticker scans every
 *     second: only `lobby`, `running` and `paused` rows are candidates for an
 *     automatic transition, and there are never many of them;
 *   - `evaluations_running_poll_code_uq` makes a poll's session code unique
 *     among the running polls, so the code draw needs no check-then-insert;
 *   - `evaluations_home_ck` says where an evaluation lives, in exactly one
 *     place: a classroom; a course, for an evaluation template (ADR-031); or
 *     — an anonymous poll, and nothing else — with its owner;
 *   - `evaluations_template_ck` keeps everything of a RUN off a template:
 *     no date, no access code, no IP, never out of `draft`, never a poll;
 *   - `evaluations_access_code_poll_ck`: `access_code` is a poll's session
 *     code (ADR-014) and nothing else — an exam or an exercise has no access
 *     code since ADR-053.
 *
 * "An anonymous poll" is ONE predicate, {@link ownedPollSql} (and its row
 * twin {@link isOwnedPoll}): since templates, `classroom_id is null` alone
 * no longer names it, and every site that meant "owned poll" goes through it.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  type AnyPgColumn,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { classrooms, courses } from "./org.js";
import { questionVersions } from "./pool.js";

export const evaluations = pgTable(
  "evaluations",
  {
    id: uuid("id").primaryKey(),
    /**
     * The classroom the evaluation belongs to. Null for ONE shape only, an
     * anonymous poll (ADR-014, addendum 2026-09-27): it belongs to no class,
     * and `created_by` is then its owner — `evaluations_home_ck` below.
     */
    classroomId: uuid("classroom_id").references(() => classrooms.id, { onDelete: "cascade" }),
    /**
     * Set on an evaluation TEMPLATE and on nothing else (ADR-031): its
     * presence is what makes the row a template, kept at the course level
     * and never run. `evaluations_home_ck` and `evaluations_template_ck`.
     */
    courseId: uuid("course_id").references(() => courses.id, { onDelete: "cascade" }),
    /** A template's revision, 1 at creation; null on every other row. */
    revision: integer("revision"),
    /**
     * The template an instance was made from, and at which revision. Deleting
     * the template nulls the link and leaves the instance running.
     */
    originTemplateId: uuid("origin_template_id").references((): AnyPgColumn => evaluations.id, {
      onDelete: "set null",
    }),
    originRevision: integer("origin_revision"),
    title: text("title").notNull(),
    /** `poll` is stored but every route refuses it in the MVP (decision D7). */
    mode: text("mode", { enum: ["exam", "exercise", "poll"] }).notNull(),
    /** The single state column of §5.1; `graded` is derived, never stored (D6). */
    state: text("state", {
      enum: [
        "draft",
        "scheduled",
        "lobby",
        "running",
        "paused",
        "closed",
        "grading",
        "released",
      ],
    })
      .notNull()
      .default("draft"),
    /** Validated by `EvaluationSettings` in `@quiz/contracts`, never read raw. */
    settings: jsonb("settings").notNull(),
    gradingScale: jsonb("grading_scale").notNull(),
    feedbackPolicy: jsonb("feedback_policy").notNull(),
    /**
     * How a multiple-answer MCQ of this evaluation is scored, for every
     * question that says `inherit` (docs/04 §4.4). Seeded from the creator's
     * preference (`users.mcq_policy`) and then owned by the evaluation: the
     * grading pass hands it to the type through `GradeContext.defaults`.
     */
    mcqPolicy: text("mcq_policy", {
      enum: ["all_or_nothing", "true_false", "discordance", "symmetric", "ripkey"],
    })
      .notNull()
      .default("all_or_nothing"),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    /**
     * How far the live controls (an extension to all, a resume after a pause)
     * have moved `closes_at` since the teacher last set the timing, in whole
     * seconds. `closes_at - opens_at - closes_at_shift_s` is the ANNOUNCED
     * window, the base of the accommodation in `deadline` timing (decision D8,
     * #253, `announcedWindowS`). Written by `extendClosesAt` only; a timing
     * edit from the configuration puts it back to 0.
     */
    closesAtShiftS: integer("closes_at_shift_s").notNull().default(0),
    durationS: integer("duration_s"),
    /** A poll's session code (ADR-014); null on any other evaluation (ADR-053). */
    accessCode: text("access_code"),
    /** Prefix list (F-EVAL-12); empty = no restriction. */
    ipAllowlist: text("ip_allowlist").array().notNull().default(sql`'{}'::text[]`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /**
     * When the students were told that this exercise was scheduled
     * (`activity_scheduled`, ADR-030 §c and §h): at most once in its life,
     * whatever reschedules or trips back to draft follow. Claimed by one
     * conditional UPDATE (`announce.ts`); null for an exam, a poll, and an
     * exercise never scheduled. Never copied, never cleared.
     */
    scheduledAnnouncedAt: timestamp("scheduled_announced_at", { withTimezone: true }),
    /**
     * When the staff were told that the automatic grading of this closed
     * evaluation is finished (`grading_ready`, ADR-030 §c; #286): at most
     * once per completed grid. Claimed by one conditional UPDATE
     * (`claimGradingReady`) by whichever grading path — the pass or a runner
     * job — finds the grid complete first; cleared by a re-grade, which
     * empties cells, and by a reopening to draft.
     */
    gradingReadyAt: timestamp("grading_ready_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    /**
     * When the teacher published the correction of this exercise while it
     * still ran (ADR-050): the class debrief opens, and a student's own
     * correction follows the feedback policy as if released. Set once by the
     * server's clock (`setCorrectionPublished`), never cleared but by a
     * return to draft; null on every exam and poll.
     */
    correctionPublishedAt: timestamp("correction_published_at", { withTimezone: true }),
    /** Frozen grades at release (ADR-012); written by WP6, never recomputed. */
    releasedGrades: jsonb("released_grades"),
    modifiedAfterRelease: boolean("modified_after_release").notNull().default(false),
    /**
     * Who created the evaluation. For a poll with no classroom it is also
     * the OWNER, the one person (with the admins) who reaches it
     * (`findOwnedPoll` in `modules/guards.ts`).
     */
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("evaluations_classroom_idx").on(t.classroomId, t.state),
    index("evaluations_live_idx")
      .on(t.state)
      .where(sql`${t.state} in ('scheduled','lobby','running','paused')`),
    // Every QR scan of a poll looks its evaluation up by code (`byCode`).
    index("evaluations_access_code_idx")
      .on(t.accessCode)
      .where(sql`${t.accessCode} is not null`),
    // Two running polls never share a session code: `createPoll` draws a
    // code and lets this index refuse a collision, then draws again.
    uniqueIndex("evaluations_running_poll_code_uq")
      .on(t.accessCode)
      .where(sql`${t.mode} = 'poll' and ${t.state} = 'running'`),
    // Every evaluation has exactly one home: a classroom; a course, for a
    // template (ADR-031); or — for an anonymous poll only — an owner. An exam
    // or an exercise with neither, a row with both, or a classroom-less poll
    // nobody owns, cannot be written.
    check(
      "evaluations_home_ck",
      sql`(${t.classroomId} is not null and ${t.courseId} is null) or (${t.classroomId} is null and ${t.courseId} is not null) or (${t.classroomId} is null and ${t.courseId} is null and ${t.mode} = 'poll' and ${t.createdBy} is not null)`,
    ),
    // A template carries nothing of a run, whatever path writes it.
    check(
      "evaluations_template_ck",
      sql`${t.courseId} is null or (${t.opensAt} is null and ${t.closesAt} is null and ${t.accessCode} is null and cardinality(${t.ipAllowlist}) = 0 and ${t.state} = 'draft' and ${t.mode} <> 'poll' and ${t.revision} is not null and ${t.originTemplateId} is null)`,
    ),
    // `access_code` is a poll's session code, and only that (ADR-053).
    check("evaluations_access_code_poll_ck", sql`${t.accessCode} is null or ${t.mode} = 'poll'`),
    index("evaluations_owned_poll_idx")
      .on(t.createdBy, t.createdAt)
      // The one "owned poll" predicate, so the index and every query agree.
      .where(ownedPollSql()),
    index("evaluations_template_idx")
      .on(t.courseId, t.createdAt)
      .where(sql`${t.courseId} is not null`),
  ],
);

/**
 * THE "anonymous poll" predicate (ADR-014 addendum 2026-09-27, ADR-031), on
 * a query that has `evaluations` in scope: no classroom, no course, a poll.
 * Qualified by hand, so it survives being dropped into a correlated
 * subquery (see `qualified` in `modules/guards.ts`).
 */
export function ownedPollSql(): SQL {
  return sql`("evaluations"."classroom_id" is null and "evaluations"."course_id" is null and "evaluations"."mode" = 'poll')`;
}

/** {@link ownedPollSql} on a loaded row. */
export function isOwnedPoll(row: {
  classroomId: string | null;
  courseId: string | null;
  mode: string;
}): boolean {
  return row.classroomId === null && row.courseId === null && row.mode === "poll";
}

/**
 * One question of an evaluation, frozen on a published version.
 *
 * `(evaluation_id, position)` is unique and NOT deferrable: a reorder moves
 * every row out of the way first (`position += 1000`) and then back, in one
 * transaction — see `reorderItems` in the service. That works on any
 * PostgreSQL and on PGlite, which a deferrable constraint generated by
 * drizzle-kit would not.
 */
export const evaluationItems = pgTable(
  "evaluation_items",
  {
    id: uuid("id").primaryKey(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id),
    points: numeric("points", { precision: 6, scale: 2, mode: "number" }).notNull(),
    /** F-EVAL-07: navigation cannot go back past a milestone item. */
    milestone: boolean("milestone").notNull().default(false),
    /**
     * ADR-052: a bonus item's points are left out of the evaluation's total
     * (`evaluationTotal`), and its score is floored at 0 (`itemPoints`).
     */
    bonus: boolean("bonus").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("evaluation_items_position_uq").on(t.evaluationId, t.position),
    index("evaluation_items_version_idx").on(t.questionVersionId),
  ],
);
