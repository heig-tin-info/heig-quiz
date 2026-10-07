/**
 * Opaque server-side sessions (AU-06): a random 256-bit token is handed to
 * the browser, only its SHA-256 is persisted; a leak of the table does not
 * allow replaying a session. Invalidation = DELETE.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, inArray, isNotNull, lt, lte, or, sql, type SQL } from "drizzle-orm";

import type { SessionKind } from "@quiz/contracts";
import { TRUSTED_CLIENTS, isTrustedClient, type TrustedClient } from "@quiz/domain";

import { audit } from "../audit.js";
import type { Db, Tx } from "../db/client.js";
import { kioskDevices, sessions, users } from "../db/schema.js";
import * as bus from "../modules/realtime/bus.js";

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
 * set on a confined session only (`seb`, `kiosk`: ADR-027, ADR-051) — or,
 * on a `seb` session of an `online_seb` project, `projectId` instead (D21,
 * M6-07: one activity per confined session). Absent `projectId` reads null.
 */
export interface SessionAuth {
  kind: SessionKind;
  actorUserId: string | null;
  evaluationId: string | null;
  projectId?: string | null;
}

/** What a confined session is confined to (D21): ONE evaluation, or ONE project. */
export type Activity = "evaluation" | "project";

/** The activity of a confined session: a project when it names one, an evaluation otherwise. */
export const activityOf = (auth: Pick<SessionAuth, "projectId">): Activity =>
  (auth.projectId ?? null) !== null ? "project" : "evaluation";

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
  /**
   * The Config Key a `seb` session was launched with (ADR-051 §3); null on
   * every other kind. A project's workspace launch carries it to the portal
   * (D21 point 4): a hash of the student's own `.seb`, not a secret.
   */
  sebConfigKey: string | null;
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
  bus.accessRevoked([userId]);
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
 * (`TRUSTED_CLIENTS`: `seb`, `kiosk`), opened for ONE activity — to sit one
 * evaluation, `evaluationId`, or (a `seb` one, D21) to work in one
 * project's workspace, `projectId` — and nothing else.
 */
export const confined = <A extends Pick<SessionAuth, "kind">>(
  auth: A | null | undefined,
): auth is A & { kind: TrustedClient } => auth != null && isTrustedClient(auth.kind);

/**
 * What opening a session records beside its {@link SessionAuth}: the proof a
 * confined session is later checked against on every request (ADR-051 §1,
 * `trust.ts`). The Config Key of a `seb` launch (hex), the station of a
 * `kiosk` one; absent on every other kind.
 */
export interface NewSession extends SessionAuth {
  sebConfigKey?: string | null;
  deviceId?: string | null;
}

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
 * The route config of the routes a `seb` session of a project may call (D21,
 * M6-07): its project's student page and *Open workspace*. An evaluation's
 * confined session is not there on them, as a project's is not on `SITTING`.
 */
export const PROJECT_SEB = { sessions: ["portal", "seb"], activities: ["project"] } as const;

/** What a route declares of the sessions it serves (`FastifyContextConfig`). */
export interface RouteSessions {
  /** The kinds it serves; absent, `portal` only. */
  sessions?: readonly SessionKind[];
  /** The activities a confined session it serves may be confined to; absent, an evaluation only. */
  activities?: readonly Activity[];
}

/**
 * Whether a route declaring `route` serves the session `auth`: its kind
 * (absent: `portal` only) and, for a confined one, its activity (absent: an
 * evaluation only, ADR-027 — a project's `seb` session reaches only the
 * routes that say `project`, D21). An `impersonation` session is the
 * student's portal, seen by somebody else (ADR-034): it reaches the
 * `portal` routes, and whether it may WRITE through them is the read-only
 * rule of `plugin.ts`, not this.
 */
export function serves(route: RouteSessions, auth: Pick<SessionAuth, "kind" | "projectId">): boolean {
  if (!(route.sessions ?? ["portal"]).includes(auth.kind === "impersonation" ? "portal" : auth.kind)) return false;
  return !confined(auth) || (route.activities ?? ["evaluation"]).includes(activityOf(auth));
}

