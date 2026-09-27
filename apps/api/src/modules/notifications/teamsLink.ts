/**
 * The Teams link of an account (ADR-030), from the bot's side of the chat to
 * the platform's: a single-use token the bot puts behind its link card, the
 * page that consumes it, and the rows that result.
 *
 * The token in the URL is 32 random bytes (base64url); the table keeps its
 * SHA-256 only, like a session id (`auth/session.ts`), so neither a database
 * dump nor a log line of a SELECT can link anything. It lives fifteen
 * minutes, is consumed in the same transaction that writes the link, and a
 * chat gets at most one new token a minute — the bot never answers a burst of
 * messages with a burst of cards.
 */
import { randomBytes } from "node:crypto";

import { and, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";

import { hashToken } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import { teamsLinks, teamsLinkTokens } from "../../db/schema.js";

export const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;
/** At most one new token per chat in this window. */
export const LINK_TOKEN_COOLDOWN_MS = 60 * 1000;

export type TeamsLink = typeof teamsLinks.$inferSelect;
type LinkTokenRow = typeof teamsLinkTokens.$inferSelect;

/** Who is on the other end of a personal chat with the bot, as the activity says. */
export interface TeamsChatIdentity {
  conversationId: string;
  serviceUrl: string;
  /** Lower-case, as `TEAMS_ALLOWED_TENANTS` is compared. */
  tenantId: string;
  aadObjectId: string;
  teamsName: string;
}

/**
 * The Entra tenants whose accounts may be linked (`TEAMS_ALLOWED_TENANTS`,
 * split); empty admits every tenant.
 */
export type AllowedTenants = readonly string[];

/**
 * A new token for this chat, or null when one was made less than a minute
 * ago. Expired tokens of every chat are pruned on the way. Serialized per
 * chat by an advisory lock: Teams sends `installationUpdate` and
 * `conversationUpdate` for the same install within milliseconds.
 */
export async function issueLinkToken(
  db: Db,
  who: TeamsChatIdentity,
  now: Date,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`teams-link:${who.conversationId}`}, 0))`,
    );
    await tx.delete(teamsLinkTokens).where(lt(teamsLinkTokens.expiresAt, now));
    const [recent] = await tx
      .select({ hash: teamsLinkTokens.tokenHash })
      .from(teamsLinkTokens)
      .where(
        and(
          eq(teamsLinkTokens.conversationId, who.conversationId),
          gt(teamsLinkTokens.createdAt, new Date(now.getTime() - LINK_TOKEN_COOLDOWN_MS)),
        ),
      )
      .limit(1);
    if (recent) return null;
    const token = randomBytes(32).toString("base64url");
    await tx.insert(teamsLinkTokens).values({
      tokenHash: hashToken(token),
      ...who,
      createdAt: now,
      expiresAt: new Date(now.getTime() + LINK_TOKEN_TTL_MS),
    });
    return token;
  });
}

/**
 * The ONE rule of the tenant allowlist: an empty list admits every tenant,
 * otherwise the (lower-cased) tenant must be listed. `usable()` below says
 * the same in SQL; change both together.
 */
export function tenantAllowed(tenants: AllowedTenants, tenantId: string): boolean {
  return tenants.length === 0 || tenants.includes(tenantId.trim().toLowerCase());
}

/**
 * The ONE definition of a token that can still link: known, unspent,
 * unexpired, of an allowed tenant (`tenantAllowed`, as SQL).
 */
function usable(token: string, now: Date, tenants: AllowedTenants): SQL | undefined {
  return and(
    eq(teamsLinkTokens.tokenHash, hashToken(token)),
    isNull(teamsLinkTokens.consumedAt),
    gt(teamsLinkTokens.expiresAt, now),
    tenants.length > 0 ? inArray(teamsLinkTokens.tenantId, [...tenants]) : undefined,
  );
}

/** The pending link behind `token`, WITHOUT consuming it; null when unusable. */
export async function previewLinkToken(
  db: Db,
  token: string,
  now: Date,
  tenants: AllowedTenants = [],
): Promise<LinkTokenRow | null> {
  const [row] = await db.select().from(teamsLinkTokens).where(usable(token, now, tenants)).limit(1);
  return row ?? null;
}

export interface LinkOutcome {
  link: TeamsLink;
  /** The account this chat was linked to before, now unlinked; null if none. */
  displaced: string | null;
}

/**
 * Consumes `token` for `userId` and links the chat, in ONE transaction: the
 * token is marked consumed by a conditional UPDATE, so of two concurrent
 * clicks one links and the other finds nothing. A chat linked to another
 * account moves to this one (that link is deleted, and reported); this
 * account's previous chat, if any, is replaced.
 */
export async function consumeLinkToken(
  db: Db,
  userId: string,
  token: string,
  now: Date,
  tenants: AllowedTenants = [],
): Promise<LinkOutcome | null> {
  return db.transaction(async (tx) => {
    const [pending] = await tx
      .update(teamsLinkTokens)
      .set({ consumedAt: now })
      .where(usable(token, now, tenants))
      .returning();
    if (!pending) return null;
    const [moved] = await tx
      .delete(teamsLinks)
      .where(and(eq(teamsLinks.conversationId, pending.conversationId), ne(teamsLinks.userId, userId)))
      .returning({ userId: teamsLinks.userId });
    const values = {
      tenantId: pending.tenantId,
      aadObjectId: pending.aadObjectId,
      conversationId: pending.conversationId,
      serviceUrl: pending.serviceUrl,
      teamsName: pending.teamsName,
      linkedAt: now,
    };
    const [link] = await tx
      .insert(teamsLinks)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: teamsLinks.userId, set: values })
      .returning();
    return { link: link!, displaced: moved?.userId ?? null };
  });
}

/** Which link: an account's, or a chat's — each is unique. */
type LinkKey = { userId: string } | { conversationId: string };

function linkWhere(key: LinkKey): SQL {
  return "userId" in key
    ? eq(teamsLinks.userId, key.userId)
    : eq(teamsLinks.conversationId, key.conversationId);
}

export async function teamsLinkOf(db: Db, key: LinkKey): Promise<TeamsLink | null> {
  const [row] = await db.select().from(teamsLinks).where(linkWhere(key)).limit(1);
  return row ?? null;
}

/**
 * Forgets a link — the user's Disconnect, or the app removed from Teams.
 * Returns the account it belonged to; null when there was none.
 */
export async function unlinkTeams(db: Db, key: LinkKey): Promise<string | null> {
  const [row] = await db.delete(teamsLinks).where(linkWhere(key)).returning({ userId: teamsLinks.userId });
  return row?.userId ?? null;
}

/**
 * A new `serviceUrl` for a linked chat (Microsoft may move a chat between
 * regions; every activity carries the current one).
 */
export async function refreshServiceUrl(db: Db, conversationId: string, serviceUrl: string): Promise<void> {
  await db
    .update(teamsLinks)
    .set({ serviceUrl })
    .where(and(eq(teamsLinks.conversationId, conversationId), ne(teamsLinks.serviceUrl, serviceUrl)));
}
