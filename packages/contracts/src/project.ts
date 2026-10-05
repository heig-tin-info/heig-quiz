/**
 * The `project` module's payloads (F-PROJ, spec 05 §5.11,
 * docs/merge/03-github-projects.md §3.3). Written by merge task M3-01 with the
 * tables (`apps/api/src/db/project.ts`): the closed values the schema shares,
 * the grading scale, and the project members of the activity unions. Each
 * route's bodies and payloads land with the task that serves them: create
 * and patch with M3-02, the refusals of Accept with M3-03, the review
 * checkpoints with M3-05, the grade runs and the teacher's score with M3-08,
 * the student's project view with M3-09, the groups with M3-15.
 *
 * Words (docs/merge/07-incompatibilities.md §7.4): a project (never an
 * "assignment"), a **score** is points out of a maximum and a **grade** the
 * Swiss 1–6, a **review checkpoint** (never a "milestone"), the **review**
 * slot (heig-classroom's "LLM"), a **release** (heig-classroom's "validate
 * the grades"). heig-classroom's words survive only on GitHub's wire (I16).
 *
 * The `as const` lists are the database's enums (`db/project.ts`), so the
 * two cannot drift; each becomes a zod enum with the payload that first
 * carries it.
 */
import { z } from "zod";

import {
  FINAL_SCORE_SOURCES,
  PROJECT_PATCH_FIELDS,
  PROJECT_PRIMARY_ACTIONS,
  PROJECT_REVIEW_REASONS,
  PROJECT_REVIEW_STATUSES,
  PROJECT_SCALE_KINDS,
  STUDENT_PROJECT_STATUSES,
  slugify,
} from "@quiz/domain";

import { Rounding } from "./evaluation.js";

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

export const SourceStrategy = z.enum(SOURCE_STRATEGIES);
export const DeadlineStrategy = z.enum(DEADLINE_STRATEGIES);
export const ProjectGradingMode = z.enum(PROJECT_GRADING_MODES);
export const PublishMode = z.enum(PUBLISH_MODES);

/**
 * The defaults of a new project (F-PROJ-01), defined ONCE: the columns'
 * `.default()` in `db/project.ts` and {@link ProjectCreate}'s read them.
 */
export const PROJECT_DEFAULTS = {
  graceMinutes: 30,
  sourceStrategy: "squash",
  deadlineStrategy: "lock",
  gradingMode: "auto",
  publishMode: "manual",
} as const satisfies {
  graceMinutes: number;
  sourceStrategy: (typeof SOURCE_STRATEGIES)[number];
  deadlineStrategy: (typeof DEADLINE_STRATEGIES)[number];
  gradingMode: (typeof PROJECT_GRADING_MODES)[number];
  publishMode: (typeof PUBLISH_MODES)[number];
};

/** A repository's provisioning (F-PROJ-05): `error` is retried by the student. */
export const PROVISION_STATUSES = ["pending", "ok", "error"] as const;
/** The student's invitation to their repository (F-PROJ-07). */
export const INVITATION_STATUSES = ["none", "pending", "accepted"] as const;
/** Pass / fail of a repository without `grading.yml` (F-PROJ-10). */
export const CI_STATUSES = ["none", "pending", "pass", "fail"] as const;
/** The sync pull request of a repository (F-PROJ-12): one at most. */
export const SYNC_PR_STATES = ["open", "merged", "closed"] as const;

/**
 * Why a grade run has a score or none (F-PROJ-10, `extractScore` of
 * `@quiz/domain`): `multiple` — several `GRADE` annotations, no score.
 */
export const GRADE_RUN_PARSE_STATUSES = ["ok", "no_annotation", "malformed", "multiple", "fallback"] as const;

/**
 * What triggered a grade run: a push (`ci`, the indicative score) or the
 * final review dispatched after the freeze (`review`, heig-classroom's
 * `llm`; the import maps it). A `review` run never enters the selection of
 * the current score: it fills the repository's review slot (F-PROJ-11).
 */
export const GRADE_RUN_KINDS = ["ci", "review"] as const;

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
  rounding: Rounding.default("nearest"),
});
export type ProjectGradingScale = z.infer<typeof ProjectGradingScale>;

export const defaultProjectGradingScale = (): ProjectGradingScale =>
  ProjectGradingScale.parse({ kind: "linear" });

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

/** The status word of a student's project (`studentProjectStatus` of `@quiz/domain`). */
export const StudentProjectStatus = z.enum(STUDENT_PROJECT_STATUSES);
export type StudentProjectStatus = z.infer<typeof StudentProjectStatus>;

/**
 * A published project on the student's Activities — the home and the
 * classroom page (F-PROJ-04, F-ORG-14; the `project` member of
 * `StudentActivityCard`; merge task M3-09a). The student payload: never a
 * draft nor an archived project, never the source or distribution
 * repository, nothing of another student (N-SEC-20). `status`: to accept
 * (or not yet open, which `startAt` tells), in progress once the repository
 * exists, locked after the student's deadline, released once the scores
 * are out. `deadlineAt` is the student's EFFECTIVE deadline: their own
 * extension, else the project's. `githubLinked`, `repoUrl` and
 * `invitation` are the four states of the row's button
 * (`docs/merge/05-web.md` §5.3, drawn by M3-13): not linked, linked
 * without a repository, invitation pending, ready — `repoFullName` and
 * `repoUrl` name the student's own repository once it exists and is not
 * deleted, `invitation` their invitation on it (F-PROJ-07). The scores are
 * the project's student view's ({@link StudentProject}), not the card's.
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
  invitation: z.enum(["pending", "accepted"]).nullable(),
  githubLinked: z.boolean(),
  repoFullName: z.string().nullable(),
  repoUrl: z.url().nullable(),
});
export type StudentProjectCard = z.infer<typeof StudentProjectCard>;

// ---------------------------------------------------------- the lifecycle (M3-02)

/**
 * The files the creation form pre-checks as protected when the source holds
 * them (F-PROJ-01); unchecking `grading.yml` warns.
 */
