/**
 * The `org` completion (PLAN-MVP §4.1): the join code and the student
 * self-enrolment it opens (F-ORG-06).
 *
 * The rest of the module — courses, staff, classrooms, roster import — is
 * `modules/courses.ts` and `modules/roster.ts`, untouched by WP4.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { classrooms, enrollments } from "../../db/schema.js";
import { emailIn, knownEmails } from "../../identity.js";

/**
 * No `0/O`, no `1/I/L`: the code is read off a slide and typed by hand, so
 * the alphabet has no pair a student can confuse. 8 characters out of 32 is
 * ~40 bits — far beyond guessing for a classroom of 200.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newJoinCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * Turns self-enrolment on or off. Enabling mints a code the first time and
 * keeps it afterwards, so the handout a teacher printed still works next
 * semester; disabling only closes the door.
 */
export async function setJoinCode(
  db: Db,
  classroomId: string,
  enabled: boolean,
): Promise<{ joinCode: string | null; joinCodeEnabled: boolean }> {
  const [current] = await db
    .select({ joinCode: classrooms.joinCode })
    .from(classrooms)
    .where(eq(classrooms.id, classroomId))
    .limit(1);
  const joinCode = enabled ? (current?.joinCode ?? (await mintCode(db, classroomId))) : (current?.joinCode ?? null);
  const [row] = await db
    .update(classrooms)
    .set({ joinCode, joinCodeEnabled: enabled, updatedAt: new Date() })
    .where(eq(classrooms.id, classroomId))
    .returning();
  return { joinCode: row?.joinCode ?? null, joinCodeEnabled: row?.joinCodeEnabled ?? false };
}

/** `classrooms.join_code` is unique instance-wide; retry on the collision. */
async function mintCode(db: Db, classroomId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = newJoinCode();
    const [taken] = await db
      .select({ id: classrooms.id })
      .from(classrooms)
      .where(eq(classrooms.joinCode, code))
      .limit(1);
    if (!taken || taken.id === classroomId) return code;
  }
  throw new Error("could not mint a free join code");
}

export type JoinOutcome =
  | { ok: true; status: "joined" | "already" }
  | { ok: false; reason: "claimed_by_other" };

/**
 * A student redeems the code (F-ORG-06). Their identity is a SET of
 * addresses (GH-11), so an existing roster line is matched on any of them
 * before a new one is created — joining must never duplicate a student the
 * teacher already imported.
 */
export async function joinClassroom(
  db: Db,
  classroomId: string,
  user: { id: string; email: string; givenName: string; familyName: string },
): Promise<JoinOutcome> {
  const emails = await knownEmails(db, user.id);
  const addresses = emails.length > 0 ? emails : [user.email.trim().toLowerCase()];

  const [existing] = await db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.classroomId, classroomId), emailIn(enrollments.email, addresses)),
    )
    .limit(1);

  if (existing) {
    if (existing.userId === user.id) return { ok: true, status: "already" };
    if (existing.userId !== null) return { ok: false, reason: "claimed_by_other" };
    await db
      .update(enrollments)
      .set({ status: "claimed", userId: user.id, claimedAt: new Date(), conflictFlag: false })
      .where(eq(enrollments.id, existing.id));
    return { ok: true, status: "joined" };
  }

  // Not on the roster: the code itself is the authorization, so the seat is
  // created and claimed in one go.
  const inserted = await db
    .insert(enrollments)
    .values({
      id: randomUUID(),
      classroomId,
      nom: user.familyName,
      prenom: user.givenName,
      email: user.email.trim().toLowerCase(),
      status: "claimed",
      userId: user.id,
      claimedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: enrollments.id });
  // The (classroom_id, user_id) unique index caught a seat held under
  // another address: nothing to do, they are already in.
  return { ok: true, status: inserted.length > 0 ? "joined" : "already" };
}
