import { randomUUID } from "node:crypto";

import { and, eq, exists, isNull, ne, sql } from "drizzle-orm";
import { parseRosterCsv, rosterFromRows, type Cell, type RosterParse } from "@quiz/domain";

import { audit } from "../../audit.js";
import { publish } from "../../events.js";
import type { Db } from "../../db/client.js";
import {
  avatars,
  classrooms,
  courseStaff,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  userEmails,
  users,
} from "../../db/schema.js";
import { emailIn, knownEmails, normalizeEmail, sharedWithOthers } from "../../identity.js";
import { shownAvatar } from "../avatar.js";
import { notifyMany } from "../notifications/service.js";
import { rosterConflict, studentJoined } from "../realtime/bus.js";

interface RosterImportSummary {
  inserted: number;
  updated: number;
}

/**
 * Atomic roster import (AU-14/16): upsert by (classroom, email); existing
 * entries keep their claim status, only last/first name are refreshed.
 * No implicit deletion.
 */
export async function importRoster(
  db: Db,
  classroomId: string,
  source: { csv: string } | { rows: Cell[][] },
): Promise<{ parse: RosterParse; summary?: RosterImportSummary }> {
  const parse = "csv" in source ? parseRosterCsv(source.csv) : rosterFromRows(source.rows);
  if (!parse.ok) return { parse };

  let inserted = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const row of parse.rows) {
      const [res] = await tx
        .insert(enrollments)
        .values({
          id: randomUUID(),
          classroomId,
          nom: row.nom,
          prenom: row.prenom,
          email: row.email,
          timeBonusPercent: row.timeBonusPercent,
        })
        .onConflictDoUpdate({
          target: [enrollments.classroomId, enrollments.email],
          // The accommodation column is only written when the sheet carries
          // one: re-importing a list without it must not wipe a bonus the
          // teacher set by hand.
          set: {
            nom: row.nom,
            prenom: row.prenom,
            ...(row.timeBonusPercent > 0 ? { timeBonusPercent: row.timeBonusPercent } : {}),
          },
        })
        .returning({ claimedAt: enrollments.claimedAt, userId: enrollments.userId });
      // xmax = 0 is Postgres's insert marker, but let's stay portable:
      // we count as "inserted" what was not yet claimed nor known.
      if (res && res.userId === null && res.claimedAt === null) inserted += 1;
      else updated += 1;
    }
  });
  // A line just added is claimed by its holder's next own request, not by
  // this import (ADR-053, addendum of 2026-10-11).
  rosterChanged();
  // Fine-grained insert/update counting will come with a real need; what
  // matters is atomicity and idempotent replay.
  return { parse, summary: { inserted, updated } };
}

/** What happened to a classroom's roster, as its staff are told of it. */
interface RosterEvent {
  kind: "student_joined" | "roster_conflict";
  courseId: string;
  classroomId: string;
  classroomName: string;
  count: number;
  /** Whose action raised it: never told of it (ADR-030 addendum §c). */
  actorId: string;
}

/**
 * Tells the course's staff what happened to a classroom's roster: a
 * notification to each STAFF SEAT (the rows `staffAccess` reads — an admin
 * without a seat is not told), never to the person who acted, folded per
 * classroom by the notifications module (ADR-030 §e). The payload is a count
 * and the classroom: no name, no address. Call it after the write has
 * committed.
 *
 * BEST-EFFORT: it runs inside a login and a person's own request (their
 * claim), and inside the heig-classroom import, none of which may fail
 * because telling the staff did. A
 * failure is logged and swallowed; the roster itself is already right.
 */
async function tellStaff(db: Db, event: RosterEvent): Promise<void> {
  const { kind, classroomId, classroomName, count } = event;
  try {
    const seats = await db
      .select({ userId: courseStaff.userId })
      .from(courseStaff)
      .where(and(eq(courseStaff.courseId, event.courseId), ne(courseStaff.userId, event.actorId)));
    await notifyMany(
      db,
      seats.map((seat) => ({ userId: seat.userId, payload: { kind, classroomId, classroomName, count } })),
    );
  } catch (err) {
    // The service layer has no logger (as `realtime/bus.ts`): stderr, which
    // the process log collects.
    console.error(`roster: telling the staff of ${kind} in ${classroomId} failed`, err);
  }
}

type RoomCount = Omit<RosterEvent, "kind" | "actorId">;

/** One more event in its classroom's tally. */
function countIn(
  rooms: Map<string, RoomCount>,
  { courseId, classroomId, classroomName }: Omit<RoomCount, "count">,
) {
  const room = rooms.get(classroomId) ?? { courseId, classroomId, classroomName, count: 0 };
  room.count += 1;
  rooms.set(classroomId, room);
}

/** A pending roster line, and the account a claim pass would attach it to. */
export interface ClaimMatch {
  entryId: string;
  userId: string;
  classroomId: string;
  classroomName: string;
  courseId: string;
  /** Another account, or another line of the classroom, could claim it too. */
  ambiguous: boolean;
}

