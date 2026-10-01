/**
 * The `project` module's payloads (F-PROJ, spec 05 §5.11,
 * docs/merge/03-github-projects.md §3.3). Written by merge task M3-01 with the
 * tables (`apps/api/src/db/project.ts`); the routes that serve them land with
 * M3-02 (lifecycle), M3-05 (checkpoints), M3-08 (scores, release) and M3-09
 * (the student's side). The payloads a later task alone can shape — the
 * staff's project page (`ProjectDetail`, M3-08), the groups (`GroupsPayload`,
 * M3-15), the student's project view (M3-09) — are written by that task.
 *
 * Words (docs/merge/07-incompatibilities.md §7.4): a project (never an
 * "assignment"), a **score** is points out of a maximum and a **grade** the
 * Swiss 1–6, a **review checkpoint** (never a "milestone"), the **review**
 * slot (heig-classroom's "LLM"), a **release** (heig-classroom's "validate
 * the grades"). heig-classroom's words survive only on GitHub's wire (I16).
 *
 * Every state is a closed value the web words through `t()` (invariant 1):
 * the API never sends a sentence. The `as const` lists are the database's
 * enums too (`db/project.ts`), so the two cannot drift.
 */
import { z } from "zod";

import { PROJECT_SCALE_KINDS } from "@quiz/domain";

// ---------------------------------------------------------- closed values

/** F-PROJ-03: `draft` → `published` → `locked` (at the deadline). */
export const PROJECT_STATES = ["draft", "published", "locked"] as const;
export const ProjectState = z.enum(PROJECT_STATES);
export type ProjectState = z.infer<typeof ProjectState>;

/** F-PROJ-02: one commit per branch after the hand-out overlay, or the history as it is. */
export const SOURCE_STRATEGIES = ["squash", "whole"] as const;
/** F-PROJ-09: a ruleset that blocks pushes, or one empty commit of the App per branch. */
export const DEADLINE_STRATEGIES = ["lock", "commit"] as const;
/** F-PROJ-01: `none` — no score shown and no review dispatched. */
export const PROJECT_GRADING_MODES = ["auto", "none"] as const;
/** F-PROJ-03: publish by hand (now), or by the ticker at the start. */
export const PUBLISH_MODES = ["manual", "scheduled"] as const;

/** A repository's provisioning (F-PROJ-05): `error` is retried by the student. */
export const PROVISION_STATUSES = ["pending", "ok", "error"] as const;
export const ProvisionStatus = z.enum(PROVISION_STATUSES);
export type ProvisionStatus = z.infer<typeof ProvisionStatus>;

/** The student's invitation to their repository (F-PROJ-07). */
export const INVITATION_STATUSES = ["none", "pending", "accepted"] as const;
export const InvitationStatus = z.enum(INVITATION_STATUSES);
export type InvitationStatus = z.infer<typeof InvitationStatus>;

/** Pass / fail of a repository without `grading.yml` (F-PROJ-10). */
export const CI_STATUSES = ["none", "pending", "pass", "fail"] as const;
export const CiStatus = z.enum(CI_STATUSES);
export type CiStatus = z.infer<typeof CiStatus>;

/** The sync pull request of a repository (F-PROJ-12): one at most. */
export const SYNC_PR_STATES = ["open", "merged", "closed"] as const;

/**
 * Why a run has a score or none (F-PROJ-10, `extractScore` of
 * `@quiz/domain`): `multiple` — several `GRADE` annotations, no score.
 */
export const SCORE_PARSE_STATUSES = ["ok", "no_annotation", "malformed", "multiple", "fallback"] as const;
export const ScoreParseStatus = z.enum(SCORE_PARSE_STATUSES);
export type ScoreParseStatus = z.infer<typeof ScoreParseStatus>;

/**
 * What triggered a run: a push (`ci`, the indicative score) or the final
 * review dispatched after the freeze (`review`, heig-classroom's `llm`; the
 * import maps it). A `review` run never enters the selection of the
 * current score: it fills the repository's review slot (F-PROJ-11).
 */
export const SCORE_RUN_KINDS = ["ci", "review"] as const;
export const ScoreRunKind = z.enum(SCORE_RUN_KINDS);
export type ScoreRunKind = z.infer<typeof ScoreRunKind>;

/**
 * The App's own commits on a student repository, never a student's work:
 * a protected-file restore (`revert`), a deadline commit, a sync, and the
 * review workflow's own commit (`grader`).
 */
export const BOT_COMMIT_KINDS = ["revert", "deadline", "sync", "grader"] as const;

/**
 * A review dispatch (`grade_dispatches`): the final review after the freeze
 * (`deadline`, `grade-final` on the wire) or a review checkpoint
 * (`checkpoint`, `grade-milestone` on the wire, I16; heig-classroom's
 * `milestone`, which the import maps).
 */
export const REVIEW_DISPATCH_TRIGGERS = ["deadline", "checkpoint"] as const;

