/**
 * Opaque server-side sessions (AU-06): a random 256-bit token is handed to
 * the browser, only its SHA-256 is persisted; a leak of the table does not
 * allow replaying a session. Invalidation = DELETE.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNotNull, lt, lte, type SQL } from "drizzle-orm";

import type { SessionKind } from "@quiz/contracts";
import { isTrustedClient, type TrustedClient } from "@quiz/domain";

import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { accessRevoked } from "../modules/realtime/bus.js";

export const SESSION_COOKIE = "quiz_session";
export const CSRF_COOKIE = "quiz_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What a session is, as the rest of the API sees it (ADR-027); modules read
 * this, never the columns. `actorUserId` is null when the user acts for
 * themself (set on an `impersonation` session, ADR-034); `evaluationId` is
 * set on a confined session only (`seb`, `kiosk`: ADR-027, ADR-051).
 */
export interface SessionAuth {
  kind: SessionKind;
  actorUserId: string | null;
  evaluationId: string | null;
}

export const PORTAL: SessionAuth = { kind: "portal", actorUserId: null, evaluationId: null };

/**
 * A session as a request found it: what it is, plus the end of its Super
 * Powers (ADR-054) — null when they are off. A value in the past never
 * reaches a request: `findSessionUser` expires it first. Whether the
 * request reaches everyone's content is `reachOf` in `modules/guards.ts`,
 * the one reader of this field.
 */
export interface SessionState extends SessionAuth {
  superPowersUntil: Date | null;
}

/** How long Super Powers last once switched on: one fixed hour, never extended (ADR-054). */
export const SUPER_POWERS_MS = 3_600_000;

export type SuperPowersEnd = "manual" | "expired" | "logout";

/**
 * THE record of Super Powers going off, whoever notices: the audit entry
 * (the admin as actor when they asked for it, the system otherwise), and
 * the admin's open streams closed, so they reconnect with the topics of
 * their ordinary reach (invariant 6; `accessRevoked`).
 */
export async function superPowersEnded(db: Db, userId: string, reason: SuperPowersEnd) {
  const byUser = reason !== "expired";
  await audit(db, {
    actorUserId: byUser ? userId : null,
    actorType: byUser ? "user" : "system",
    action: "superpowers.disabled",
    subjectType: "user",
    subjectId: userId,
    payload: { reason },
  });
  accessRevoked([userId]);
}

/**
 * Clears the Super Powers whose hour has passed by the server's clock
 * (invariant 5), and records each end once: the conditional UPDATE is what
 * keeps the request that notices it and the sweep of the ticker from both
 * writing `expired`. `where` narrows it to one session. Returns how many
 * it ended. Run by the request that finds them (`findSessionUser`) and by
 * the ticker's `superpowers.expire` task, so an open stream holds a reach
 * that has ended for one ticker period at most.
 */
export async function expireSuperPowers(db: Db, now: Date, where?: SQL): Promise<number> {
  const ended = await db
    .update(sessions)
    .set({ superPowersUntil: null })
    .where(and(isNotNull(sessions.superPowersUntil), lte(sessions.superPowersUntil, now), where))
    .returning({ userId: sessions.userId });
  for (const row of ended) await superPowersEnded(db, row.userId, "expired");
  return ended.length;
}

/**
 * THE predicate for "somebody else acts through this session" (ADR-034):
 * read-only outside development, never a body in the room, never a `.seb`.
 * Every site that treats a delegated session apart asks this, not the kind.
 */
export const delegated = (auth: Pick<SessionAuth, "actorUserId"> | null): boolean =>
  (auth?.actorUserId ?? null) !== null;

/**
 * A confined session (ADR-027, ADR-051): one of a trusted client's kinds
 * (`TRUSTED_CLIENTS`: `seb`, `kiosk`), opened to sit ONE evaluation,
 * `evaluationId`, and nothing else.
 */
export const confined = <A extends Pick<SessionAuth, "kind">>(
  auth: A | null | undefined,
): auth is A & { kind: TrustedClient } => auth != null && isTrustedClient(auth.kind);

/**
 * The lifetime of each kind: fixed hours, never renewed — or null for
 * SESSION_TTL_HOURS with sliding renewal. A `seb` session outlives any sitting;
 * a `kiosk` one is as long but ends with its attempt (ADR-051 §4, §7); an
 * `impersonation` one is an hour of looking over a student's shoulder (ADR-034).
 */
const FIXED_HOURS: Record<SessionKind, number | null> = {
  portal: null,
  seb: 6,
  impersonation: 1,
  kiosk: 6,
};

/**
 * The route config of the routes a confined session (`seb`, `kiosk`) may
 * call: sitting its evaluation (ADR-027 §3, ADR-051 §1).
 */
export const SITTING = { sessions: ["portal", "seb", "kiosk"] } as const;

/**
 * Whether a route declaring `routeKinds` (absent: `portal` only) serves a
 * session of `kind`. An `impersonation` session is the student's portal, seen
 * by somebody else (ADR-034): it reaches the `portal` routes, and whether it
 * may WRITE through them is the read-only rule of `plugin.ts`, not this.
 */
export function serves(routeKinds: readonly SessionKind[] | undefined, kind: SessionKind): boolean {
  return (routeKinds ?? ["portal"]).includes(kind === "impersonation" ? "portal" : kind);
}

