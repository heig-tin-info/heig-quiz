import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Db, Tx } from "./db/client.js";
import type { AuditActorType } from "./db/auth.js";
import { auditLog } from "./db/schema.js";

/**
 * Closed catalogue of audit actions: a typo in a trigger site is a compile
 * error, and this union is the reference for querying the log.
 */
export type AuditAction =
  | "api_token.create"
  | "api_token.revoke"
  /**
   * ADR-061: a first login took over the account the heig-classroom import
   * created for the same person (subject the user; `payload.key`:
   * `swiss_edu_id`, `institutional_address` or `private_address`;
   * `payload.previousSub`, the `classroom:` placeholder it replaced).
   */
  | "auth.account_adopted"
  /**
   * ADR-061: a first login matched more than one imported account, or an
   * address that is not unique; nothing adopted, a new account made (subject
   * that new user; `payload.key`, `payload.candidates`: the user ids).
   */
  | "auth.adoption_ambiguous"
  | "auth.dev_login"
  | "auth.login"
  | "auth.logout"
  | "auth.seb_launch"
  | "auth.seb_login"
  | "auth.seb_config_key_mismatch"
  | "auth.seb_refused"
  | "auth.session_superseded"
  /**
   * ADR-080 §6: an administrator read a teacher's assistant conversations —
   * one (subject the conversation, `payload.owner`), or their list (subject
   * the user). The owner's own reads are not traced.
   */
  | "assist.read"
  | "avatar.delete"
  | "avatar.update"
  | "attempt.close"
  | "attempt.reopen"
  | "attempt.retake"
  | "attempt.staff_reset"
  | "category.create"
  | "category.delete"
  | "category.reorder"
  | "category.update"
  | "classroom.archive"
  | "classroom.create"
  | "classroom.delete"
  | "classroom.rename"
  | "classroom.unarchive"
  /**
   * The vocabulary of concepts (ADR-081, addendum §5). `propose`: a teacher
   * created a `proposed` concept (subject the concept; `payload.lang`,
   * `payload.label`, `payload.qualifier`). `edit`: its creator or the admin
   * changed a label, qualifier or description (`payload`: the patch, per
   * language). `delete`: the admin deleted a concept nothing referred to,
   * before the cut-over (second addendum §2; `payload.status`,
   * `payload.labels`). `validate`: the admin validated a concept
   * (`payload.labels`). The tag sorting's `sort` and
   * `sort_propose` rows of the past stay in the log, no longer written
   * (ADR-081, step (d)).
   */
  | "concept.delete"
  | "concept.edit"
  | "concept.propose"
  | "concept.validate"
  | "course.create"
  | "course.delete"
  | "course.staff_add"
  | "course.pools_update"
  | "course.staff_remove"
  | "course.staff_role_change"
  | "course.update"
  /**
   * The course's catalog of conditions (F-ORG-16, ADR-079 §5), written by
   * any staff member; subject the course, `payload.conditionId`. `create`:
   * `payload.kind`, `payload.text`; `update`: `payload.from` and
   * `payload.to` (`{ kind, text }`); `archive` / `unarchive`:
   * `payload.text`. A reorder is not traced: it changes no wording.
   */
  | "course.condition_create"
  | "course.condition_update"
  | "course.condition_archive"
  | "course.condition_unarchive"
  /**
   * The online workspace (ADR-047, M6-06). `launch_issued`: a student's
   * launch token minted by the start route (subject the project;
   * `payload.jti`, `payload.mode` and, from a `seb` session, `payload.seb:
   * true` — NEVER the token, a bearer credential). `work_mode`: an owner set
   * a project's work mode (`payload.from`, `payload.to`). `sync_requested`:
   * the staff's *Resync*. `synced`: the portal accepted the project (a
   * system action; `payload.mode`, `payload.quotaHolder`). Nothing else of
   * a token, a secret or a Browser Exam Key is ever written here.
   * `git_token_issued` (ADR-078 §2): Quiz minted the portal an installation
   * token on one repository (`payload.userId`, `repository`, `githubRepoId`,
   * `permission`, `expiresAt`, the request's `jti`) — never the token.
   */
  | "codespace.launch_issued"
  | "codespace.work_mode"
  | "codespace.sync_requested"
  | "codespace.synced"
  | "codespace.git_token_issued"
  /** The teacher enabled the drill for a classroom (ADR-041 §6). */
  | "drill.enable"
  /** …and disabled it: its cards leave the sessions, their data is kept. */
  | "drill.disable"
  /** "Remove these questions from the drill": an evaluation's cards deleted (ADR-041 §10). */
  | "drill.cards_remove"
  /** "Allow drill" set on an evaluation (`payload.allowDrill`, ADR-041 §2). */
  | "drill.allow"
  | "evaluation.close"
  /** The correction of an open exercise published, irreversibly (ADR-050). */
  | "evaluation.correction_publish"
  | "evaluation.create"
  | "evaluation.delete"
  | "evaluation.duplicate"
  | "evaluation.extend"
  | "evaluation.items_update"
  | "evaluation.items_versions"
  | "evaluation.pause"
  | "evaluation.resume"
  | "evaluation.start"
  | "evaluation.state"
  | "evaluation.update"
  /**
   * F-GH-05 (M2-03): a user linked their GitHub account, or unlinked it;
   * subject the user, `payload.githubUserId` and `payload.login`. Never a token.
   */
  | "github.linked"
  | "github.unlinked"
  /** The GitHub account read is already another user's (`payload.githubUserId`): nothing written. */
  | "github.link_conflict"
  /** A linked account's login changed on GitHub, followed by its id (`payload.from`, `payload.to`). */
  | "github.renamed"
  /**
   * A classroom connected to a GitHub organization, or moved to another one
   * (F-GH-01): subject the classroom, `payload.orgId`, `payload.login`,
   * `payload.previousOrgId`. `unlink`: disconnected, `payload.orgId`.
   */
  | "github_org.link"
  | "github_org.unlink"
  /**
   * Quiz's App found installed on an organization (subject the organization
   * row; `payload.installationId`, `payload.via`: `setup_url`, `listing`,
   * `healing`, `webhook`), or found uninstalled or suspended
   * (`installation_deleted`; from a webhook, `payload.action` says which).
   * A system action: GitHub said so, nobody asked.
   */
  | "github_org.installation_resolved"
  | "github_org.installation_deleted"
  /** GitHub suspended the installation, or lifted the suspension (`payload.suspended`, `payload.via`; M3-09b). */
  | "github_org.installation_suspended"
  /** The organization's login changed on GitHub (`payload.from`, `payload.to`, `payload.via`). */
  | "github_org.renamed"
  /** The organization no longer exists on GitHub (`status: deleted`). */
  | "github_org.deleted"
  | "grading.override"
  | "grading.regrade"
  | "grading.run"
  | "grading.validate"
  /**
   * The gradebook's staff writes (ADR-074, F-GBOOK-06; merge task M5-03a),
   * subject the classroom. `gradebook.mark_set`: `payload.activityKind` (the
   * activity's: `evaluation` | `project`), `activityId`, `enrollmentId`,
   * `before` and `after` (the mark: `{ kind, points, max, comment }`, null
   * for none), `override` (a real grade lay beneath); `mark_cleared`: the
   * same, `after` null. `column_updated`: `kind`, `activityId`, `before`
   * and `after` (`{ weight, counts, position }`, the weight in whole
   * percent since #545). `mean_published` /
   * `mean_unpublished`: no payload. Never a grade of another student.
   */
  | "gradebook.mark_set"
  | "gradebook.mark_cleared"
  | "gradebook.column_updated"
  | "gradebook.mean_published"
  | "gradebook.mean_unpublished"
  /**
   * A classroom's group sets (ADR-070, merge task M3-15a), subject the set,
   * by its staff. `group_set.create`: `payload.name`, `maxSize`; `update`:
   * the fields sent; `duplicate`: subject the NEW set, `payload.from`,
   * `name`; `delete`: `payload.name`. `group.create`: `payload.groupId`,
   * `name`; `rename`: `groupId`, `from`, `to`; `delete`: `groupId`, `name`;
   * `member_move`: `enrollmentId`, `from`, `to` (group ids, null: none);
   * `random_form`: `size`, `remainder`, `groups` (the new ones), `placed`.
   * Every write but the sets' creation and duplication also names
   * `payload.copies`: the projects whose copy it changed in its own
   * transaction (ADR-070 §4; always empty for a deletion, which no
   * following copy allows), and `deferred`: those whose moves out of or
   * into a group with a repository it left to the `group.sync` job
   * (M3-15b-2), their consequences confirmed. A write that would delete a
   * copy group with a repository (`409 has_repo`), or whose consequences
   * were not confirmed (`409 needs_confirmation`), audits nothing.
   */
  | "group_set.create"
  | "group_set.update"
  | "group_set.duplicate"
  | "group_set.delete"
  | "group.create"
  | "group.rename"
  | "group.delete"
  | "group.member_move"
  | "group.random_form"
  /** An admin opened a session as a student (ADR-034): actor the admin, subject the student. */
  | "impersonation.started"
  /** That session ended: signed out, or expired (`payload.reason`). */
  | "impersonation.ended"
  /**
   * The journal's staff writes (M4-03, M4-08, 04-journal §4.1, D27, ADR-057):
   * subject the classroom, `payload.mode` on every write of a mode. `create`
   * — a Quiz-mode journal, or a new repository — and `use` (one of the
   * organization's): `payload.fullName`, `githubRepoId`, `ref`, `rootPath`;
   * `remove`: the row and its copy dropped (`payload.pages`), a repository
   * kept; `refresh`; Quiz mode's page writes `save`, `add`, `delete`,
   * `upload`: `payload.path` (a save, the new `version`; an upload, `bytes`
   * and `blobSha`); `restore`: a revision made the page's content again,
   * `payload.path`, `revisionId`. The synchronisations themselves audit
   * nothing: their outcome is the journal's sync state.
   */
  | "journal.create"
  | "journal.use"
  | "journal.remove"
  | "journal.refresh"
  | "journal.save"
  | "journal.add"
  | "journal.delete"
  | "journal.upload"
  | "journal.restore"
  /**
   * One staff member invited as a collaborator of the journal's repository
   * (D27), `payload.permission` always `push`: `payload.userId`, `login`,
   * `fullName`, `outcome` (`pending`, `accepted`, `stale` — the link points at
   * no account —, `failed`).
   */
  | "journal.invite"
  /**
   * ADR-051 §5, §8: a station's attestation accepted, or failed (`payload.reason`
   * `refused` | `unavailable`). The subject is the station's device id, or
   * `unknown` when no known station's cookie came with the failure — never the
   * challenge, the response nor the cookie.
   */
  | "kiosk.attested"
  | "kiosk.attest_failed"
  /** A device attested for the first time: in the registry, `unnamed`. */
  | "kiosk.device_registered"
  /** An admin named or renamed a station (`payload.from`, `payload.to`). */
  | "kiosk.device_labeled"
  | "kiosk.device_retired"
  /** A retired station put back in service by an admin. */
  | "kiosk.device_reactivated"
  /**
   * ADR-051 §7: a student approved a station's pairing from their phone
   * (subject the pairing; `payload.evaluationId`, `payload.deviceId`), or a
   * pairing was refused (`payload.reason`: `code` — a wrong, expired or used
   * code, counted towards the limit — or `evaluation`). Never a code.
   */
  | "kiosk.paired"
  | "kiosk.pair_refused"
  /**
   * ADR-051 §7, the supervisor's fallback: a staff member approved a
   * station's pairing for a student without a phone (subject the pairing;
   * `payload.evaluationId`, `payload.userId`, `payload.deviceId`). The actor
   * is the staff member; the session it opens has none. Never a code.
   */
  | "kiosk.assigned"
  /**
   * ADR-051 §6: the station a kiosk session sits on was suspended
   * (`payload.reason`: `refused` or `silent`), or its suspension lifted by an
   * accepted attestation. Subject the station's device id; the payload names
   * the student and the evaluation it sat, when it sat one.
   */
  | "kiosk.suspended"
  | "kiosk.resumed"
  /**
   * An admin saved the LLM gateway's settings (ADR-058): `payload` the model
   * and the cap when they changed, and `key: "set" | "removed"` — NEVER the key.
   */
  | "llm.settings"
  /** An admin ran the connection test (ADR-058 §6): `payload.ok`, and the error code. */
  | "llm.test"
  /**
   * One `--apply` of the heig-classroom import that wrote something (M1-06,
   * 02-data-and-migration §2.5): actor the account given as `--actor`,
   * subject the run (`import_classroom.runs`), `payload` the report's counts.
   */
  | "migration.classroom_import"
  | "oauth.grant"
  | "oauth.refresh_replay"
  | "oauth.revoke"
  | "poll.create"
  | "poll.end"
  /** A teacher's word on a brainstorm's ideas (ADR-071): `payload` is the action. */
  | "poll.ideas"
  | "poll.keep"
  | "poll.reveal"
  | "pool.asset_upload"
  | "pool.create"
  | "pool.delete"
  | "pool.member_update"
  /** The owner published the pool in the catalogue, or took it back (ADR-013, 2026-10-10). */
  | "pool.publish"
  | "pool.unpublish"
  /** The owner turned the night's LLM review on or off (ADR-060 §1): `payload.enabled`. */
  | "pool.review"
  | "pool.share"
  | "pool.transfer"
  | "pool.unshare"
  | "pool.update"
  /**
   * A project's lifecycle (F-PROJ-01, F-PROJ-03, F-PROJ-16; merge task
   * M3-02), subject the project. `create`: `payload.slug`, `source`,
   * `distribution` (full names); `update`: the fields sent; `publish`:
   * `payload.startAt`, `deadlineAt` — `auto_publish` the same, by the
   * ticker (M3-05); `delete`: `payload.name`, `slug`, `source`,
   * `distribution`, `receipts` (the push receipts purged) — no repository
   * is ever deleted on GitHub; `archive`, `unarchive`.
   */
  | "project.create"
  | "project.update"
  | "project.delete"
  | "project.publish"
  | "project.auto_publish"
  | "project.archive"
  | "project.unarchive"
  /**
   * A project's deadline (F-PROJ-09, F-PROJ-11; merge task M3-05a), subject
   * the project. By the ticker: `deadline_applied` (`payload.deadlineAt`;
   * the project `locked`); by the `project.deadline` job,
   * `deadline_enforced` — one entry per pass that changed something on
   * GitHub, `payload.strategy`, `locked` (an archive counted as a lock),
   * `unlocked`, `committed`, `deleted` (counts) and `failed` (full names):
   * the facts M3-09's `project_deadline_applied` notice is worded from. By
   * the staff: `deadline_reopened` — a deadline already applied moved later,
   * `payload.deadlineAt`, `previous`, `repos` (the repositories reopened).
   */
  | "project.deadline_applied"
  | "project.deadline_enforced"
  | "project.deadline_reopened"
  /**
   * One pass of a reconciliation (N-RES-08, ADR-011; merge task M3-06),
   * subject the scheduled task (`reconcile.grades`, `reconcile.repos`), one
   * entry per pass that changed something or stopped: `payload.repos`
   * (read), `runsIngested`, `reinvited`, `accepted` (invitations found
   * accepted), `heads` (last commits moved), `renamed`, `deleted` (counts),
   * `stoppedOnRateLimit`.
   */
  | "project.reconciled"
  /**
   * The release (F-PROJ-14, D05; merge task M3-08b), subject the project:
   * the final scores snapshotted per repository — `payload.first` (never
   * released before: the one release M3-09 notifies), `repos` (snapshots
   * written), `scored` (with a final score). A release again is audited
   * again and rewrites the snapshots.
   */
  | "project.release"
  /**
   * *Resync with the set* (ADR-070 §4, §6; merge task M3-15b-2b), subject
   * the project: `payload.digest` of the consequences confirmed (null when
   * none needed it), `consequences` (their count), `frozenRepos` (the
   * frozen repositories they touch, full names), `applied` (a part touching
   * no repository applied at once), `deferred` (the steps stored for the
   * `group.sync` job, audited `via: "group.resync"`).
   */
  | "project.group_resync"
  /**
   * A student's Accept (F-PROJ-05, merge task M3-03), subject the
   * `project_repos` row. `accept`: `payload.repo` (the student's own full
   * name), `invitation`, `protected` (false: a plan without rulesets);
   * `accept_failed`: `payload.notify` — true on the row's FIRST failure
   * only, which `project_provision_failed` tells the staff about
   * (F-NOTIF-13, M3-09b), never for an invitation GitHub refused (the
   * student relinks); `payload.reason`: `repo_name_taken`,
   * `invitation_refused` or `github_error`.
   */
  | "project.accept"
  | "project.accept_failed"
  /**
   * The review dispatches (F-PROJ-11; merge task M3-05b), by the
   * `project.dispatch` job, subject the project, one entry per pass that
   * changed something: `review_dispatched` — the final reviews,
   * `checkpoint_dispatched` — one checkpoint's, `payload.checkpointId` and
   * `name` besides; both `dispatched`, `deleted` (404: the repository gone),
   * `unconfirmed` (counts: GitHub's answer never came, never sent again) and
   * `failed` (full names: GitHub refused, sent again on the next pass).
   */
  | "project.review_dispatched"
  | "project.checkpoint_dispatched"
  /**
   * The source's sync (F-PROJ-12; merge task M3-07), subject the project.
   * By the staff: `sync_requested` — the distribution repository updated in
   * the request, `payload.changed` (the branches whose content changed),
   * `sourceHeads` (the source's shas now handed out, by branch); by the
   * `project.sync` job: `synced` — one entry per pass, `payload.opened`,
   * `updated`, `upToDate`, `failed`, `skipped` (counts) and `failedRepos`
   * (full names: the next sync retries them); `sync_failed` — the
   * distribution repository could not be updated, `payload.reason`
   * (`source_rewritten`: the `whole` strategy cannot fast-forward a rewritten
   * source; `github`: GitHub or git failed), nothing was changed.
   */
  | "project.sync_requested"
  | "project.synced"
  | "project.sync_failed"
  /**
   * A review checkpoint authored or removed by the staff (F-PROJ-11; merge
   * task M3-05b), subject the checkpoint: `payload.projectId`, `name`,
   * `dueAt`, `offsetDays` (null: an absolute date).
   */
  | "project_checkpoint.create"
  | "project_checkpoint.delete"
  /**
   * What GitHub's webhooks did to a student's repository (F-PROJ-08,
   * F-PROJ-18; merge task M3-04), by the system, subject the
   * `project_repos` row. `restore`: `payload.files`, `sha` (the App's
   * restore commit), `head` (the push it answered); `revert_cap`: a sixth
   * restore in an hour refused, the protection suspended until the staff
   * re-enable it (M3-08) — `payload.files`, `head`; `deleted`: the
   * repository deleted on GitHub, `payload.via` (`webhook`, `deadline`:
   * the 404 a deadline's step met, M3-05a, or `dispatch`: a review
   * dispatch's, M3-05b).
   */
  | "project_repo.restore"
  | "project_repo.revert_cap"
  | "project_repo.deleted"
  /**
   * A repository's deadline and lock (F-PROJ-09, D13 amended; merge task
   * M3-05a), subject the `project_repos` row. By the staff: `deadline_set`
   * (its own deadline, `payload.deadlineAt` — null: the project's again —,
   * `previous`, `reopened`), `lock` and `unlock` (the staff's hand,
   * `payload.staffLock`). By the deadline job: `archived` — the lock fell
   * back to archiving the repository (H8, a plan without rulesets). By the
   * ticker: `deadline_applied` (its provisional freeze) and `frozen` (the
   * definitive one), `payload.projectId`, `deadlineAt` (its effective one).
   * `review_skipped` (M3-05b): a repository frozen gets no final review,
   * degraded — `payload.projectId`, `reason`: `archived` (as its lock, H8)
   * or `protection_suspended` (F-PROJ-08); by the ticker at its freeze, or
   * by the deadline job archiving a repository already frozen.
   */
  | "project_repo.deadline_applied"
  | "project_repo.frozen"
  | "project_repo.deadline_set"
  | "project_repo.lock"
  | "project_repo.unlock"
  | "project_repo.archived"
  | "project_repo.review_skipped"
  /**
   * The staff's writes on a repository (F-PROJ-07, F-PROJ-08, F-PROJ-14;
   * merge task M3-08b), subject the `project_repos` row. `grade_override`:
   * the teacher's score, `payload.before` and `after` (`points`, `max`,
   * `comment`; null when none); `protection_reenabled`: the protected files
   * restored again, `payload.suspendedAt`; `invite_resent`: a pending
   * invitation sent again with `push`, `payload.logins` (the accounts
   * invited: the student, or a group's members still out), and
   * `invitationStatus` as GitHub answered.
   */
  | "project_repo.grade_override"
  | "project_repo.protection_reenabled"
  | "project_repo.invite_resent"
  /**
   * The daily reconciliation applied the `hgc-protect` ruleset a plan
   * without rulesets had left out (M3-14k), subject the `project_repos`
   * row — `payload.projectId`, `rulesetId`, `via` (`reconcile`).
   */
  | "project_repo.protected"
  /**
   * A GitHub account let into, or out of, a project repository for a roster
   * line (ADR-048 lot 2, ADR-070 §4–§5; merge task M3-15b), subject the
   * `project_repos` row — a group's, or (a revocation) a student's own.
   * `repo_invite`: `payload.repo`, `enrollmentId`, `login`, `invitation`
   * (`pending` | `accepted`), `via` (`accept`, `link`, `group.sync` — a
   * set's move, M3-15b-2 —, `group.resync` — a resync's, M3-15b-2b —,
   * `reconcile` — the daily re-invite, M3-06; a resend audits
   * `project_repo.invite_resent`);
   * `repo_revoke`: `payload.repo`, `enrollmentId`, `login` (null: none was
   * ever invited), `outcome` (`ok` | `skipped`), `reason` of a skip
   * (`app_not_installed`, `repo_deleted`, `not_provisioned`,
   * `account_gone`, `not_invited`), `invitationsCancelled` of a
   * revocation, `via` (`roster.remove`, `roster.unclaim`, `roster.update`,
   * `roster.self_enroll`, `group.sync`, `group.resync`).
   */
  | "project_group.repo_invite"
  | "project_group.repo_revoke"
  | "question.copy"
  | "question.create"
  | "question.delete"
  | "question.deprecate"
  | "question.move"
  | "question.publish"
  /**
   * `question.report` (issue #680): a reader reported a problem; the target
   * is the question, `payload.reportId` and `poolId`, never the message.
   * `question.report_resolve`: a writer resolved one; `payload.reportId`,
   * `poolId`, `replied` (whether a reply was given).
   */
  | "question.report"
  | "question.report_resolve"
  | "question.restore_version"
  | "question.stats_reset"
  | "question.update"
  | "results.release"
  | "results.rerelease"
  | "results.unrelease"
  | "roster.claim"
  | "roster.claim_conflict"
  | "roster.import"
  | "roster.remove"
  | "roster.self_enroll"
  | "roster.unclaim"
  | "roster.update"
  /**
   * An admin switched Super Powers on for one portal session (ADR-054):
   * actor and subject the admin, `payload.until` the server's end of it.
   */
  | "superpowers.enabled"
  /** …and they went off: `payload.reason` is `manual`, `expired` or `logout`. */
  | "superpowers.disabled"
  /**
   * An admin sent themselves the test e-mail of the System status (ADR-055
   * §6): actor and subject the admin, `payload.outcome` and `payload.error`
   * (a class, `http_502`) — never the address.
   */
  | "system.test_mail"
  // historical: old rows; no trigger since the cut-over to concepts (ADR-081)
  | "tag.describe"
  /** An admin paused, resumed or changed the period of a scheduled task (D10; `payload` the patch). */
  | "task.configure"
  /** An admin's "Run now" of a scheduled task (D10). */
  | "task.run_now"
  | "template.create"
  | "template.delete"
  | "template.instantiate"
  | "template.pull"
  | "template.update"
  | "teams.link"
  | "teams.unlink"
  | "teacher.grant"
  /** An administrator changed a teacher's workspace grant (ADR-047 §4; `payload`: the fields changed). */
  | "teacher.codespace_grant"
  | "teacher.revoke";

