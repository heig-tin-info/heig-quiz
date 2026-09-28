/**
 * Opaque server-side sessions (AU-06): a random 256-bit token is handed to
 * the browser, only its SHA-256 is persisted; a leak of the table does not
 * allow replaying a session. Invalidation = DELETE.
 */
import { createHash, randomBytes } from "node:crypto";

import { eq, lt, type SQL } from "drizzle-orm";

import type { SessionKind } from "@quiz/contracts";

import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";

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
 * set on a `seb` session only.
 */
export interface SessionAuth {
  kind: SessionKind;
  actorUserId: string | null;
  evaluationId: string | null;
}

export const PORTAL: SessionAuth = { kind: "portal", actorUserId: null, evaluationId: null };

/**
 * The lifetime of each kind: fixed hours, never renewed — or null for
 * SESSION_TTL_HOURS with sliding renewal. A `seb` session outlives any sitting;
 * an `impersonation` one is an hour of looking over a student's shoulder (ADR-034).
 */
const FIXED_HOURS: Record<SessionKind, number | null> = { portal: null, seb: 6, impersonation: 1 };

/** The route config of the routes a `seb` session may call: sitting its evaluation. */
export const SITTING = { sessions: ["portal", "seb"] } as const;

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
  await db.insert(sessions).values({ sidHash: hashToken(token), userId, expiresAt, ...auth });
  return { token, csrf, expiresAt };
}

export async function findSessionUser(db: Db, token: string, opts?: { renewTtlHours?: number }) {
  const rows = await db
    .select({
      user: users,
      expiresAt: sessions.expiresAt,
      sidHash: sessions.sidHash,
      auth: { kind: sessions.kind, actorUserId: sessions.actorUserId, evaluationId: sessions.evaluationId },
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
  return { user: row.user, auth: row.auth, renewedTo };
}

/**
 * THE way a session row goes: signed out, or found expired (on use or by the
 * purge). An `impersonation` session leaves an `impersonation.ended` entry
 * whichever way it ends (ADR-034), the admin as actor, the student as subject.
 */
async function dropSessions(db: Db, where: SQL, reason: "logout" | "expired") {
  const gone = await db
    .delete(sessions)
    .where(where)
    .returning({ kind: sessions.kind, userId: sessions.userId, actorUserId: sessions.actorUserId });
  for (const session of gone) {
    if (session.kind !== "impersonation") continue;
    await audit(db, {
      actorUserId: session.actorUserId,
      actorType: reason === "logout" ? "user" : "system",
      action: "impersonation.ended",
      subjectType: "user",
      subjectId: session.userId,
      payload: { reason },
    });
  }
}

export async function deleteSession(db: Db, token: string) {
  await dropSessions(db, eq(sessions.sidHash, hashToken(token)), "logout");
}

/** Purge of expired sessions, run by the ticker (`ticker.ts`). */
export async function purgeExpiredSessions(db: Db) {
  await dropSessions(db, lt(sessions.expiresAt, new Date()), "expired");
}
