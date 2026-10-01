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

import { PROJECT_SCALE_KINDS } from "@quiz/domain";

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