/**
 * Settles one claim pass. The person's own claim (at sign-in, or at their
 * next own request: `claimOnOwnRequest`) and the heig-classroom import's
 * both end here, so every conflict ends the same way (AU-21): an ambiguous match is
 * flagged; any other is attached, and flagged instead when the account
 * already holds a line of that classroom (UNIQUE(classroom_id, user_id)).
 *
 * A flag newly raised is audited, and the course's staff hear of it once per
 * classroom, with a count (#198) — never `actorId`, whose action ran the
 * pass. A line already flagged waits for a teacher: it is not said again.
 */
async function settleClaims<M extends ClaimMatch>(
  db: Db,
  matches: M[],
  actorId: string,
  onClaimed: (match: M) => void,
): Promise<number> {
  const conflicts = new Map<string, RoomCount>();

  async function flagConflict(match: M) {
    const [raised] = await db
      .update(enrollments)
      .set({ conflictFlag: true })
      .where(and(eq(enrollments.id, match.entryId), eq(enrollments.conflictFlag, false)))
      .returning({ id: enrollments.id });
    if (!raised) return;
    await audit(db, {
      actorUserId: match.userId,
      actorType: "system",
      action: "roster.claim_conflict",
      subjectType: "enrollment",
      subjectId: match.entryId,
    });
    countIn(conflicts, match);
  }

  let claimed = 0;
  for (const match of matches) {
    if (match.ambiguous) {
      await flagConflict(match);
      continue;
    }
    let attached: { id: string } | undefined;
    try {
      [attached] = await db
        .update(enrollments)
        .set({ userId: match.userId, claimedAt: new Date() })
        .where(and(eq(enrollments.id, match.entryId), isNull(enrollments.userId)))
        .returning({ id: enrollments.id });
    } catch {
      await flagConflict(match);
      continue;
    }
    // Claimed in the meantime by someone else: nothing happened here.
    if (!attached) continue;
    claimed += 1;
    await audit(db, {
      actorUserId: match.userId,
      actorType: "system",
      action: "roster.claim",
      subjectType: "enrollment",
      subjectId: match.entryId,
    });
    onClaimed(match);
  }
  for (const room of conflicts.values()) {
    rosterConflict({ courseId: room.courseId, actorId });
    await tellStaff(db, { kind: "roster_conflict", ...room, actorId });
  }
  return claimed;
}

/**
 * A claim pass on matches the caller found itself: the heig-classroom import
 * (M1-06) carries over the claims of its source rosters. Same settlement as
 * every claim. Inside a transaction the caller marks `ambiguous` a match
 * whose account already holds a line of the classroom: the unique violation
 * `settleClaims` otherwise catches would abort the transaction.
 */
export async function claimLines(db: Db, matches: ClaimMatch[], actorId: string): Promise<number> {
  return settleClaims(db, matches, actorId, (m) =>
    publish("roster", [`classroom:${m.classroomId}`, `user:${m.userId}`]),
  );
}

/**
 * Automatic claim at login (AU-18, H3), and at the person's next own request
 * (`claimOnOwnRequest`): every `pending` entry whose e-mail is one of the
 * account's known addresses (GH-11 — the login address, or an institutional
 * one asserted by edu-ID) is attached to the user. Only the person's own
 * action runs it, never a staff write (ADR-053, addendum of 2026-10-11):
 * attaching on a teacher's import would show the staff the account of
 * someone who never came, and let any address on a list link it.
 *
 * Nothing is attached on an ambiguous match. Three ways to be ambiguous:
 * the entry's address is also held by another account; several entries of
 * the SAME classroom match this account; the account already holds an entry
 * there. All three end the same way — `conflict_flag`, for a teacher to
 * resolve (AU-21) — because guessing would put a grade on the wrong person.
 */
export async function claimEnrollments(db: Db, user: { id: string }) {
  const emails = await knownEmails(db, user.id);
  if (emails.length === 0) return 0;

  const pending = await db
    .select({
      entryId: enrollments.id,
      classroomId: enrollments.classroomId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      courseId: classrooms.courseId,
      classroomName: classrooms.name,
    })
    .from(enrollments)
    .innerJoin(classrooms, eq(classrooms.id, enrollments.classroomId))
    .where(and(isNull(enrollments.userId), emailIn(enrollments.email, emails)));
  if (pending.length === 0) return 0;

  const shared = await sharedWithOthers(
    db,
    user.id,
    pending.map((e) => e.email),
  );
  const perClassroom = new Map<string, number>();
  for (const entry of pending) {
    perClassroom.set(entry.classroomId, (perClassroom.get(entry.classroomId) ?? 0) + 1);
  }

  const matches = pending.map((entry) => ({
    ...entry,
    userId: user.id,
    ambiguous:
      shared.has(normalizeEmail(entry.email)) || perClassroom.get(entry.classroomId)! > 1,
  }));
  // The student is the actor here, and holds no staff seat to exclude.
  const joined = new Map<string, RoomCount>();
  const claimed = await settleClaims(db, matches, user.id, (entry) => {
    countIn(joined, entry);
    studentJoined({ courseId: entry.courseId, userId: user.id });
  });
  for (const room of joined.values()) {
    await tellStaff(db, { kind: "student_joined", ...room, actorId: user.id });
  }
  return claimed;
}

