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

import { PROJECT_PATCH_FIELDS, PROJECT_SCALE_KINDS, slugify } from "@quiz/domain";

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

/**
 * A published project on the student's Activities (F-PROJ-04, the
 * `project` member of `StudentActivityCard`). The student payload: never a
 * draft, never the source or distribution repository, nothing of another
 * student (N-SEC-20). `status`: to accept (or not yet open, which `startAt`
 * tells), in progress once accepted, locked after the deadline.
 * `repoFullName` is the student's own repository (or their group's) once
 * it exists. Its score is the project's student view's (M3-09), not the
 * card's.
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
  status: z.enum(["to_accept", "in_progress", "locked"]),
  repoFullName: z.string().nullable(),
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
/** Advisory group size (ADR-048): exceeding it warns, never blocks. */
const GroupMaxSize = z.number().int().min(1).max(50);
const Instant = z.iso.datetime({ offset: true });

/**
 * `POST /app/api/classrooms/:id/projects` (F-PROJ-01). heig-classroom's
 * rules, without the work mode (F-PROJ-19): a scheduled publication needs an
 * absolute start and deadline; a manual one a deadline OR a duration counted
 * from the publication, and starts when it is published. The source, its
 * branches (by default its default branch; the first becomes the students'
 * default branch) and the source strategy are fixed here, for good
 * (F-PROJ-03 as amended 2026-10-02). `gradingScale` defaults to the linear
 * scale (D05).
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
    groupMaxSize: GroupMaxSize.nullable().optional(),
  })
  .superRefine((b, ctx) => {
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
 * turns a manual deadline into an absolute one.
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
    groupMaxSize: GroupMaxSize.nullable().optional(),
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
  groupMaxSize: z.number().int().nullable(),
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
 *   - `deadline_applied` — moving a deadline already applied is the reopen
 *     of merge task M3-05;
 *   - `unassigned_students` — the body names the claimed students in no
 *     group (`students`: enrollment id, nom, prenom), empty when the group
 *     project has no group at all.
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
  "deadline_applied",
  "not_draft",
  "publish_mode_frozen",
  "strategy_frozen",
  "unassigned_students",
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
 * repository and nothing else — never the source nor the distribution
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
 *   - `no_group` — a group project (groups come with merge task M3-15);
 *   - `github_not_linked`; `github_account_stale` — the linked account was
 *     deleted, or GitHub refused to invite it (renamed away): relink;
 *   - `app_not_installed` — Quiz's App no longer acts on the project's
 *     organization; `distribution_missing` — nothing to hand out;
 *   - `provision_in_progress` — another Accept of the same repository is
 *     under way: try again in a moment;
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
