/**
 * One-time launch tickets (ADR-027): the right to open ONE session of a given
 * kind, for a given user, within a few minutes. The plaintext secret leaves
 * the server once, inside whatever carries it (a `.seb` file); only its
 * SHA-256 is stored, like a session's.
 */
import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, type AnyColumn } from "drizzle-orm";

import type { SessionKind } from "@quiz/contracts";

import type { Db } from "../db/client.js";
import { launchTickets } from "../db/schema.js";
import { hashToken, newToken, type SessionAuth } from "./session.js";

/** Long enough to download a file and start Safe Exam Browser, no longer. */
const LAUNCH_TICKET_TTL_MS = 5 * 60_000;

interface LaunchTicket {
  userId: string;
  /** Who acts through the session, when not the user themself (as on `sessions`). */
  actorUserId: string | null;
  /** The session it opens; a `portal` one is never launched. */
  kind: LaunchKind;
  /** The evaluation a `seb` session is confined to; null for any other kind. */
  evaluationId: string | null;
  /** The project a `seb` session is confined to instead (D21); null otherwise. */
  projectId: string | null;
}

type LaunchKind = Exclude<SessionKind, "portal">;

/** `column = value`, where a null value means IS NULL (SQL's `= NULL` matches nothing). */
const same = (column: AnyColumn, value: string | null) =>
  value === null ? isNull(column) : eq(column, value);

/**
 * Issues a ticket and returns its plaintext secret. The earlier unconsumed
 * tickets of the same user, actor, kind and evaluation are revoked first: one
 * file, or one link, in circulation at a time.
 */
export async function issueLaunchTicket(db: Db, ticket: LaunchTicket, now: Date): Promise<string> {
  const secret = newToken();
  await db.transaction(async (tx) => {
    await tx
      .update(launchTickets)
      .set({ revokedAt: now })
      .where(
        and(
          eq(launchTickets.userId, ticket.userId),
          same(launchTickets.actorUserId, ticket.actorUserId),
          eq(launchTickets.kind, ticket.kind),
          same(launchTickets.evaluationId, ticket.evaluationId),
          same(launchTickets.projectId, ticket.projectId),
          isNull(launchTickets.consumedAt),
          isNull(launchTickets.revokedAt),
        ),
      );
    await tx.insert(launchTickets).values({
      id: randomUUID(),
      secretHash: hashToken(secret),
      kind: ticket.kind,
      userId: ticket.userId,
      actorUserId: ticket.actorUserId,
      evaluationId: ticket.evaluationId,
      projectId: ticket.projectId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + LAUNCH_TICKET_TTL_MS),
    });
  });
  return secret;
}

/** A ticket of `kind` that may still be consumed: unconsumed, unrevoked, unexpired. */
const usable = (kind: LaunchKind, secret: string, now: Date) =>
  and(
    eq(launchTickets.secretHash, hashToken(secret)),
    eq(launchTickets.kind, kind),
    isNull(launchTickets.consumedAt),
    isNull(launchTickets.revokedAt),
    gt(launchTickets.expiresAt, now),
  );

/** A ticket row as the session it opens sees it. */
const ticketOf = (row: typeof launchTickets.$inferSelect) => ({
  id: row.id,
  userId: row.userId,
  auth: { kind: row.kind, actorUserId: row.actorUserId, evaluationId: row.evaluationId, projectId: row.projectId } satisfies SessionAuth,
});

/**
 * Reads a ticket of `kind` that could be consumed now, WITHOUT consuming it:
 * what it was issued for decides what the start route checks before it
 * consumes (the `.seb` of its activity, D21). Null as for {@link consumeLaunchTicket}.
 */
export async function pendingLaunchTicket(
  db: Db,
  kind: LaunchKind,
  secret: string,
  now: Date,
): Promise<{ id: string; userId: string; auth: SessionAuth } | null> {
  const [row] = await db.select().from(launchTickets).where(usable(kind, secret, now));
  return row ? ticketOf(row) : null;
}

/**
 * Consumes a ticket of `kind`: ONE conditional UPDATE, so of two concurrent
 * requests exactly one gets the row. Null for an unknown, expired, revoked or
 * already consumed secret, or one of another kind (a `.seb` secret opens no
 * impersonation, and the reverse) — the caller cannot tell which, and does
 * not need to.
 */
export async function consumeLaunchTicket(
  db: Db,
  kind: LaunchKind,
  secret: string,
  now: Date,
): Promise<{ id: string; userId: string; auth: SessionAuth } | null> {
  const [row] = await db.update(launchTickets).set({ consumedAt: now }).where(usable(kind, secret, now)).returning();
  return row ? ticketOf(row) : null;
}
