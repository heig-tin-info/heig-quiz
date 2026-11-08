/**
 * The guests of an anonymous poll (F-AUTH-05): a browser keyed on the hash of
 * its cookie, bound to one evaluation.
 */
import { createHash, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { guestParticipants } from "../../db/schema.js";
import type { DbOrTx } from "../evaluation/service.js";
import { LiveError } from "./failures.js";

type GuestRecord = typeof guestParticipants.$inferSelect;

/**
 * A poll's guest (F-AUTH-05): a browser that holds the `quiz_guest` cookie
 * (`modules/poll`). What the database holds is `sha256(token:evaluation)`.
 *
 * Binding the hash to the evaluation is what lets ONE cookie serve a browser
 * across several polls — one row per (evaluation, browser), as the unique
 * index on `token_hash` requires — and what stops a hash read out of one
 * poll's table from being replayed as another poll's participant.
 */
function guestHash(token: string, evaluationId: string): string {
  return createHash("sha256").update(`${token}:${evaluationId}`).digest("hex");
}

export async function guestByToken(
  db: Db,
  evaluationId: string,
  token: string,
): Promise<GuestRecord | null> {
  const [row] = await db
    .select()
    .from(guestParticipants)
    .where(eq(guestParticipants.tokenHash, guestHash(token, evaluationId)))
    .limit(1);
  return row ?? null;
}

/** Idempotent: the same cookie always lands on the same guest row. */
export async function ensureGuest(
  db: Db,
  evaluationId: string,
  token: string,
  now: Date,
): Promise<GuestRecord> {
  await db
    .insert(guestParticipants)
    .values({
      id: randomUUID(),
      evaluationId,
      tokenHash: guestHash(token, evaluationId),
      createdAt: now,
    })
    .onConflictDoNothing({ target: guestParticipants.tokenHash });
  const row = await guestByToken(db, evaluationId, token);
  if (!row) throw new LiveError("internal_error", "guest vanished after insert");
  return row;
}

/**
 * Deletes the guests of one poll (#873): their attempts, answers, attempt
 * journal and gradings go with them, by the foreign keys' cascade. The
 * accounts' attempts are not touched. The `poll` module calls it, in the
 * transaction that first freezes the poll's results. How many guests went.
 */
export async function deleteGuests(db: DbOrTx, evaluationId: string): Promise<number> {
  const deleted = await db
    .delete(guestParticipants)
    .where(eq(guestParticipants.evaluationId, evaluationId))
    .returning({ id: guestParticipants.id });
  return deleted.length;
}