// ---------------------------------------------------------- grading scale

/**
 * A project's grading scale (F-PROJ-14, D05, spec 06 no. 49), stored in
 * `projects.grading_scale`. Its own type: an evaluation's `GradingScale`
 * stays linear only (ADR-052). `score_is_grade` reads a score out of 6 as
 * the grade, and falls back to the linear scale for any other maximum
 * (`projectGrade` of `@quiz/domain`).
 */
export const ProjectGradingScale = z.object({
  kind: z.enum(PROJECT_SCALE_KINDS),
  rounding: z.enum(["nearest", "up", "down"]).default("nearest"),
});
export type ProjectGradingScale = z.infer<typeof ProjectGradingScale>;

export const defaultProjectGradingScale = (): ProjectGradingScale =>
  ProjectGradingScale.parse({ kind: "linear" });

// ---------------------------------------------------------- staff writes

/** Manual publication's duration: 15 minutes to 400 days (heig-classroom's bounds). */
const DurationMinutes = z.number().int().min(15).max(400 * 1440);
const GraceMinutes = z.number().int().min(0).max(1440);
/** Advisory: exceeding it warns, never blocks (F-PROJ-06). */
const GroupMaxSize = z.number().int().min(1).max(50);
const ProtectedFiles = z.array(z.string().min(1).max(300)).max(100);

/**
 * `POST /app/api/classrooms/:id/projects` (F-PROJ-01). The source is a
 * repository NAME of the classroom's organization (`422 source_not_found`
 * otherwise); the branches default to its default branch. Scheduled: both
 * dates, the deadline after the start, no duration. Manual: a deadline date
 * or a duration, exactly one.
 */
export const ProjectCreate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    sourceRepo: z.string().min(1).max(200),
    publishMode: z.enum(PUBLISH_MODES).default("manual"),
    startAt: z.iso.datetime().optional(),
    deadlineAt: z.iso.datetime().optional(),
    durationMinutes: DurationMinutes.optional(),
    graceMinutes: GraceMinutes.default(30),
    sourceStrategy: z.enum(SOURCE_STRATEGIES).default("squash"),
    deadlineStrategy: z.enum(DEADLINE_STRATEGIES).default("lock"),
    gradingMode: z.enum(PROJECT_GRADING_MODES).default("auto"),
    gradingScale: ProjectGradingScale.optional(),
    branches: z.array(z.string().min(1)).min(1).max(10).optional(),
    protectedFiles: ProtectedFiles.default([]),
    groupMode: z.boolean().default(false),
    groupMaxSize: GroupMaxSize.nullable().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.publishMode === "scheduled") {
      if (b.startAt === undefined || b.deadlineAt === undefined) {
        ctx.addIssue({ code: "custom", path: ["startAt"], message: "scheduled_needs_dates" });
      } else if (Date.parse(b.deadlineAt) <= Date.parse(b.startAt)) {
        ctx.addIssue({ code: "custom", path: ["deadlineAt"], message: "deadline_before_start" });
      }
      if (b.durationMinutes !== undefined) {
        ctx.addIssue({ code: "custom", path: ["durationMinutes"], message: "duration_needs_manual" });
      }
    } else if ((b.deadlineAt === undefined) === (b.durationMinutes === undefined)) {
      ctx.addIssue({ code: "custom", path: ["deadlineAt"], message: "deadline_or_duration" });
    }
  });
export type ProjectCreate = z.infer<typeof ProjectCreate>;

/**
 * `PATCH /app/api/projects/:pid` (F-PROJ-03). What a published project may
 * still change, and the `409`s of the rest, are the handler's (M3-02): the
 * schema only says what is well-formed. Never empty.
 */
export const ProjectPatch = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    publishMode: z.enum(PUBLISH_MODES).optional(),
    startAt: z.iso.datetime().optional(),
    deadlineAt: z.iso.datetime().optional(),
    durationMinutes: DurationMinutes.nullable().optional(),
    graceMinutes: GraceMinutes.optional(),
    deadlineStrategy: z.enum(DEADLINE_STRATEGIES).optional(),
    gradingMode: z.enum(PROJECT_GRADING_MODES).optional(),
    gradingScale: ProjectGradingScale.optional(),
    protectedFiles: ProtectedFiles.optional(),
    groupMode: z.boolean().optional(),
    groupMaxSize: GroupMaxSize.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing_to_update" });
export type ProjectPatch = z.infer<typeof ProjectPatch>;

/**
 * A review checkpoint (F-PROJ-11): a name the repository's `criteria.yml`
 * tags its criteria with, and a date — absolute, or `offsetDays` before
 * the deadline (J−3), re-resolved while it has not been dispatched.
 */
export const ReviewCheckpoint = z.object({
  id: z.uuid(),
  name: z.string(),
  dueAt: z.iso.datetime(),
  /** J−n relative to the deadline; null for an absolute date. */
  offsetDays: z.number().int().nullable(),
  dispatchedAt: z.iso.datetime().nullable(),
});
export type ReviewCheckpoint = z.infer<typeof ReviewCheckpoint>;