/**
 * Teacher's roster table: identity, claim status, accommodation, and the
 * student's linked GitHub login when the classroom is connected to GitHub
 * (05-web §5.1) — the stored login, followed on rename, never fetched here.
 */
export async function rosterView(db: Db, classroomId: string) {
  const rows = await db
    .select({
      id: enrollments.id,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      // Claimed is attached to an account; there is no other truth (D-09).
      status: sql<"pending" | "claimed">`case when ${enrollments.userId} is null then 'pending' else 'claimed' end`,
      conflictFlag: enrollments.conflictFlag,
      staff: enrollments.staff,
      timeBonusPercent: enrollments.timeBonusPercent,
      note: enrollments.note,
      claimedAt: enrollments.claimedAt,
      lastLoginAt: users.lastLoginAt,
      userId: users.id,
      pictureUrl: users.pictureUrl,
      avatarAt: avatars.updatedAt,
      githubLogin: githubAccounts.login,
    })
    .from(enrollments)
    .leftJoin(users, eq(enrollments.userId, users.id))
    .leftJoin(avatars, eq(avatars.userId, users.id))
    .leftJoin(
      githubAccounts,
      and(
        eq(githubAccounts.userId, users.id),
        exists(
          db
            .select({ one: sql`1` })
            .from(githubClassroomLinks)
            .where(eq(githubClassroomLinks.classroomId, classroomId)),
        ),
      ),
    )
    .where(eq(enrollments.classroomId, classroomId))
    .orderBy(enrollments.nom, enrollments.prenom);
  return rows.map(({ avatarAt, pictureUrl, claimedAt, ...r }) => ({
    ...r,
    lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
    avatarUrl: shownAvatar(r.userId, avatarAt, pictureUrl),
  }));
}

/**
 * Bumped by every roster write after which a pending line may be claimable
 * by someone it was not before: an import (a line added), and the writes of
 * `afterRevocation` (an e-mail changed, a claim revoked, a line removed that
 * held the account's seat). What `claimOnOwnRequest` compares, so a line a
 * teacher adds in the lobby is claimed at its holder's next request.
 */
let rosterEpoch = 0;

export function rosterChanged(): void {
  rosterEpoch += 1;
}

/**
 * The portal sessions that already ran their claim, with the roster epoch
 * they ran it at — the pass itself, so the requests of one page load wait on
 * one pass instead of each starting their own. In memory (one process,
 * ADR-001, as the event bus), bounded: the oldest entry goes first, and a
 * session it forgot only runs its cheap check once more.
 */
const claimedSessions = new Map<string, { epoch: number; pass: Promise<number> }>();
const CLAIMED_SESSIONS_MAX = 10_000;

/** Whether one of the account's verified addresses is on a pending line: one indexed query. */
async function hasClaimableLine(db: Db, userId: string): Promise<boolean> {
  const [hit] = await db
    .select({ one: sql`1` })
    .from(userEmails)
    .innerJoin(
      enrollments,
      and(sql`lower(${enrollments.email}) = ${userEmails.email}`, isNull(enrollments.userId)),
    )
    .where(and(eq(userEmails.userId, userId), eq(userEmails.verified, true)))
    .limit(1);
  return hit !== undefined;
}

/**
 * The claim at the person's own next request (ADR-053, addendum of
 * 2026-10-11): `claimEnrollments`, on the addresses the account already
 * holds, run by the auth hook for the account's OWN portal session only —
 * never an impersonation, a `seb` or `kiosk` session, nor a bearer token.
 * At most once per session between two roster writes (`rosterChanged`),
 * and only when a line is there to claim. Resolves to the lines claimed.
 */
export function claimOnOwnRequest(db: Db, sessionId: string, userId: string): Promise<number> {
  const epoch = rosterEpoch;
  const known = claimedSessions.get(sessionId);
  if (known?.epoch === epoch) return known.pass;
  const pass = hasClaimableLine(db, userId).then((found) =>
    found ? claimEnrollments(db, { id: userId }) : 0,
  );
  claimedSessions.delete(sessionId);
  claimedSessions.set(sessionId, { epoch, pass });
  if (claimedSessions.size > CLAIMED_SESSIONS_MAX) {
    claimedSessions.delete(claimedSessions.keys().next().value!);
  }
  // A pass that failed is not remembered: the next request runs it again.
  pass.catch(() => {
    if (claimedSessions.get(sessionId)?.pass === pass) claimedSessions.delete(sessionId);
  });
  return pass;
}

/** A session that ended (sign-out) leaves the guard of `claimOnOwnRequest`. */
export function forgetClaimedSession(sessionId: string): void {
  claimedSessions.delete(sessionId);
}
