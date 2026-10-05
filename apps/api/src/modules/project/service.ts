/**
 * The `project` module (F-PROJ, ADR-035, spec 05 §5.11,
 * docs/merge/03-github-projects.md §3.3): the entry other modules import.
 * It owns the tables of `db/project.ts`; it reads the `github` module's
 * organizations and links by join and purges push receipts through its
 * service (`purgeProjectReceipts`), never writing them itself.
 *
 * From M3-02: the lifecycle (`lifecycle.ts`), the staff's views
 * (`views.ts`), the organization's repository browser (`sources.ts`).
 * From M3-03: a student's Accept and its provisioning (`accept.ts`).
 * From M3-04: GitHub's events on projects (`webhooks.ts`, registered by
 * the plugin), the grading pipeline (`grading.ts`, `ingestCompletedRun`,
 * the one path M3-06 reuses), the protected files (`protection.ts`).
 * From M3-05a: the deadline's rules and what moving it does
 * (`deadline.ts`: the reopen, a repository's own deadline, the staff's
 * lock), and what applies it (`jobs.ts`: the ticker's claims, the
 * `project.deadline` job).
 * From M3-08a: the staff's project page and a repository's runs
 * (`detail.ts`).
 * From M3-05b: the review dispatches (`review.ts`: the final review per
 * repository, the checkpoints', the `project.dispatch` job, its own lease
 * — `lease.ts`, shared with the deadline's) and the checkpoints' authoring
 * (`checkpoints.ts`).
 * From M3-08b: the staff's writes — the teacher's score and the release
 * (`grades.ts`), the protection re-enabled (`protection.ts`), an
 * invitation resent (`invitation.ts`).
 * From M3-09a: the project's student view (`studentView.ts`), the ONE exit
 * of a project towards a student (N-SEC-20): their cards, their project's
 * page, their own resend of an invitation.
 * From M3-15a: a group project's copy of its group set (`groupCopy.ts`),
 * which the `group` module steps in its own transaction, never writing
 * these tables itself (ADR-070 §4).
 * From M3-07: the source's sync (`sync.ts`): the source ahead, the staff's
 * request updating the distribution repository and the leased
 * `project.sync` pass over the repositories, the App's pull requests.
 * From M3-15b-1: a group's repository at Accept (`accept.ts`), whose
 * repository is whose through the copy (`groupRepos.ts`, N-SEC-20), and the
 * accounts let in (`access.ts`): recorded at each invitation, invited when a
 * student links GitHub (`auth/githubLink.ts`), revoked before the roster's
 * writes take a line or its account away and guarded in their transaction
 * (`revokeEnrollmentAccess`, `releaseLine`, `RevokeFailed`: the `org`
 * service).
 * From M3-15b-2: each copy group's stop (`stopGroups`), the set's moves
 * that reach a group with a repository left to the `group.sync` job
 * (`groupSync.ts`, its own lease) after their consequences are confirmed
 * (`ConfirmationNeeded`), and *access to revoke* on the project page.
 * From M3-15b-2b: *Resync with the set* and the drift (`groupResync.ts`).
 */
export { acceptProject } from "./accept.js";
export { createCheckpoint, deleteCheckpoint, listCheckpoints } from "./checkpoints.js";
export { projectDetail, repoRuns } from "./detail.js";
export { repoDeadline, setRepoDeadline, setStaffLock } from "./deadline.js";
export { overrideScore, releaseProject } from "./grades.js";
export { gradebookProjects, projectLiveScores, projectReleasedScore, type ProjectGradeCell } from "./gradebook.js";
export { projectsChanged } from "./events.js";
export { ConfirmationNeeded, copiesBefore, followingCopies, RepoGroupTouched, setFrozen, stepCopies, stopProjects } from "./groupCopy.js";
export { requestGroupSync } from "./groupSync.js";
export { resyncGroups } from "./groupResync.js";
export { inviteOnGithubLink, releaseLine, revokeEnrollmentAccess, RevokeFailed, type RevokeVia } from "./access.js";
export { resendInvitation } from "./invitation.js";
export { reenableProtection } from "./protection.js";
export { requestDeadlineWork } from "./jobs.js";
export {
  createProject,
  deleteProject,
  patchProject,
  publishProject,
  setProjectArchived,
  unassignedStudents,
  type CreateInput,
  type Unassigned,
} from "./lifecycle.js";
export { ProjectError } from "./errors.js";
export { listSources, sourceDetail } from "./sources.js";
export { studentProject, studentProjectCards, studentResendInvitation } from "./studentView.js";
export { requestSync } from "./sync.js";
export { classroomProjects, projectSummary, teacherProjects, type ProjectRow } from "./views.js";
