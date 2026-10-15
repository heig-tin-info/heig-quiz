/**
 * The account as its owner reads it (`Account` of `@quiz/contracts`): the
 * body of `GET /app/api/me` without its `session`, and the identity of the
 * personal data export (ADR-112). One function, so both carry the same
 * fields.
 */
import { eq } from "drizzle-orm";

import type { Account } from "@quiz/contracts";

import type { Db } from "../db/client.js";
import { avatars, users } from "../db/schema.js";
import { shownAvatar } from "../modules/avatar.js";

export async function accountOf(db: Db, u: typeof users.$inferSelect): Promise<Account> {
  // Uploaded avatar takes priority over the IdP claim; ?v= busts the cache.
  const [uploaded] = await db
    .select({ updatedAt: avatars.updatedAt })
    .from(avatars)
    .where(eq(avatars.userId, u.id))
    .limit(1);
  return {
    id: u.id,
    email: u.email,
    givenName: u.givenName,
    familyName: u.familyName,
    role: u.role,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    avatarUrl: shownAvatar(u.id, uploaded?.updatedAt, u.pictureUrl),
    hasUploadedAvatar: Boolean(uploaded),
    locale: u.locale,
    dateFormat: u.dateFormat,
    mcqPolicy: u.mcqPolicy,
    coach: { enabled: u.coachEnabled, seen: u.coachSeen },
    rpnCalculator: u.rpnCalculator,
  };
}
