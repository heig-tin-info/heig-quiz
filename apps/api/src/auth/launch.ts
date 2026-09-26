/**
 * One-time launch tickets (ADR-027): the right to open ONE session of a given
 * kind, for a given user, within a few minutes. The plaintext secret leaves
 * the server once, inside whatever carries it (a `.seb` file); only its
 * SHA-256 is stored, like a session's.
 */
import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";

import type { SessionKind } from "@quiz/contracts";

import type { Db } from "../db/client.js";
import { launchTickets } from "../db/schema.js";
import { hashToken, newToken, type SessionAuth } from "./session.js";

/** Long enough to download a file and start Safe Exam Browser, no longer. */
export const LAUNCH_TICKET_TTL_MS = 5 * 60_000;

export interface LaunchTicket {
  userId: string;
  /** Who asked for it: the user themself for a `seb` launch. */
  actorUserId: string;
  /** The session it opens; a `portal` one is never launched. */
  kind: Exclude<SessionKind, "portal">;
  evaluationId: string;
}

/**
 * Issues a ticket and returns its plaintext secret. The earlier unconsumed
 * tickets of the same user, kind and evaluation are revoked first: one file
 * in circulation at a time.
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
          eq(launchTickets.kind, ticket.kind),
          eq(launchTickets.evaluationId, ticket.evaluationId),
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
      createdAt: now,
      expiresAt: new Date(now.getTime() + LAUNCH_TICKET_TTL_MS),
    });
  });
  return secret;
}

/**
 * Consumes a ticket: ONE conditional UPDATE, so of two concurrent requests
 * exactly one gets the row. Null for an unknown, expired, revoked or already
 * consumed secret — the caller cannot tell which, and does not need to.
 */
export async function consumeLaunchTicket(
  db: Db,
  secret: string,
  now: Date,
): Promise<{ id: string; userId: string; auth: SessionAuth } | null> {
  const [row] = await db
    .update(launchTickets)
    .set({ consumedAt: now })
    .where(
      and(
        eq(launchTickets.secretHash, hashToken(secret)),
        isNull(launchTickets.consumedAt),
        isNull(launchTickets.revokedAt),
        gt(launchTickets.expiresAt, now),
      ),
    )
    .returning();
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    auth: {
      kind: row.kind,
      actorUserId: row.actorUserId === row.userId ? null : row.actorUserId,
      evaluationId: row.evaluationId,
    },
  };
}
