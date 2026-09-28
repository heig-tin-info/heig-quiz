/**
 * The Teams link of an account (ADR-030), from the Teams side to the
 * platform's: a single-use token the HEIG Quiz tab mints for the Teams
 * account its SSO token names, the page that consumes it while signed in to
 * the platform, and the rows that result.
 *
 * The token in the URL is 32 random bytes (base64url); the table keeps its
 * SHA-256 only, like a session id (`auth/session.ts`), so neither a database
 * dump nor a log line of a SELECT can link anything. It lives fifteen
 * minutes and is consumed in the same transaction that writes the link. A
 * Teams account holds at most one unspent token: a new one (the tab opened
 * again) deletes the older ones.
 */
import { randomBytes } from "node:crypto";

import { and, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";

import { displayName } from "@quiz/domain";

import { hashToken } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import { teamsLinks, teamsLinkTokens, users } from "../../db/schema.js";

export const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

export type TeamsLink = typeof teamsLinks.$inferSelect;
type LinkTokenRow = typeof teamsLinkTokens.$inferSelect;

/** A Teams (Entra) account, as its SSO token names it (`ssoAuth.ts`). */
export interface TeamsIdentity {
  /** Lower-case, as `TEAMS_ALLOWED_TENANTS` is compared. */
  tenantId: string;
  aadObjectId: string;
  /** The display name (`name`), or the username, or the object id. */
  teamsName: string;
  /** The sign-in name (`preferred_username`), usually an e-mail; '' when none. */
  teamsUsername: string;
}

/**
 * The Entra tenants whose accounts may be linked (`TEAMS_ALLOWED_TENANTS`,
 * split); empty admits every tenant.
 */
export type AllowedTenants = readonly string[];

/** One Teams account: the pair a link and a token are keyed on. */
function identityWhere(
  table: typeof teamsLinks | typeof teamsLinkTokens,
  who: Pick<TeamsIdentity, "tenantId" | "aadObjectId">,
): SQL {
  return and(eq(table.tenantId, who.tenantId), eq(table.aadObjectId, who.aadObjectId))!;
}

/**
 * A new token for this Teams account. Its unspent tokens go (only the link
 * last shown works), and so do the expired tokens of every account.
 * Serialized per account by an advisory lock, so two tabs opened at once
 * leave one token, not two.
 */
export async function issueLinkToken(db: Db, who: TeamsIdentity, now: Date): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`teams-link:${who.tenantId}:${who.aadObjectId}`}, 0))`,
    );
    await tx.delete(teamsLinkTokens).where(lt(teamsLinkTokens.expiresAt, now));
    await tx
      .delete(teamsLinkTokens)
      .where(and(identityWhere(teamsLinkTokens, who), isNull(teamsLinkTokens.consumedAt)));
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

interface LinkOutcome {
  link: TeamsLink;
  /** The account this Teams account was linked to before, now unlinked; null if none. */
  displaced: string | null;
}

/**
 * Consumes `token` for `userId` and links the Teams account, in ONE
 * transaction: the token is marked consumed by a conditional UPDATE, so of
 * two concurrent clicks one links and the other finds nothing. A Teams
 * account linked to another Quiz account moves to this one (that link is
 * deleted, and reported); this account's previous Teams account, if any, is
 * replaced.
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
      .where(and(identityWhere(teamsLinks, pending), ne(teamsLinks.userId, userId)))
      .returning({ userId: teamsLinks.userId });
    const values = {
      tenantId: pending.tenantId,
      aadObjectId: pending.aadObjectId,
      teamsName: pending.teamsName,
      teamsUsername: pending.teamsUsername,
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

/** The link of a Quiz account (a delivery, the settings) or of a Teams account (the tab). */
export async function teamsLinkOf(
  db: Db,
  key: { userId: string } | Pick<TeamsIdentity, "tenantId" | "aadObjectId">,
): Promise<TeamsLink | null> {
  const where = "userId" in key ? eq(teamsLinks.userId, key.userId) : identityWhere(teamsLinks, key);
  const [row] = await db.select().from(teamsLinks).where(where).limit(1);
  return row ?? null;
}

/** Which of `userIds` have linked Teams: {@link teamsLinkOf} by account, for many accounts in one query. */
export async function teamsLinkedUsers(db: Db, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ userId: teamsLinks.userId })
    .from(teamsLinks)
    .where(inArray(teamsLinks.userId, [...userIds]));
  return new Set(rows.map((r) => r.userId));
}

/** Forgets an account's link (Disconnect). Returns the account; null when there was none. */
export async function unlinkTeams(db: Db, key: { userId: string }): Promise<string | null> {
  const [row] = await db
    .delete(teamsLinks)
    .where(eq(teamsLinks.userId, key.userId))
    .returning({ userId: teamsLinks.userId });
  return row?.userId ?? null;
}

/** The name a Quiz account goes by in Teams (`displayName`). */
export async function accountName(db: Db, userId: string): Promise<string> {
  const [user] = await db
    .select({ givenName: users.givenName, familyName: users.familyName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ? displayName(user) : "";
}