/**
 * Its creation: a date or an offset, exactly one. The name is shell- and
 * YAML-friendly (it is the argument of `score grade --milestone`); an offset
 * is strictly before the deadline, so a checkpoint never races the final
 * review.
 */
export const ReviewCheckpointCreate = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/),
    dueAt: z.iso.datetime().optional(),
    offsetDays: z.number().int().min(-365).max(-1).optional(),
  })
  .refine((b) => (b.dueAt === undefined) !== (b.offsetDays === undefined), {
    message: "date_or_offset",
  });
export type ReviewCheckpointCreate = z.infer<typeof ReviewCheckpointCreate>;

/**
 * `PATCH /app/api/projects/:pid/repos/:rid/score` (F-PROJ-14): the
 * teacher's score of a repository, after the definitive freeze (`409
 * not_frozen` before). `points: null` clears it.
 */
export const ScoreOverride = z.strictObject({
  points: z.number().min(0).max(1000).nullable(),
  comment: z.string().max(2000).nullable().optional(),
});
export type ScoreOverride = z.infer<typeof ScoreOverride>;

// ---------------------------------------------------------- scores

/** One run's score as the staff read it (F-PROJ-10, F-PROJ-13). */
export const ScoreView = z.object({
  points: z.number().nullable(),
  max: z.number().nullable(),
  testsPassed: z.number().int().nullable(),
  testsTotal: z.number().int().nullable(),
  parseStatus: ScoreParseStatus,
  conclusion: z.string(),
  sha: z.string(),
  branch: z.string(),
  kind: ScoreRunKind,
  afterDeadline: z.boolean(),
  completedAt: z.iso.datetime(),
});
export type ScoreView = z.infer<typeof ScoreView>;

export const ScoreRun = ScoreView.extend({
  id: z.uuid(),
  workflowRunId: z.number().int(),
  runAttempt: z.number().int(),
});
export type ScoreRun = z.infer<typeof ScoreRun>;

/**
 * `GET /app/api/projects/:pid/repos/:rid/runs` (staff): a repository's
 * runs, newest first, and which of them fill its three slots.
 */
export const ScoreRunList = z.object({
  currentRunId: z.uuid().nullable(),
  frozenRunId: z.uuid().nullable(),
  reviewRunId: z.uuid().nullable(),
  runs: z.array(ScoreRun),
});
export type ScoreRunList = z.infer<typeof ScoreRunList>;

// ---------------------------------------------------------- activities

/**
 * A project as the staff's Activities section lists it (ADR-035 §2, the
 * `project` member of `ActivitySummary`). Never an archived one (F-PROJ-16).
 */
export const ProjectActivitySummary = z.object({
  kind: z.literal("project"),
  id: z.uuid(),
  title: z.string(),
  state: ProjectState,
  classroom: z.object({ id: z.uuid(), name: z.string(), courseCode: z.string() }),
  startAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
});
export type ProjectActivitySummary = z.infer<typeof ProjectActivitySummary>;

/**
 * Where a project stands for the student (F-PROJ-04): to accept (or not
 * yet open, which `startAt` tells), in progress once accepted, locked after
 * the deadline.
 */
export const StudentProjectStatus = z.enum(["to_accept", "in_progress", "locked"]);
export type StudentProjectStatus = z.infer<typeof StudentProjectStatus>;

/**
 * A published project on the student's Activities (F-PROJ-04, the
 * `project` member of `StudentActivityCard`). The student payload: never a
 * draft, never the source or distribution repository, nothing of another
 * student (N-SEC-20). `repoFullName` is the student's own repository (or
 * their group's) once it exists. Its score is the project's student view's
 * (M3-09), not the card's.
 */
export const StudentProjectCard = z.object({
  kind: z.literal("project"),
  id: z.uuid(),
  title: z.string(),
  classroomId: z.uuid(),
  classroomName: z.string(),
  courseCode: z.string(),
  startAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  status: StudentProjectStatus,
  repoFullName: z.string().nullable(),
});
export type StudentProjectCard = z.infer<typeof StudentProjectCard>;

// ---------------------------------------------------------- refusals

/**
 * The error codes of the project routes (03 §3.3), worded by the web app.
 * `github_not_linked`, `github_account_stale` and `app_not_installed` are
 * the GitHub substrate's, repeated here because Accept answers them.
 */
export const PROJECT_ERRORS = [
  "github_not_linked",
  "github_account_stale",
  "app_not_installed",
  "provision_in_progress",
  "no_group",
  "unassigned_students",
  "has_repo",
  "revoke_failed",
  "not_frozen",
  "strategy_frozen",
  "publish_mode_frozen",
  "source_not_found",
  "distribution_failed",
  "duplicate_slug",
] as const;
export type ProjectError = (typeof PROJECT_ERRORS)[number];
