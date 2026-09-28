import { randomUUID } from "node:crypto";

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { parseRosterCsv, rosterFromRows, type Cell, type RosterParse } from "@quiz/domain";

import { audit } from "../../audit.js";
import { publish } from "../../events.js";
import type { Db } from "../../db/client.js";
import { avatars, classrooms, courseStaff, enrollments, userEmails, users } from "../../db/schema.js";
import { emailIn, knownEmails, normalizeEmail, sharedWithOthers } from "../../identity.js";
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
 */
export async function tellStaff(db: Db, event: RosterEvent): Promise<void> {
  const seats = await db
    .select({ userId: courseStaff.userId })
    .from(courseStaff)
    .where(and(eq(courseStaff.courseId, event.courseId), ne(courseStaff.userId, event.actorId)));
  const { kind, classroomId, classroomName, count } = event;
  await notifyMany(
    db,
    seats.map((seat) => ({ userId: seat.userId, payload: { kind, classroomId, classroomName, count } })),
  );
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
interface Match {
  entryId: string;
  userId: string;
  classroomId: string;
  classroomName: string;
  courseId: string;
  /** Another account, or another line of the classroom, could claim it too. */
  ambiguous: boolean;
}

/**
 * Settles one claim pass. The login claim and the reverse claim both end
 * here, so every conflict ends the same way (AU-21): an ambiguous match is
 * flagged; any other is attached, and flagged instead when the account
 * already holds a line of that classroom (UNIQUE(classroom_id, user_id)).
 *
 * A flag newly raised is audited, and the course's staff hear of it once per
 * classroom, with a count (#198) — never `actorId`, whose action ran the
 * pass. A line already flagged waits for a teacher: it is not said again.
 */
async function settleClaims<M extends Match>(
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
 * Automatic claim at login (AU-18, H3): every `pending` entry whose e-mail
 * is one of the account's known addresses (GH-11 — the login address, or an
 * institutional one asserted by edu-ID) is attached to the user.
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
 * Reverse claim (after an import or an e-mail edit, by `actorId`): attaches
 * a classroom's `pending` entries to existing accounts, on the same address
 * set and the same ambiguity rules as the login claim.
 */
export async function claimForExistingUsers(db: Db, classroomId: string, actorId: string) {
  const rows = await db
    .select({
      entryId: enrollments.id,
      userId: userEmails.userId,
      classroomId: enrollments.classroomId,
      classroomName: classrooms.name,
      courseId: classrooms.courseId,
    })
    .from(enrollments)
    .innerJoin(classrooms, eq(classrooms.id, enrollments.classroomId))
    .innerJoin(
      userEmails,
      and(
        sql`lower(${enrollments.email}) = ${userEmails.email}`,
        eq(userEmails.verified, true),
      ),
    )
    .where(and(eq(enrollments.classroomId, classroomId), isNull(enrollments.userId)));

  // One entry claimed by two accounts, or one account claiming two entries
  // of this classroom: ambiguous either way.
  const usersPerEntry = new Map<string, Set<string>>();
  const entriesPerUser = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  for (const m of rows) {
    link(usersPerEntry, m.entryId, m.userId);
    link(entriesPerUser, m.userId, m.entryId);
  }

  const matches = rows.map((m) => ({
    ...m,
    ambiguous: usersPerEntry.get(m.entryId)!.size > 1 || entriesPerUser.get(m.userId)!.size > 1,
  }));
  return settleClaims(db, matches, actorId, (m) =>
    publish("roster", [`classroom:${classroomId}`, `user:${m.userId}`]),
  );
}

/** Teacher's roster table: identity, claim status, accommodation. */
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
    })
    .from(enrollments)
    .leftJoin(users, eq(enrollments.userId, users.id))
    .leftJoin(avatars, eq(avatars.userId, users.id))
    .where(eq(enrollments.classroomId, classroomId))
    .orderBy(enrollments.nom, enrollments.prenom);
  // Avatar: upload > IdP claim > (client-side initials)
  return rows.map(({ avatarAt, pictureUrl, claimedAt, ...r }) => ({
    ...r,
    lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
    avatarUrl:
      avatarAt && r.userId
        ? `/app/api/users/${r.userId}/avatar?v=${avatarAt.getTime()}`
        : pictureUrl,
  }));
}
