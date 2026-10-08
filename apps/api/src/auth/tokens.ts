/**
 * Personal API tokens (ADR-022): the bearer credential of a script or an MCP
 * client. Same storage rule as a session (AU-06): the plaintext is handed out
 * once, only its SHA-256 is persisted, so a leak of the table replays nothing.
 *
 * A token is not a second identity. It resolves to its owner's `users` row on
 * every request, so the role, the course seats and the pool memberships it
 * acts under are the owner's CURRENT ones: a teacher removed from a staff
 * loses that course through their tokens at the same instant.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, isNull, lt, or } from "drizzle-orm";

import { API_TOKEN_PREFIX, type ApiToken, type ApiTokenCreated } from "@quiz/contracts";

import type { Db } from "../db/client.js";
import { apiTokens, users } from "../db/schema.js";
import { hashToken, newToken } from "./session.js";

/** Characters of the plaintext kept for display: the prefix and a few more. */
const DISPLAY_LENGTH = API_TOKEN_PREFIX.length + 6;

/** `last_used_at` is refreshed at most this often: a read must not cost a write. */
const LAST_USED_RESOLUTION_MS = 60_000;

type TokenRow = typeof apiTokens.$inferSelect;

function toApiToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** OAuth access tokens (ADR-023) live in the same table under their own prefix. */
const OAUTH_ACCESS_PREFIX = "quiz_oat_";
/** And the help assistant's per-question tokens (ADR-080 §8), under theirs. */
const ASSIST_PREFIX = "quiz_ast_";

/**
 * The audience of the help assistant's per-question token (ADR-080 §8):
 * good only for the in-process calls of the assistant's read tools — never
 * on the public MCP path, never from outside the process (`auth/plugin.ts`).
 */
export const ASSIST_AUDIENCE = "urn:quiz:assist";
/**
 * How long a question's token lives at most: past a question's worst case
 * (six provider requests of a minute, each retried once). It is deleted at
 * the end of the question anyway; this bounds one a crash left behind.
 */
export const ASSIST_TOKEN_TTL_MS = 15 * 60_000;

/** A header value that LOOKS like one of ours; anything else is not a token. */
export function isApiToken(value: string): boolean {
  return (
    [API_TOKEN_PREFIX, OAUTH_ACCESS_PREFIX, ASSIST_PREFIX].some((prefix) => value.startsWith(prefix)) &&
    value.length > DISPLAY_LENGTH
  );
}

export async function createApiToken(
  db: Db,
  userId: string,
  input: { name: string; expiresInDays: number | null },
  now: Date = new Date(),
): Promise<ApiTokenCreated> {
  const token = `${API_TOKEN_PREFIX}${newToken()}`;
  const [row] = await db
    .insert(apiTokens)
    .values({
      id: randomUUID(),
      userId,
      name: input.name,
      tokenHash: hashToken(token),
      prefix: token.slice(0, DISPLAY_LENGTH),
      createdAt: now,
      expiresAt:
        input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000),
    })
    .returning();
  return { ...toApiToken(row!), token };
}

/** A personal token: neither an OAuth grant's access token nor the help assistant's (both carry an audience). */
const personal = () => and(isNull(apiTokens.grantId), isNull(apiTokens.audience));

/**
 * The caller's own PERSONAL tokens, newest first, revoked ones included. The
 * hourly access tokens of an OAuth grant are not listed: the grant is, as a
 * connected assistant (`oauth/service.ts`); nor the help assistant's
 * per-question tokens, which nobody manages by hand (ADR-080 §8).
 */
export async function listApiTokens(db: Db, userId: string): Promise<ApiToken[]> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), personal()))
    .orderBy(desc(apiTokens.createdAt));
  return rows.map(toApiToken);
}

/**
 * Revokes one of the caller's tokens. Someone else's token is not found, the
 * same answer as a token that never existed (invariant 6).
 */
export async function revokeApiToken(
  db: Db,
  userId: string,
  tokenId: string,
  now: Date = new Date(),
): Promise<ApiToken | null> {
  const [row] = await db
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        eq(apiTokens.userId, userId),
        personal(),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning();
  return row ? toApiToken(row) : null;
}

/**
 * The help assistant's token for ONE question (ADR-080 §8): the teacher's
 * own, bound to {@link ASSIST_AUDIENCE}, short-lived, never listed. It
 * resolves like any token — the teacher's current seats, never Super Powers,
 * which a token does not carry (F-ADMIN-05). {@link dropAssistToken} deletes
 * it when the question ends.
 */
export async function mintAssistToken(db: Db, userId: string, now: Date): Promise<{ id: string; token: string }> {
  const token = `${ASSIST_PREFIX}${newToken()}`;
  const id = randomUUID();
  await db.insert(apiTokens).values({
    id,
    userId,
    name: "Help assistant (one question)",
    tokenHash: hashToken(token),
    prefix: token.slice(0, DISPLAY_LENGTH),
    createdAt: now,
    expiresAt: new Date(now.getTime() + ASSIST_TOKEN_TTL_MS),
    audience: ASSIST_AUDIENCE,
  });
  return { id, token };
}

/** The end of a question: its token is gone, not merely revoked — nobody lists it. */
export async function dropAssistToken(db: Db, id: string): Promise<void> {
  await db.delete(apiTokens).where(and(eq(apiTokens.id, id), eq(apiTokens.audience, ASSIST_AUDIENCE)));
}

/** The help assistant's tokens a crash left behind, once expired (the `assist.purge` task). */
export async function purgeAssistTokens(db: Db, now: Date): Promise<number> {
  const gone = await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.audience, ASSIST_AUDIENCE), lt(apiTokens.expiresAt, now)))
    .returning({ id: apiTokens.id });
  return gone.length;
}

/**
 * The account a bearer token acts for, or null when the token is unknown,
 * revoked, expired, or belongs to an anonymised account. `audience` is the
 * one resource an OAuth access token may be used on; null for a personal
 * token, valid on the whole API.
 */
export async function findTokenUser(db: Db, token: string, now: Date = new Date()) {
  const [row] = await db
    .select({
      user: users,
      tokenId: apiTokens.id,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
      audience: apiTokens.audience,
    })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(eq(apiTokens.tokenHash, hashToken(token)))
    .limit(1);
  if (!row || row.revokedAt !== null || row.user.anonymizedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;
  await db
    .update(apiTokens)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(apiTokens.id, row.tokenId),
        or(
          isNull(apiTokens.lastUsedAt),
          lt(apiTokens.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)),
        ),
      ),
    );
  return { user: row.user, tokenId: row.tokenId, audience: row.audience };
}