/**
 * Append-only audit log (NFR-05, AU-42). The trigger of migration 0096
 * refuses every UPDATE and DELETE on this table (ADR-003 §5).
 */
export async function audit(
  db: Db | Tx,
  entry: {
    actorUserId?: string | null;
    actorType: AuditActorType;
    action: AuditAction;
    subjectType: string;
    subjectId: string;
    payload?: unknown;
    /** The server's instant, when a rule reads the entry back by time. */
    at?: Date;
  },
) {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    actorType: entry.actorType,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    payload: entry.payload ?? null,
    ...(entry.at ? { createdAt: entry.at } : {}),
  });
}

/** Who an audit entry names as acting: a person (through a session or a token), or the system. */
export interface AuditActor {
  actorUserId: string | null;
  actorType: AuditActorType;
}

/** The ticker, a job, a webhook: nobody asked. */
export const SYSTEM_ACTOR: AuditActor = { actorUserId: null, actorType: "system" };

/**
 * The actor of an HTTP request, for a service that audits for itself: the
 * person acting, who is not the user when a session was delegated (ADR-027),
 * `api_key` when they asked through a personal API token (ADR-022),
 * `assistant` when the teacher assistant runs a write its teacher confirmed
 * (ADR-080 P3, decision 8; the teacher is the actor user).
 */