export const PROTECTED_FILE_SUGGESTIONS = ["criteria.yml", "README.md", ".github/workflows/grading.yml"] as const;

/** A repository's name in the organization: a name, never a path nor an owner. */
export const RepoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/)
  .refine((name) => name !== "." && name !== "..", "not a repository name");

/**
 * A branch to hand out: what `git check-ref-format --branch` accepts, minus
 * what could read as an option (a leading `-`).
 */
export const BranchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine(
    (b) =>
      !b.startsWith("-") &&
      !b.endsWith(".lock") &&
      !b.includes("..") &&
      b.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".")),
    "not a branch name",
  );

/** A protected file: a path relative to the repository's root, never out of it. */
export const ProtectedPath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) =>
      !p.includes("\\") &&
      !p.includes("\0") &&
      p.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "not a relative path",
  );

/** A project's name: something must be left of it as a slug (`<slug>-<login>`). */
const ProjectName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) => slugify(name) !== "", "the name has no letter nor digit");

/** Manual publication: the deadline is publication + 15 minutes … 400 days. */
const DurationMinutes = z.number().int().min(15).max(400 * 1440);
/** Minutes after the deadline before the freeze is definitive (F-PROJ-11). */
const GraceMinutes = z.number().int().min(0).max(1440);
const Instant = z.iso.datetime({ offset: true });

/**
 * `POST /app/api/classrooms/:id/projects` (F-PROJ-01). heig-classroom's
 * rules, without the work mode (F-PROJ-19): a scheduled publication needs an
 * absolute start and deadline; a manual one a deadline OR a duration counted
 * from the publication, and starts when it is published. The source, its
 * branches (by default its default branch; the first becomes the students'
 * default branch) and the source strategy are fixed here, for good
 * (F-PROJ-03 as amended 2026-10-02). `gradingScale` defaults to the linear
 * scale (D05). A group project may name its classroom's group set now or
 * later while a draft (`groupSetId`, ADR-070 §7; `422 unknown_group_set`
 * for a set of another classroom); only in group mode.
 */
export const ProjectCreate = z
  .strictObject({
    name: ProjectName,
    sourceRepo: RepoName,
    branches: z.array(BranchName).min(1).max(10).optional(),
    publishMode: PublishMode.default(PROJECT_DEFAULTS.publishMode),
    startAt: Instant.optional(),
    deadlineAt: Instant.optional(),
    durationMinutes: DurationMinutes.optional(),
    graceMinutes: GraceMinutes.default(PROJECT_DEFAULTS.graceMinutes),
    sourceStrategy: SourceStrategy.default(PROJECT_DEFAULTS.sourceStrategy),
    deadlineStrategy: DeadlineStrategy.default(PROJECT_DEFAULTS.deadlineStrategy),
    gradingMode: ProjectGradingMode.default(PROJECT_DEFAULTS.gradingMode),
    gradingScale: ProjectGradingScale.optional(),
    protectedFiles: z.array(ProtectedPath).max(50).default([]),
    groupMode: z.boolean().default(false),
    groupSetId: z.uuid().nullable().optional(),
  })
  .superRefine((b, ctx) => {
    // `patchProject` refuses the same on the row (a patch may send either alone).
    if (b.groupSetId && !b.groupMode) {
      ctx.addIssue({ code: "custom", path: ["groupSetId"], message: "A group set only applies to a group project" });
    }
    if (b.branches && new Set(b.branches).size !== b.branches.length) {
      ctx.addIssue({ code: "custom", path: ["branches"], message: "A branch is listed twice" });
    }
    if (b.publishMode === "scheduled") {
      if (!b.startAt || !b.deadlineAt) {
        ctx.addIssue({ code: "custom", path: ["startAt"], message: "A scheduled publication needs a start and a deadline" });
      } else if (Date.parse(b.deadlineAt) <= Date.parse(b.startAt)) {
        ctx.addIssue({ code: "custom", path: ["deadlineAt"], message: "The deadline must come after the start" });
      }
      if (b.durationMinutes !== undefined) {
        ctx.addIssue({ code: "custom", path: ["durationMinutes"], message: "A duration only applies to a manual publication" });
      }
    } else {
      if ((b.deadlineAt === undefined) === (b.durationMinutes === undefined)) {
        ctx.addIssue({ code: "custom", path: ["deadlineAt"], message: "A manual publication needs a deadline or a duration, not both" });
      }
      if (b.startAt !== undefined) {
        ctx.addIssue({ code: "custom", path: ["startAt"], message: "A manual publication starts when it is published" });
      }
    }
  });
export type ProjectCreate = z.infer<typeof ProjectCreate>;

/**
 * `PATCH /app/api/projects/:pid`: any of the fields of
 * `PROJECT_PATCH_FIELDS` (`@quiz/domain`), at least one. What may change in
 * which state is `projectFieldRefusal`; sending a field's current value is
 * never refused (the form posts the whole of it). `durationMinutes: null`
 * turns a manual deadline into an absolute one. `groupSetId` names the
 * classroom's group set the project follows, which makes or replaces its
 * copy (ADR-070 §4); only in group mode (400 otherwise), and `groupMode:
 * false` clears it and deletes the copy.
 */