export async function createSession(
  db: Db,
  userId: string,
  ttlHours: number,
  auth: NewSession = PORTAL,
) {
  const token = newToken();
  const csrf = newToken();
  const now = new Date();
  const hours = FIXED_HOURS[auth.kind] ?? ttlHours;
  const expiresAt = new Date(now.getTime() + hours * 3_600_000);
  // Field by field: a session is never born with Super Powers (ADR-054).
  const row = {
    sidHash: hashToken(token),
    userId,
    expiresAt,
    kind: auth.kind,
    actorUserId: auth.actorUserId,
    evaluationId: auth.evaluationId,
    projectId: auth.projectId ?? null,
    sebConfigKey: auth.sebConfigKey ?? null,
    deviceId: auth.deviceId ?? null,
  };
  if (!confined(auth)) {
    await db.insert(sessions).values(row);
    return { token, csrf, expiresAt };
  }
  const superseded = await db.transaction(async (tx) => {
    const gone = await supersede(tx, userId, auth);
    await tx.insert(sessions).values(row);
    return gone;
  });
  // After the commit: a stream closed earlier could reconnect on a session
  // the rollback kept. The dashboard is an evaluation's.
  bus.sessionsEnded(superseded.map((s) => s.sidHash));
  for (const pair of pairsOf(superseded)) {
    if (pair.subjectType === "evaluation") {
      bus.dashboardAlert({ userId: pair.userId, evaluationId: pair.subjectId, kind: "session_superseded", at: now });
    }
  }
  return { token, csrf, expiresAt };
}

/** A removed session, as {@link dropSessions} returns it. */
type Dropped = Awaited<ReturnType<typeof dropSessions>>[number];

/** The distinct (user, activity) pairs of removed confined sessions, with their kinds. */
function pairsOf(gone: readonly Dropped[]) {
  const pairs = new Map<string, { userId: string; subjectType: Activity; subjectId: string; kinds: SessionKind[] }>();
  for (const s of gone) {
    const subjectId = s.evaluationId ?? s.projectId;
    if (subjectId === null) continue;
    const key = `${s.userId} ${subjectId}`;
    const pair = pairs.get(key) ?? { userId: s.userId, subjectType: activityOf(s), subjectId, kinds: [] };
    pair.kinds.push(s.kind);
    pairs.set(key, pair);
  }
  return [...pairs.values()];
}

/**
 * One confined session at a time (ADR-051 §4): opening one for (user,
 * activity) deletes every other confined session of that pair, and every
 * session still holding its station, expired rows included — before the
 * insert, in its transaction, so the partial unique index on `device_id`
 * holds. Portal and impersonation sessions are never touched: the phone that
 * approves a pairing is one, and so is a teacher's portal beside a SEB
 * rehearsal. One audit entry per removed (user, activity), naming that
 * pair — a station may have carried another student — with the kinds and
 * the station's label; never a token.
 */
async function supersede(tx: Tx, userId: string, auth: NewSession & { kind: TrustedClient }) {
  const projectId = auth.projectId ?? null;
  // Two launches of the same pair at once would each delete the other's
  // (not yet committed) row and both insert: the second waits here for the
  // first to commit, then sees and removes its session. Namespaced, so it
  // never shares a key with the access-code lock of the same pair.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`confined-session:${userId}:${projectId ?? auth.evaluationId}`}, 0))`,
  );
  const pair = and(
    eq(sessions.userId, userId),
    projectId !== null ? eq(sessions.projectId, projectId) : eq(sessions.evaluationId, auth.evaluationId!),
    inArray(sessions.kind, TRUSTED_CLIENTS),
  )!;
  const gone = await dropSessions(
    tx,
    auth.deviceId ? or(pair, eq(sessions.deviceId, auth.deviceId))! : pair,
    "superseded",
  );
  const device = auth.deviceId
    ? (await tx.select({ label: kioskDevices.label }).from(kioskDevices).where(eq(kioskDevices.id, auth.deviceId)))[0]
    : undefined;
  for (const removed of pairsOf(gone)) {
    await audit(tx, {
      actorUserId: userId,
      actorType: "user",
      action: "auth.session_superseded",
      subjectType: removed.subjectType,
      subjectId: removed.subjectId,
      payload: {
        userId: removed.userId,
        kinds: removed.kinds,
        by: auth.kind,
        ...(device && { device: device.label }),
      },
    });
  }
  return gone;
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
        projectId: sessions.projectId,
        superPowersUntil: sessions.superPowersUntil,
        sebConfigKey: sessions.sebConfigKey,
      },
      deviceId: sessions.deviceId,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.sidHash, hashToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await endSessions(db, eq(sessions.sidHash, row.sidHash), "expired");
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
      await endSessions(db, eq(sessions.sidHash, row.sidHash), "revoked");
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
  return {
    user: row.user,
    auth,
    renewedTo,
    /** The session's id as the server knows it: how its streams are found (`bus.sessionsEnded`). */
    sidHash: row.sidHash,
    sebConfigKey: row.auth.sebConfigKey,
    deviceId: row.deviceId,
  };
}