export async function createSession(
  db: Db,
  userId: string,
  ttlHours: number,
  auth: SessionAuth = PORTAL,
) {
  const token = newToken();
  const csrf = newToken();
  const hours = FIXED_HOURS[auth.kind] ?? ttlHours;
  const expiresAt = new Date(Date.now() + hours * 3_600_000);
  // Field by field: a session is never born with Super Powers (ADR-054).
  const { kind, actorUserId, evaluationId } = auth;
  await db
    .insert(sessions)
    .values({ sidHash: hashToken(token), userId, expiresAt, kind, actorUserId, evaluationId });
  return { token, csrf, expiresAt };
}

export async function findSessionUser(
  db: Db,
  token: string,
  opts?: { renewTtlHours?: number; now?: Date },
) {
  const rows = await db
    .select({
      user: users,
      expiresAt: sessions.expiresAt,
      sidHash: sessions.sidHash,
      auth: {
        kind: sessions.kind,
        actorUserId: sessions.actorUserId,
        evaluationId: sessions.evaluationId,
        superPowersUntil: sessions.superPowersUntil,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.sidHash, hashToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await dropSessions(db, eq(sessions.sidHash, row.sidHash), "expired");
    return null;
  }
  // Super Powers end at their hour by the SERVER's clock (ADR-054): the
  // first request past it finds them off, and says so in the audit.
  // `expireSuperPowers`'s WHERE is the one comparison with the clock.
  const auth: SessionState = row.auth;
  if (
    auth.superPowersUntil !== null &&
    (await expireSuperPowers(db, opts?.now ?? new Date(), eq(sessions.sidHash, row.sidHash))) > 0
  ) {
    auth.superPowersUntil = null;
  }
  // The right to act as somebody is the actor's role, read on every request:
  // an admin demoted mid-hour loses the session at once (ADR-034).
  if (delegated(row.auth)) {
    const [actor] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, row.auth.actorUserId!))
      .limit(1);
    if (actor?.role !== "admin") {
      await dropSessions(db, eq(sessions.sidHash, row.sidHash), "revoked");
      return null;
    }
  }
  // Sliding renewal: once less than half the TTL remains, push the expiry
  // back to a full TTL. Active users stay signed in indefinitely; an idle
  // session still dies after SESSION_TTL_HOURS. At most one UPDATE per
  // half-TTL window, so the per-request cost stays nil. A kind with a fixed
  // lifetime never slides (ADR-027).
  let renewedTo: Date | null = null;
  const ttlMs = FIXED_HOURS[row.auth.kind] === null ? (opts?.renewTtlHours ?? 0) * 3_600_000 : 0;
  if (ttlMs > 0 && row.expiresAt.getTime() - Date.now() < ttlMs / 2) {
    renewedTo = new Date(Date.now() + ttlMs);
    await db
      .update(sessions)
      .set({ expiresAt: renewedTo })
      .where(eq(sessions.sidHash, row.sidHash));
  }
  // The renewal above moves `expires_at` alone: it never touches Super Powers.
  return { user: row.user, auth, renewedTo };
}

/**
 * THE way a session row goes, and the one owner of what the audit says about
 * it. Signing out writes `auth.logout` — or, for a delegated session,
 * `impersonation.ended`, the admin as actor and the student as subject: the
 * student signed out of nothing (ADR-034). A delegated session that expires
 * or loses its actor's right is ended by the system, the admin named in the
 * payload. An ordinary session that expires leaves nothing, as before —
 * except the end of its Super Powers, when they were still on (ADR-054):
 * `logout` if the admin signed out within the hour, `expired` otherwise.
 */
async function dropSessions(
  db: Db,
  where: SQL,
  reason: "logout" | "expired" | "revoked",
  now: Date = new Date(),
): Promise<number> {
  const gone = await db
    .delete(sessions)
    .where(where)
    .returning({
      userId: sessions.userId,
      actorUserId: sessions.actorUserId,
      superPowersUntil: sessions.superPowersUntil,
    });
  for (const session of gone) {
    if (session.superPowersUntil !== null) {
      const live = reason === "logout" && session.superPowersUntil.getTime() > now.getTime();
      await superPowersEnded(db, session.userId, live ? "logout" : "expired");
    }
    const subject = { subjectType: "user", subjectId: session.userId } as const;
    if (delegated(session)) {
      const byActor = reason === "logout";
      await audit(db, {
        actorUserId: byActor ? session.actorUserId : null,
        actorType: byActor ? "user" : "system",
        action: "impersonation.ended",
        ...subject,
        payload: byActor ? { reason } : { reason, actorUserId: session.actorUserId },
      });
    } else if (reason === "logout") {
      await audit(db, { actorUserId: session.userId, actorType: "user", action: "auth.logout", ...subject });
    }
  }
  return gone.length;
}

export async function deleteSession(db: Db, token: string, now: Date = new Date()) {
  await dropSessions(db, eq(sessions.sidHash, hashToken(token)), "logout", now);
}

/**
 * Purge of expired sessions, the scheduled task `sessions.purge`
 * (`modules/system/catalog.ts`). Returns how many went.
 */
export async function purgeExpiredSessions(db: Db, now: Date = new Date()): Promise<number> {
  return dropSessions(db, lt(sessions.expiresAt, now), "expired", now);
}
