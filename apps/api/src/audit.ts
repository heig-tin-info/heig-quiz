import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Db, Tx } from "./db/client.js";
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
  | "course.create"
  | "course.delete"
  | "course.staff_add"
  | "course.pools_update"
  | "course.staff_remove"
  | "course.update"
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
  /** The organization's login changed on GitHub (`payload.from`, `payload.to`, `payload.via`). */
  | "github_org.renamed"
  /** The organization no longer exists on GitHub (`status: deleted`). */
  | "github_org.deleted"
  | "grading.override"
  | "grading.regrade"
  | "grading.run"
  | "grading.validate"
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
  | "poll.keep"
  | "poll.reveal"
  | "pool.asset_upload"
  | "pool.create"
  | "pool.delete"
  | "pool.member_update"
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
   * The release (F-PROJ-14, D05; merge task M3-08b), subject the project:
   * the final scores snapshotted per repository — `payload.first` (never
   * released before: the one release M3-09 notifies), `repos` (snapshots
   * written), `scored` (with a final score). A release again is audited
   * again and rewrites the snapshots.
   */
  | "project.release"
  /**
   * A student's Accept (F-PROJ-05, merge task M3-03), subject the
   * `project_repos` row. `accept`: `payload.repo` (the student's own full
   * name), `invitation`, `protected` (false: a plan without rulesets);
   * `accept_failed`: `payload.notify` — true on the row's FIRST failure
   * only, which M3-09 tells the staff about (F-NOTIF-13), never for an
   * invitation GitHub refused (the student relinks).
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
   * invitation sent again with `push`, `payload.login`, `invitationStatus`
   * as GitHub answered.
   */
  | "project_repo.grade_override"
  | "project_repo.protection_reenabled"
  | "project_repo.invite_resent"
  | "question.copy"
  | "question.create"
  | "question.delete"
  | "question.deprecate"
  | "question.move"
  | "question.publish"
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
  | "teacher.revoke";

/**
 * Append-only audit log (NFR-05, AU-42). In production the application SQL
 * role has neither UPDATE nor DELETE on this table.
 */
export async function audit(
  db: Db | Tx,
  entry: {
    actorUserId?: string | null;
    actorType: "user" | "system" | "api_key";
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
  actorType: "user" | "system" | "api_key";
}

/** The ticker, a job, a webhook: nobody asked. */
export const SYSTEM_ACTOR: AuditActor = { actorUserId: null, actorType: "system" };

/**
 * The actor of an HTTP request, for a service that audits for itself: the
 * person acting, who is not the user when a session was delegated (ADR-027),
 * `api_key` when they asked through a personal API token (ADR-022).
 */
export function actorOf(req: FastifyRequest): AuditActor {
  return {
    actorUserId: req.auth?.actorUserId ?? req.user?.id ?? null,
    actorType: req.authVia === "token" ? "api_key" : "user",
  };
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
  return (req, action, subjectType, subjectId, payload) =>
    audit(app.db, {
      ...actorOf(req),
      action,
      subjectType,
      subjectId,
      ...(payload === undefined ? {} : { payload }),
    });
}