/**
 * THE way a session row goes, and the one owner of what the audit says about
 * it. Signing out writes `auth.logout` — or, for a delegated session,
 * `impersonation.ended`, the admin as actor and the student as subject: the
 * student signed out of nothing (ADR-034). A delegated session that expires
 * or loses its actor's right is ended by the system, the admin named in the
 * payload. An ordinary session that expires leaves nothing, as before —
 * except the end of its Super Powers, when they were still on (ADR-054):
 * `logout` if the admin signed out within the hour, `expired` otherwise. One
 * superseded by a new confined session is audited by `supersede`.
 *
 * It returns the rows it removed: whoever called it ends their event streams
 * (`bus.sessionsEnded`) once the deletion is committed ({@link endSessions}).
 */
async function dropSessions(
  db: Db | Tx,
  where: SQL,
  reason: "logout" | "expired" | "revoked" | "superseded" | "ended",
  now: Date = new Date(),
) {
  const gone = await db.delete(sessions).where(where).returning({
    sidHash: sessions.sidHash,
    userId: sessions.userId,
    actorUserId: sessions.actorUserId,
    kind: sessions.kind,
    evaluationId: sessions.evaluationId,
    projectId: sessions.projectId,
    deviceId: sessions.deviceId,
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
  return gone;
}

/**
 * {@link dropSessions} outside a transaction, and the streams of what it
 * removed closed. Returns how many went.
 */
async function endSessions(
  db: Db,
  where: SQL,
  reason: "logout" | "expired" | "revoked" | "ended",
  now: Date = new Date(),
): Promise<number> {
  const gone = await dropSessions(db, where, reason, now);
  bus.sessionsEnded(gone.map((s) => s.sidHash));
  return gone.length;
}

/**
 * ADR-051 §7: the `kiosk` sessions that sit `evaluationId` — of these users,
 * or of everybody when `userIds` is absent (the evaluation closed) —
 * deleted in one statement, and their event streams closed. The users'
 * other sessions stay: the phone's portal, and a `seb` session, which
 * outlives the submit (ADR-027). `live` calls it wherever an attempt ends,
 * after it has emitted `attempt.closed`, so the station's stream carries
 * that frame before it closes.
 */
export async function endKioskSessions(
  db: Db,
  evaluationId: string,
  userIds?: readonly string[],
): Promise<void> {
  if (userIds !== undefined && userIds.length === 0) return;
  await endSessions(
    db,
    and(
      eq(sessions.kind, "kiosk"),
      eq(sessions.evaluationId, evaluationId),
      userIds === undefined ? undefined : inArray(sessions.userId, [...userIds]),
    )!,
    "ended",
  );
}

/**
 * ADR-051 §5: the session a station holds, deleted and its event stream
 * closed — a retired station sits nothing more, not even until its next
 * request.
 */
export async function endStationSessions(db: Db, deviceId: string): Promise<void> {
  await endSessions(db, eq(sessions.deviceId, deviceId), "revoked");
}

export async function deleteSession(db: Db, token: string, now: Date = new Date()) {
  await endSessions(db, eq(sessions.sidHash, hashToken(token)), "logout", now);
}

/**
 * Purge of expired sessions, the scheduled task `sessions.purge`
 * (`modules/system/catalog.ts`). Returns how many went.
 */
export async function purgeExpiredSessions(db: Db, now: Date = new Date()): Promise<number> {
  return endSessions(db, lt(sessions.expiresAt, now), "expired", now);
}