export function actorOf(req: FastifyRequest): AuditActor {
  return {
    actorUserId: req.auth?.actorUserId ?? req.user?.id ?? null,
    actorType: req.authVia === "token" ? "api_key" : req.authVia === "assistant" ? "assistant" : "user",
  };
}

/** A payload with the assistant's tool beside it, when the request is the assistant's (ADR-080 P3, decision 8). */
function withAssistTool(req: FastifyRequest, payload: unknown): unknown {
  if (req.authVia !== "assistant" || !req.assistTool) return payload;
  if (payload === undefined || payload === null) return { assistTool: req.assistTool };
  if (typeof payload === "object" && !Array.isArray(payload)) return { ...payload, assistTool: req.assistTool };
  return payload;
}

/** What {@link tracer} hands a route module: one line per audited write. */
type Trace = (
  req: FastifyRequest,
  action: AuditAction,
  subjectType: string,
  subjectId: string,
  payload?: unknown,
) => Promise<void>;

/**
 * The audit entry of a route, with the four constant fields already filled:
 * the actor is the caller, and the actor type is `user` because an HTTP route
 * is by definition something a person asked for — or `api_key` when that
 * person asked through a personal API token (ADR-022), an MCP client
 * included. Everything a call site still has to say is what happened and to
 * what.
 *
 * `action` stays an {@link AuditAction}, so a typo at a trigger site is a
 * compile error (invariant 9). Every audited route today runs behind a
 * session or a token, so the actor is never null; the `?? null` is defensive only, for
 * the column is nullable and a public route could one day be audited.
 */
export function tracer(app: FastifyInstance): Trace {
  return (req, action, subjectType, subjectId, payload) => {
    const recorded = withAssistTool(req, payload);
    return audit(app.db, {
      ...actorOf(req),
      action,
      subjectType,
      subjectId,
      ...(recorded === undefined ? {} : { payload: recorded }),
    });
  };
}
