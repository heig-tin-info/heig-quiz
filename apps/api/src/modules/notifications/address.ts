/**
 * Where an account's notification e-mails go (F-NOTIF-01, ADR-030 amendment
 * of 2026-10-28). The login address of Switch edu-ID is the one the person
 * picked, often a private mailbox; the school's own address, when edu-ID
 * asserts one, is where a notification about a course belongs. So:
 *
 *  - the options: the login address and every VERIFIED address of the
 *    account (`user_emails`), normalized, once each;
 *  - the default: the first institutional one (`INSTITUTIONAL_MAIL_CLAIMS`,
 *    in that order), else the login address;
 *  - the effective address: the stored choice while it is still an option,
 *    else the default.
 *
 * `notificationAddress` is the ONE resolver every e-mail to an account goes
 * through (the delivery job, the administrator's test mail). An address of a
 * roster line is not an account's and never comes here.
 */
import { and, eq } from "drizzle-orm";

import type { NotificationEmail } from "@quiz/contracts";

import { INSTITUTIONAL_MAIL_CLAIMS } from "../../auth/claims.js";
import type { Db } from "../../db/client.js";
import { userEmails, users } from "../../db/schema.js";
import { normalizeEmail } from "../../identity.js";

const INSTITUTIONAL: readonly string[] = INSTITUTIONAL_MAIL_CLAIMS;

/** The rank of an institutional claim; anything else ranks after them all. */
const rank = (source: string) => {
  const i = INSTITUTIONAL.indexOf(source);
  return i === -1 ? INSTITUTIONAL.length : i;
};

/**
 * The pure rule: the options, the default and the effective address, from
 * the login address, the verified stored addresses and the stored choice.
 * The options list the institutional addresses first, by rank, then the
 * login address, then the others.
 */
export function resolveNotificationEmail(
  login: string,
  verified: readonly { email: string; source: string }[],
  chosen: string | null,
): NotificationEmail {
  const institutional = new Set<string>();
  const sorted = [...verified].sort((a, b) => rank(a.source) - rank(b.source));
  for (const row of sorted) if (rank(row.source) < INSTITUTIONAL.length) institutional.add(normalizeEmail(row.email));
  const ordered = [
    ...sorted.filter((r) => rank(r.source) < INSTITUTIONAL.length).map((r) => r.email),
    login,
    ...sorted.filter((r) => rank(r.source) === INSTITUTIONAL.length).map((r) => r.email),
  ];
  const emails = [...new Set(ordered.map(normalizeEmail))].filter((e) => e !== "");
  const options = emails.map((email) => ({ email, institutional: institutional.has(email) }));
  const fallback = options.find((o) => o.institutional)?.email ?? normalizeEmail(login);
  const choice = chosen !== null && emails.includes(chosen) ? chosen : null;
  return { address: choice ?? fallback, choice, defaultAddress: fallback, options };
}

/** The account's notification address, its options and its stored choice; null for no account. */
export async function notificationAddress(db: Db, userId: string): Promise<NotificationEmail | null> {
  const [[user], verified] = await Promise.all([
    db
      .select({ email: users.email, chosen: users.notificationEmail })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({ email: userEmails.email, source: userEmails.source })
      .from(userEmails)
      .where(and(eq(userEmails.userId, userId), eq(userEmails.verified, true))),
  ]);
  return user ? resolveNotificationEmail(user.email, verified, user.chosen) : null;
}

/**
 * Stores the account's choice; null goes back to the default. Refuses (false)
 * an address that is not one of its options.
 */
export async function setNotificationEmail(db: Db, userId: string, email: string | null): Promise<boolean> {
  const chosen = email === null ? null : normalizeEmail(email);
  if (chosen !== null) {
    const current = await notificationAddress(db, userId);
    if (!current?.options.some((o) => o.email === chosen)) return false;
  }
  await db.update(users).set({ notificationEmail: chosen }).where(eq(users.id, userId));
  return true;
}