export const ProjectPatch = z
  .strictObject({
    name: ProjectName.optional(),
    publishMode: PublishMode.optional(),
    startAt: Instant.optional(),
    deadlineAt: Instant.optional(),
    durationMinutes: DurationMinutes.nullable().optional(),
    graceMinutes: GraceMinutes.optional(),
    deadlineStrategy: DeadlineStrategy.optional(),
    gradingMode: ProjectGradingMode.optional(),
    gradingScale: ProjectGradingScale.optional(),
    protectedFiles: z.array(ProtectedPath).max(50).optional(),
    groupMode: z.boolean().optional(),
    groupSetId: z.uuid().nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Nothing to update" });
export type ProjectPatch = z.infer<typeof ProjectPatch>;

/** The fields of {@link ProjectPatch}, as `ProjectSummary.editable` names them. */
export const ProjectPatchField = z.enum(PROJECT_PATCH_FIELDS);
export type ProjectPatchField = z.infer<typeof ProjectPatchField>;

/** `GET /app/api/classrooms/:id/projects?archived=1`: the archive instead of the active projects. */
export const ProjectListQuery = z.strictObject({ archived: z.literal("1").optional() });
export type ProjectListQuery = z.infer<typeof ProjectListQuery>;

/**
 * A project for its staff (`GET|PATCH /app/api/projects/:pid`, the create's
 * 201): every setting, the state, the source and distribution repositories
 * — the staff's only, never a student's (N-SEC-20) — and what may still
 * change (`editable`, `projectFieldRefusal`). `distribution` is null while
 * it is being built, or when its build was interrupted (delete the project
 * and create it again). `accepted`: at least one repository exists. A
 * manual draft's `startAt` and `deadlineAt` are provisional (its creation,
 * and the deadline or creation + duration): Publish sets them.
 */
export const ProjectSummary = z.object({
  id: z.uuid(),
  classroomId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  state: ProjectState,
  publishMode: PublishMode,
  startAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  durationMinutes: z.number().int().nullable(),
  graceMinutes: z.number().int(),
  sourceStrategy: SourceStrategy,
  deadlineStrategy: DeadlineStrategy,
  gradingMode: ProjectGradingMode,
  gradingScale: ProjectGradingScale,
  branches: z.array(z.string()),
  protectedFiles: z.array(z.string()),
  groupMode: z.boolean(),
  /** The group set a group project follows (ADR-070 §4); null when none is chosen yet. */
  groupSetId: z.uuid().nullable(),
  source: z.object({ fullName: z.string() }),
  distribution: z.object({ fullName: z.string() }).nullable(),
  deadlineAppliedAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  accepted: z.boolean(),
  editable: z.array(ProjectPatchField),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

/**
 * The refusals of the lifecycle, `{ error, message }`, worded by the web
 * app; their statuses are the API's (`modules/project/errors.ts`). The
 * cases a name does not tell:
 *   - `source_not_found` (422) — also a branch the source lacks (the body
 *     then names them, `branches`), a repository GitHub resolves into
 *     another organization, or one of the platform's distribution
 *     repositories;
 *   - `distribution_failed` (502) — the build failed: the row is gone,
 *     nothing was deleted on GitHub (ADR-062);
 *   - `distribution_missing` — a draft whose build is under way, or was
 *     interrupted, cannot be published;
 *   - `deadline_past` (422) — a deadline, or a repository's own deadline,
 *     at or before now; moving a deadline already applied to a later date
 *     is not refused: it reopens the project (F-PROJ-09, M3-05a);
 *   - `repo_unavailable` — a repository's lock, unlock or own deadline
 *     asked of a repository that is not provisioned, or was deleted on
 *     GitHub (M3-05a);
 *   - `unassigned_students` — the body names the claimed students in no
 *     group (`students`: enrollment id, nom, prenom, {@link ProjectUnassigned}),
 *     empty when the group project has no group at all;
 *   - `no_group_set` — publishing a group project that names no group set
 *     (ADR-070 §7); `unknown_group_set` (422) — a set that is not one of
 *     the project's classroom.
 * The staff's writes of M3-08b (F-PROJ-07, F-PROJ-08, F-PROJ-14):
 *   - `not_frozen` — a teacher's score before the repository's definitive
 *     freeze, or a release while a live repository is not frozen;
 *   - `to_verify` — a release while a repository's final score rests on a
 *     run to verify (F-PROJ-08; the body names them, `repos`): the
 *     teacher's score settles each;
 *   - `grading_none` — a teacher's score or a release under `grading_mode:
 *     none`;
 *   - `score_max_required` (422) — a score on a repository without a scored
 *     run must come with its maximum; `score_max_mismatch` (422) — a
 *     maximum given beside a scored run's that differs from it;
 *     `score_above_max` (422);
 *   - `invitation_not_pending` — a resend of an invitation that is not
 *     pending; `resend_too_soon` (429) — resent less than a minute ago;
 *     `invite_failed` (502) — GitHub failed the resend.
 * The response schemas of the refusals come with their first consumer
 * (M3-11).
 */
export const PROJECT_REFUSALS = [
  "not_connected",
  "app_not_installed",
  "source_not_found",
  "duplicate_slug",
  "distribution_failed",
  "distribution_missing",
  "deadline_past",
  "not_draft",
  "publish_mode_frozen",
  "strategy_frozen",
  "unassigned_students",
  "repo_unavailable",
  // ADR-070, M3-15a.
  "no_group_set",
  "unknown_group_set",
  // M3-08b.
  "not_frozen",
  "to_verify",
  "grading_none",
  "score_max_required",
  "score_max_mismatch",
  "score_above_max",
  "invitation_not_pending",
  "resend_too_soon",
  "invite_failed",
] as const;
export const ProjectErrorCode = z.enum(PROJECT_REFUSALS);
export type ProjectErrorCode = z.infer<typeof ProjectErrorCode>;

// ---------------------------------------------------------- the organization's repositories

/**
 * `GET /app/api/classrooms/:id/projects/sources`: the repositories of the
 * classroom's organization a project may hand out (M3-11's picker), the
 * most recently pushed first; archived ones and the distribution
 * repositories (`…-squashed`, `…-squashed-N`) left out.
 */
export const ProjectSourceRepo = z.object({
  name: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  pushedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ProjectSourceRepo = z.infer<typeof ProjectSourceRepo>;

export const ProjectSourceParams = z.object({ id: z.uuid(), repo: RepoName });
export type ProjectSourceParams = z.infer<typeof ProjectSourceParams>;

/**
 * `GET /app/api/classrooms/:id/projects/sources/:repo`: one source, its
 * branches, the tree of its default branch (capped: `truncated`), and the
 * {@link PROTECTED_FILE_SUGGESTIONS} it holds.
 */
export const ProjectSourceDetail = z.object({
  name: z.string(),
  defaultBranch: z.string(),
  branches: z.array(z.string()),
  tree: z.array(z.object({ path: z.string(), type: z.enum(["blob", "tree"]) })),
  truncated: z.boolean(),
  suggestedProtected: z.array(z.enum(PROTECTED_FILE_SUGGESTIONS)),
});
export type ProjectSourceDetail = z.infer<typeof ProjectSourceDetail>;

// ---------------------------------------------------------- the acceptance (M3-03)

export const ProvisionStatus = z.enum(PROVISION_STATUSES);
export type ProvisionStatus = z.infer<typeof ProvisionStatus>;
export const InvitationStatus = z.enum(INVITATION_STATUSES);
export type InvitationStatus = z.infer<typeof InvitationStatus>;

/**
 * `POST /app/api/student/projects/:id/accept` (F-PROJ-05): the student's OWN
 * repository — their group's in a group project (ADR-048 lot 2, M3-15b),
 * `invitationStatus` then THEIR invitation on it — and nothing else — never the source nor the distribution
 * repository (N-SEC-20). `fullName` is null until the repository exists;
 * `invitationStatus` is the student's invitation on it (F-PROJ-07). A second
 * Accept answers the same row; a repository deleted on GitHub is answered as
 * it stands, never made again.
 */
export const ProjectAcceptance = z.object({
  status: ProvisionStatus,
  fullName: z.string().nullable(),
  invitationStatus: InvitationStatus,
});
export type ProjectAcceptance = z.infer<typeof ProjectAcceptance>;

/**
 * The refusals of Accept, `{ error, message }` (statuses in the API's
 * `modules/project/errors.ts`). Every one but `provision_failed` (502, retry)
 * is a 409:
 *   - `not_started`, `deadline_passed` — judged on the project's dates and
 *     the server's clock, no grace;
 *   - `no_group` — a group project whose copy places the student in no
 *     group (M3-15b): the staff place them in the set;
 *   - `github_not_linked`; `github_account_stale` — the linked account was
 *     deleted, or GitHub refused to invite it (renamed away): relink;
 *   - `app_not_installed` — Quiz's App no longer acts on the project's
 *     organization; `distribution_missing` — nothing to hand out;
 *   - `provision_in_progress` — another Accept of the same repository is
 *     under way, or (M3-15b-2) the student's move out of their group waits
 *     for GitHub: try again in a moment;
 *   - `repo_name_taken` — `<slug>-<login>` names a repository of the
 *     organization this Accept did not make: nothing was done to it;
 *   - `provision_failed` — GitHub failed, or could not tell the account's
 *     login today: try again.
 */
export const PROJECT_ACCEPT_REFUSALS = [
  "not_started",
  "deadline_passed",
  "no_group",
  "github_not_linked",
  "github_account_stale",
  "app_not_installed",
  "distribution_missing",
  "provision_in_progress",
  "repo_name_taken",
  "provision_failed",
] as const;
export const ProjectAcceptErrorCode = z.enum(PROJECT_ACCEPT_REFUSALS);
export type ProjectAcceptErrorCode = z.infer<typeof ProjectAcceptErrorCode>;

// ---------------------------------------------------------- the lifecycle's refusal bodies (M3-11)

/**
 * The body of a lifecycle refusal (`ProjectError`, `modules/project/
 * errors.ts`): its code, the server's English `message` (for logs and API
 * clients; the web app words the code), and, for `source_not_found` on a
 * branch the source lacks, the `branches` it lacks. Read by the new project
 * form (M3-11), its first consumer.
 */
export const ProjectRefusal = z.object({
  error: ProjectErrorCode,
  message: z.string(),
  branches: z.array(z.string()).optional(),
});
export type ProjectRefusal = z.infer<typeof ProjectRefusal>;

// ---------------------------------------------------------- a repository's deadline and lock (M3-05a)

/** `/app/api/projects/:id/repos/:rid/…`: the project, and one of its repositories. */
export const ProjectRepoParams = z.object({ id: z.uuid(), rid: z.uuid() });
export type ProjectRepoParams = z.infer<typeof ProjectRepoParams>;

/**
 * `PUT /app/api/projects/:id/repos/:rid/deadline` (F-PROJ-09, D13 as amended
 * 2026-10-02): the repository's own deadline, an individual extension, or
 * null to follow the project's again. A date must lie ahead (`422
 * deadline_past`); moving it later on a repository whose deadline was
 * applied reopens that repository alone. The roster's extra time (F-ORG-07)
 * never applies to a project.
 */
export const ProjectRepoDeadline = z.strictObject({ deadlineAt: Instant.nullable() });
export type ProjectRepoDeadline = z.infer<typeof ProjectRepoDeadline>;

/**
 * One repository's deadline and lock, for its staff (the answer of the
 * repository's deadline, lock and unlock): `deadlineAt` its own deadline or
 * null, `effectiveDeadlineAt` the one that applies; `deadlineAppliedAt` the
 * provisional freeze, `frozenAt` the definitive one. `locked` is what GitHub
 * was last made to hold, `archived` when the lock fell back to archiving the
 * repository (a plan without rulesets, shown as degraded); `staffLock` the
 * staff's hand — true locked, false unlocked, null the deadline decides —
 * which a lock or an unlock just asked may not have reached GitHub yet.
 * `degraded` (H8, M3-08a): the lock fell back to archiving, or the
 * repository was provisioned without its protection ruleset.
 */
export const ProjectRepoDeadlineState = z.object({
  id: z.uuid(),
  fullName: z.string().nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  effectiveDeadlineAt: z.iso.datetime(),
  deadlineAppliedAt: z.iso.datetime().nullable(),
  frozenAt: z.iso.datetime().nullable(),
  locked: z.boolean(),
  archived: z.boolean(),
  staffLock: z.boolean().nullable(),
  degraded: z.boolean(),
});
export type ProjectRepoDeadlineState = z.infer<typeof ProjectRepoDeadlineState>;

// ---------------------------------------------------------- the staff's project page (M3-08a)

export const CiStatus = z.enum(CI_STATUSES);
export type CiStatus = z.infer<typeof CiStatus>;
export const GradeRunKind = z.enum(GRADE_RUN_KINDS);
export type GradeRunKind = z.infer<typeof GradeRunKind>;
export const GradeRunParseStatus = z.enum(GRADE_RUN_PARSE_STATUSES);
export type GradeRunParseStatus = z.infer<typeof GradeRunParseStatus>;

/**
 * One counted run of `grading.yml` (F-PROJ-10), for the staff: `points` and
 * `max` as the CI reported them (null without a score, `parseStatus` says
 * why; a `malformed` run keeps the reason in `parseDetail`). `afterDeadline`
 * — received after the repository's effective deadline, never the frozen
 * score; `toVerify` — ingested while the protected files were not restored,
 * or on a head whose protected files were (F-PROJ-08).
 */
export const GradeRunView = z.object({
  id: z.uuid(),
  workflowRunId: z.number().int(),
  runAttempt: z.number().int(),
  kind: GradeRunKind,
  conclusion: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  points: z.number().nullable(),
  max: z.number().nullable(),
  testsPassed: z.number().int().nullable(),
  testsTotal: z.number().int().nullable(),
  parseStatus: GradeRunParseStatus,
  parseDetail: z.string().nullable(),
  afterDeadline: z.boolean(),
  toVerify: z.boolean(),
  completedAt: z.iso.datetime(),
});
export type GradeRunView = z.infer<typeof GradeRunView>;

/** How many runs {@link GradeRunList} carries at most: the newest. */
export const GRADE_RUN_LIST_LIMIT = 100;

/**
 * `GET /app/api/projects/:id/repos/:rid/runs` (F-PROJ-13): a repository's
 * runs, the newest first ({@link GRADE_RUN_LIST_LIMIT} at most), and which
 * of them fill its three slots — the current score, the frozen one, the
 * final review's — by id (null: the slot is empty). Staff only.
 */
export const GradeRunList = z.object({
  currentGradeRunId: z.uuid().nullable(),
  frozenGradeRunId: z.uuid().nullable(),
  reviewGradeRunId: z.uuid().nullable(),
  runs: z.array(GradeRunView),
});
export type GradeRunList = z.infer<typeof GradeRunList>;

/** A score read as a Swiss grade by the project's scale; `fellBack` — `score_is_grade` asked, the maximum not 6. */
export const ProjectGradeView = z.object({ grade: z.number(), fellBack: z.boolean() });
export type ProjectGradeView = z.infer<typeof ProjectGradeView>;

/**
 * One of a repository's run slots: the run, its score, and its grade (null
 * without points or maximum). Its parse status and `to_verify` are the run
 * list's; the row's flags sum them up.
 */
export const ProjectSlotScore = z.object({
  runId: z.uuid(),
  points: z.number().nullable(),
  max: z.number().nullable(),
  grade: ProjectGradeView.nullable(),
});
export type ProjectSlotScore = z.infer<typeof ProjectSlotScore>;

/**
 * The final score (F-PROJ-14): the teacher's, else the review's, else the
 * frozen one — the current one while nothing is frozen (`resolveFinalScore`
 * of `@quiz/domain`); `source` names it (I42). A teacher's score carries
 * the maximum it was written with (M3-08b); `max` is null only for an
 * imported teacher score on a repository without a scored run. `toVerify`:
 * the run behind the score is to verify (F-PROJ-08) — the release waits for
 * the teacher's score to settle it; never for a teacher's score.
 */
export const ProjectFinalScore = z.object({
  points: z.number(),
  max: z.number().nullable(),
  source: z.enum(FINAL_SCORE_SOURCES),
  toVerify: z.boolean(),
  grade: ProjectGradeView.nullable(),
});
export type ProjectFinalScore = z.infer<typeof ProjectFinalScore>;

/**
 * What GitHub says of a repository now (F-PROJ-13), from the live-state
 * cache (one minute, served `stale` up to fifteen): the commit count and
 * the check runs of its head (any commit, the App's included). Null when it
 * could not be read in time, or under GitHub's rate limit: the stored state
 * stands alone.
 */
export const ProjectRepoLive = z.object({
  commitCount: z.number().int(),
  checksPassed: z.number().int().nullable(),
  checksTotal: z.number().int().nullable(),
  stale: z.boolean(),
});
export type ProjectRepoLive = z.infer<typeof ProjectRepoLive>;

export const ProjectReviewStatus = z.enum(PROJECT_REVIEW_STATUSES);
export type ProjectReviewStatus = z.infer<typeof ProjectReviewStatus>;
export const ProjectReviewReason = z.enum(PROJECT_REVIEW_REASONS);
export type ProjectReviewReason = z.infer<typeof ProjectReviewReason>;

/**
 * Where a repository's final review stands (F-PROJ-11, M3-05b; added by
 * M3-08b), from its `grade_dispatches` row (`trigger = deadline`) and its
 * review slot — `reviewState` of `@quiz/domain`:
 *   - `pending` — not frozen for good yet, or frozen and not yet asked;
 *   - `none` — no review will come: an ungraded project, or a freeze with
 *     no frozen run (`reason: no_frozen_run`);
 *   - `skipped` — frozen but degraded (`reason`: `archived` as its lock, or
 *     `protection_suspended`; re-enabling the protection makes it pending
 *     again);
 *   - `unconfirmed` — claimed, GitHub's acceptance never recorded: never
 *     sent again (a manual re-dispatch is a later option);
 *   - `asked` — accepted by GitHub at `askedAt`, of `sha`;
 *   - `done` — the review slot is filled: `runId`.
 */
export const ProjectRepoReview = z.object({
  status: ProjectReviewStatus,
  reason: ProjectReviewReason.nullable(),
  askedAt: z.iso.datetime().nullable(),
  sha: z.string().nullable(),
  runId: z.uuid().nullable(),
});
export type ProjectRepoReview = z.infer<typeof ProjectRepoReview>;

/**
 * A repository on the staff's project page: its deadline and lock
 * ({@link ProjectRepoDeadlineState}), its provisioning and invitation, the
 * last STUDENT commit and its CI status (as the webhooks stored them), the
 * live counters, the scores (the teacher's with the maximum it was written
 * with, M3-08b), the final review's state (`review`), the release's
 * snapshot, and the flags:
 *   - `protectionSuspended` — "protected files in conflict" (F-PROJ-08);
 *   - `toVerify` — the run of one of its three slots is to verify;
 *   - `multiple` — one of its runs printed several `GRADE` annotations (an
 *     alert: a student's code could print one; F-PROJ-10);
 *   - `malformed` — its latest run's score did not parse: the reason, else
 *     null;
 *   - `deleted` — gone from GitHub (stored, or GitHub's 404 just now);
 *   - `changedAfterRelease` — the final score differs from the release's
 *     snapshot (only once the project was released).
 */
export const ProjectRepoView = ProjectRepoDeadlineState.extend({
  provisionStatus: ProvisionStatus,
  provisionError: z.string().nullable(),
  invitationStatus: InvitationStatus,
  acceptedAt: z.iso.datetime(),
  lastCommit: z.object({ sha: z.string(), at: z.iso.datetime().nullable() }).nullable(),
  ciStatus: CiStatus,
  live: ProjectRepoLive.nullable(),
  scores: z.object({
    current: ProjectSlotScore.nullable(),
    frozen: ProjectSlotScore.nullable(),
    review: ProjectSlotScore.nullable(),
    teacher: z
      .object({
        points: z.number(),
        max: z.number().nullable(),
        comment: z.string().nullable(),
        gradedAt: z.iso.datetime().nullable(),
      })
      .nullable(),
    final: ProjectFinalScore.nullable(),
    /**
     * The maximum a teacher's score is held to (M3-12b): the scored run's —
     * the one the final score would come from without the teacher —, or
     * null when there is none (pass / fail only, malformed, several
     * annotations, or a run to verify): the teacher then gives their own
     * with the points (`ScoreOverride.max`, else `422 score_max_required`).
     */
    scoreMax: z.number().nullable(),
  }),
  review: ProjectRepoReview,
  released: z.object({ points: z.number().nullable(), max: z.number().nullable() }).nullable(),
  flags: z.object({
    protectionSuspended: z.boolean(),
    toVerify: z.boolean(),
    multiple: z.boolean(),
    malformed: z.string().nullable(),
    deleted: z.boolean(),
    changedAfterRelease: z.boolean(),
  }),
  /**
   * *Access to revoke* (F-PROJ-13, ADR-070 §4; M3-15b-2): an account
   * recorded on this group repository is not revoked although the copy no
   * longer wants it — a departure the `group.sync` job has not revoked yet,
   * one GitHub refused (retried by the job), or an invitation GitHub would
   * not take back.
   */
  accessToRevoke: z.boolean(),
});
export type ProjectRepoView = z.infer<typeof ProjectRepoView>;

/**
 * A student of the project page: their roster line (`enrollmentId` null for
 * a repository whose student has left the roster since), whether the seat
 * is claimed, and the GitHub account they linked.
 */
export const ProjectStudent = z.object({
  enrollmentId: z.uuid().nullable(),
  userId: z.uuid().nullable(),
  nom: z.string(),
  prenom: z.string(),
  email: z.string(),
  claimed: z.boolean(),
  githubLogin: z.string().nullable(),
});
export type ProjectStudent = z.infer<typeof ProjectStudent>;

/** One row of the project page: a student and their repository, null when they have not accepted. */
export const ProjectDetailRow = z.object({ student: ProjectStudent, repo: ProjectRepoView.nullable() });
export type ProjectDetailRow = z.infer<typeof ProjectDetailRow>;

export const ProjectPrimaryAction = z.enum(PROJECT_PRIMARY_ACTIONS);
export type ProjectPrimaryAction = z.infer<typeof ProjectPrimaryAction>;

/**
 * `GET /app/api/projects/:id` (F-PROJ-13): the project for its staff
 * ({@link ProjectSummary}) and its page — STAFF ONLY, never reused nor
 * filtered for a student (N-SEC-20: the student's projection is M3-09's).
 * `counts`: the roster's students (staff seats excepted), the repositories
 * accepted, the live ones (provisioned, not deleted, the project not
 * archived) and how many of them are definitively frozen, the rows to
 * verify, the rows with an alert (`multiple`, or protection suspended).
 * `primaryAction` is the server's (`projectPrimaryAction`, `@quiz/domain`).
 * `liveStale`: some live state was served stale, or not read in time —
 * refetch shortly. Rows: the roster by name, then the repositories whose
 * student left it.
 */
export const ProjectDetail = ProjectSummary.extend({
  releasedAt: z.iso.datetime().nullable(),
  primaryAction: ProjectPrimaryAction,
  counts: z.object({
    students: z.number().int(),
    accepted: z.number().int(),
    live: z.number().int(),
    frozen: z.number().int(),
    toVerify: z.number().int(),
    alerts: z.number().int(),
  }),
  liveStale: z.boolean(),
  rows: z.array(ProjectDetailRow),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;
// ---------------------------------------------------------- review checkpoints (M3-05b)

/**
 * A checkpoint's name: the tag of `criteria.yml`'s `milestone:` entries and
 * the argument of `score grade --milestone` (a wire name, I16), so shell-
 * and YAML-friendly.
 */
export const CheckpointName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,49}$/, "lowercase letters, digits, - and _ (at most 50)");

/**
 * `POST /app/api/projects/:id/checkpoints` (F-PROJ-11): a name and EITHER an
 * absolute date OR an offset of −365…−1 days from the project's deadline
 * (J−n, calendar days in Europe/Zurich, `checkpointDueAt`; re-resolved when
 * the deadline moves). The resolved date must lie ahead (`422 due_past`) and
 * before the project's deadline (`422 due_after_deadline`).
 */
export const ReviewCheckpointCreate = z
  .strictObject({
    name: CheckpointName,
    dueAt: Instant.optional(),
    offsetDays: z.number().int().min(-365).max(-1).optional(),
  })
  .refine((b) => (b.dueAt === undefined) !== (b.offsetDays === undefined), {
    message: "Give either a date or an offset, not both",
    path: ["dueAt"],
  });
export type ReviewCheckpointCreate = z.infer<typeof ReviewCheckpointCreate>;

/**
 * One review checkpoint, for its staff: `dueAt` its date as resolved,
 * `offsetDays` the J−n it was authored as (null: an absolute date),
 * `dispatchedAt` once its `grade-milestone` dispatch reached every
 * repository it was due to. A checkpoint not dispatched whose date is no
 * longer before the project's deadline (the deadline moved earlier) never
 * fires: it is void, and may be deleted.
 */
export const ReviewCheckpoint = z.object({
  id: z.uuid(),
  name: CheckpointName,
  dueAt: z.iso.datetime(),
  offsetDays: z.number().int().nullable(),
  dispatchedAt: z.iso.datetime().nullable(),
});
export type ReviewCheckpoint = z.infer<typeof ReviewCheckpoint>;

/** `DELETE /app/api/projects/:id/checkpoints/:cid`: the project, and one of its checkpoints. */
export const ProjectCheckpointParams = z.object({ id: z.uuid(), cid: z.uuid() });
export type ProjectCheckpointParams = z.infer<typeof ProjectCheckpointParams>;

/**
 * The refusals of the checkpoints' routes, `{ error, message }` (statuses in
 * the API's `modules/project/errors.ts`): `due_past` and `due_after_deadline`
 * (422) — the resolved date at or before now, or at or after the project's
 * deadline; `duplicate_checkpoint` (409) — the name is taken on the project;
 * `checkpoint_dispatched` (409) — a deletion once a dispatch of it was
 * claimed for any repository (the ledger keeps what was asked of GitHub).
 */
export const PROJECT_CHECKPOINT_REFUSALS = ["due_past", "due_after_deadline", "duplicate_checkpoint", "checkpoint_dispatched"] as const;
export const ProjectCheckpointErrorCode = z.enum(PROJECT_CHECKPOINT_REFUSALS);
export type ProjectCheckpointErrorCode = z.infer<typeof ProjectCheckpointErrorCode>;

// ---------------------------------------------------------- the staff's writes (M3-08b)

/**
 * `PATCH /app/api/projects/:id/repos/:rid/score` (F-PROJ-14): the
 * teacher's score, after the repository's definitive freeze (`409
 * not_frozen`) on a graded project (`409 grading_none`). `points` 0…1000,
 * or null to clear the score (the maximum and the comment with it). `max`
 * (product owner, 2026-10-02): required when the repository has no scored
 * run (`422 score_max_required`) and then the score's own; otherwise the
 * scored run's maximum applies and a `max` given must equal it (`422
 * score_max_mismatch`); `points` never exceed it (`422 score_above_max`).
 * Answers {@link ProjectRepoScores}.
 */
export const ScoreOverride = z.strictObject({
  points: z.number().min(0).max(1000).nullable(),
  max: z.number().positive().optional(),
  comment: z.string().max(2000).optional(),
});
export type ScoreOverride = z.infer<typeof ScoreOverride>;

/**
 * The repository's scores as they stand after a write ({@link ScoreOverride}):
 * the `scores`, `released` and `flags.changedAfterRelease` of its
 * {@link ProjectRepoView}, so the row can be patched in place.
 */
export const ProjectRepoScores = z.object({
  scores: ProjectRepoView.shape.scores,
  released: ProjectRepoView.shape.released,
  changedAfterRelease: z.boolean(),
});
export type ProjectRepoScores = z.infer<typeof ProjectRepoScores>;

/**
 * `POST /app/api/projects/:id/release` (F-PROJ-14, D05): the final scores
 * made the students' and the gradebook's, once every live repository is
 * frozen for good (`409 not_frozen`) and no final score is left to verify
 * (`409 to_verify`, `repos` the repository ids; `409 grading_none`). Writes each
 * repository's snapshot (`released` of its row); a release again rewrites
 * it, which clears `changedAfterRelease`. `first`: the project had never
 * been released (the one release the students are notified of, M3-09);
 * `repos` the snapshots written, `scored` those with a final score.
 */
export const ProjectReleaseResult = z.object({
  releasedAt: z.iso.datetime(),
  first: z.boolean(),
  repos: z.number().int(),
  scored: z.number().int(),
});
export type ProjectReleaseResult = z.infer<typeof ProjectReleaseResult>;

/**
 * `POST /app/api/projects/:id/repos/:rid/protection` (F-PROJ-08): the
 * protected files restored again on a repository marked "protected files
 * in conflict"; only restores after it count toward the cap, the runs
 * flagged meanwhile stay to verify, nothing is restored at once. Idempotent
 * on a repository not suspended (`reenabledAt` then the last re-enable, or
 * null). `409 repo_unavailable` for a repository not provisioned, deleted,
 * or of an archived project.
 */
export const ProjectRepoProtection = z.object({ reenabledAt: z.iso.datetime().nullable() });
export type ProjectRepoProtection = z.infer<typeof ProjectRepoProtection>;

/**
 * `POST /app/api/projects/:id/repos/:rid/invite` (F-PROJ-07): the staff
 * resend a PENDING invitation (`409 invitation_not_pending`; `409
 * repo_unavailable` for a repository not provisioned or deleted), at most
 * once a minute per repository (`429 resend_too_soon`), with the `push`
 * permission (N-SEC-21). `invitationStatus` as GitHub answered: `accepted`
 * when the student already is a collaborator.
 */
export const ProjectInvitationResent = z.object({
  invitationStatus: InvitationStatus,
  resentAt: z.iso.datetime(),
});
export type ProjectInvitationResent = z.infer<typeof ProjectInvitationResent>;

/**
 * The `409 unassigned_students` body of `POST /app/api/projects/:id/publish`
 * (ADR-048): the claimed students of the classroom in no group of the
 * project, by name; empty when the group project has no group at all.
 * Consumed by the project page (M3-12a), which words it.
 */
export const ProjectUnassigned = z.object({
  error: z.literal("unassigned_students"),
  message: z.string(),
  students: z.array(z.object({ enrollmentId: z.uuid(), nom: z.string(), prenom: z.string() })),
});
export type ProjectUnassigned = z.infer<typeof ProjectUnassigned>;

/**
 * The `409` bodies of `POST /app/api/projects/:id/release` that carry
 * data (M3-08b `grades.ts`; worded by the project page, M3-12c):
 * `not_frozen` with the page's counts — the live repositories and how many
 * of them are frozen for good —, `to_verify` with the ids of the live
 * repositories whose final score rests on a run to verify.
 */
export const ProjectReleaseRefusal = z.discriminatedUnion("error", [
  z.object({ error: z.literal("not_frozen"), message: z.string(), live: z.number().int(), frozen: z.number().int() }),
  z.object({ error: z.literal("to_verify"), message: z.string(), repos: z.array(z.uuid()) }),
]);
export type ProjectReleaseRefusal = z.infer<typeof ProjectReleaseRefusal>;

// ---------------------------------------------------------- the student's project (M3-09a)

/** The run a student's score comes from: the evaluated commit, its run on GitHub, when it finished. */
export const StudentProjectRun = z.object({
  sha: z.string(),
  url: z.url(),
  conclusion: z.string(),
  completedAt: z.iso.datetime(),
});
export type StudentProjectRun = z.infer<typeof StudentProjectRun>;

/**
 * The score a student reads before the release, INDICATIVE until then
 * (N-SEC-21): the current CI score, or the frozen one (`frozen`) once their
 * deadline is applied — provisional or definitive alike. Graded by the
 * project's scale. Never the review's nor the teacher's (F-PROJ-15).
 */
export const StudentProjectScore = z.object({
  points: z.number(),
  max: z.number().nullable(),
  grade: ProjectGradeView.nullable(),
  frozen: z.boolean(),
});
export type StudentProjectScore = z.infer<typeof StudentProjectScore>;

/**
 * The student's own repository (F-PROJ-15): its name and URL, their
 * invitation (F-PROJ-07), whether GitHub lost it (`deleted`) or holds it
 * locked, the commit the view stands on and its CI status, the run their
 * score comes from and that score. Before the deadline, `lastCommit` and
 * `ciStatus` are the last push of theirs and its checks as the webhooks
 * stored them; once their deadline is applied (or passed), they are the
 * SELECTED run's commit and its conclusion read as pass or fail — `success`
 * is `pass`, every other conclusion (a failure, a cancellation, a skip) is
 * `fail` — never a push or a run after the deadline (N-SEC-20), or null and
 * `none` without a selected run (`studentCiReading` of `@quiz/domain`).
 * `score` is null
 * under grading `none`, without a parsed run, and after the deadline when
 * no run in time scored; `run` is null when no run is selected.
 */
export const StudentProjectRepo = z.object({
  fullName: z.string(),
  url: z.url(),
  invitation: z.enum(["pending", "accepted"]),
  deleted: z.boolean(),
  locked: z.boolean(),
  lastCommit: z.object({ sha: z.string(), at: z.iso.datetime().nullable() }).nullable(),
  ciStatus: CiStatus,
  run: StudentProjectRun.nullable(),
  score: StudentProjectScore.nullable(),
});
export type StudentProjectRepo = z.infer<typeof StudentProjectRepo>;

/**
 * What the release gave the student (F-PROJ-14): the final score's
 * snapshot, its grade, and the teacher's comment AS THE RELEASE WROTE IT
 * (`released_comment`: a comment written since waits for the next
 * release, like the score it may describe). `points` null when the
 * release found no score for them.
 */
export const StudentProjectRelease = z.object({
  at: z.iso.datetime(),
  points: z.number().nullable(),
  max: z.number().nullable(),
  grade: ProjectGradeView.nullable(),
  comment: z.string().nullable(),
});
export type StudentProjectRelease = z.infer<typeof StudentProjectRelease>;

/**
 * `GET /app/api/student/projects/:id` (F-PROJ-15, N-SEC-20): the ONE exit of
 * a project towards a student, loaded through the classroom's student
 * branch (`studentProjectView`, `guards.ts`): the card's facts, the
 * project's grading mode, the caller's own repository (null until they
 * accept — and always null for a teacher in the student view, whose staff
 * seat holds none), and the release once it happened. Never the source nor
 * the distribution repository, another student's anything, a run after the
 * deadline, the review or the teacher's score before the release, nor the
 * staff's flags.
 */
export const StudentProject = StudentProjectCard.omit({ invitation: true, repoFullName: true, repoUrl: true }).extend({
  gradingMode: ProjectGradingMode,
  repo: StudentProjectRepo.nullable(),
  release: StudentProjectRelease.nullable(),
  serverNow: z.iso.datetime(),
});
export type StudentProject = z.infer<typeof StudentProject>;
