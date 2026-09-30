import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Db } from "./db/client.js";
import { auditLog } from "./db/schema.js";

/**
 * Closed catalogue of audit actions: a typo in a trigger site is a compile
 * error, and this union is the reference for querying the log.
 */
export type AuditAction =
  | "api_token.create"
  | "api_token.revoke"
  | "auth.dev_login"
  | "auth.login"
  | "auth.logout"
  | "auth.seb_launch"
  | "auth.seb_login"
  | "auth.seb_refused"
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
  | "classroom.join_code"
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
  /** A wrong access code typed by a student (F-EVAL-12), counted for the lockout. */
  | "evaluation.access_code_failed"
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
  | "grading.override"
  | "grading.regrade"
  | "grading.run"
  | "grading.validate"
  /** An admin opened a session as a student (ADR-034): actor the admin, subject the student. */
  | "impersonation.started"
  /** That session ended: signed out, or expired (`payload.reason`). */
  | "impersonation.ended"
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
  | "pool.share"
  | "pool.transfer"
  | "pool.unshare"
  | "pool.update"
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
  | "roster.join"
  | "roster.remove"
  | "roster.self_enroll"
  | "roster.unclaim"
  | "roster.update"
  | "tag.describe"
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
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
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
      // The person acting, who is not the user when a session was delegated (ADR-027).
      actorUserId: req.auth?.actorUserId ?? req.user?.id ?? null,
      actorType: req.authVia === "token" ? "api_key" : "user",
      action,
      subjectType,
      subjectId,
      ...(payload === undefined ? {} : { payload }),
    });
}
