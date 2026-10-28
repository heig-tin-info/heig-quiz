/**
 * Where an account's notification e-mails go (F-NOTIF-01, ADR-030 amendment
 * of 2026-10-28). The login address of Switch edu-ID is the one the person
 * picked, often a private mailbox; the school's own address, when edu-ID
 * asserts one, is where a notification about a course belongs. So:
 *
 *  - the options: the login address and every VERIFIED address of the
 *    account (`user_emails`), normalized, once each;
 *  - institutional: what the LAST login asserts (`institutionalAddressesOf`
 *    over `user_idp_claims`), never the stored `source` of an address — that
 *    one is frozen at first sight, and an address of a former affiliation
 *    stays in `user_emails` forever;
 *  - the default: the first institutional option, else the login address;
 *  - the effective address: the stored choice while it is still an option,
 *    else the default.
 *
 * `notificationAddress` is the ONE resolver every e-mail to an account goes
 * through (the delivery job, the administrator's test mail). An address of a
 * roster line is not an account's and never comes here.
 */
import { and, eq } from "drizzle-orm";

import type { NotificationEmail } from "@quiz/contracts";

import { institutionalAddressesOf } from "../../auth/claims.js";
import type { Db } from "../../db/client.js";
import { userEmails, userIdpClaims, users } from "../../db/schema.js";
import { normalizeEmail } from "../../identity.js";

/** The account's addresses, as the resolver reads them. */
export interface AddressSources {
  /** `users.email`, the login address. */
  login: string;
  /** The verified addresses of `user_emails`. */
  verified: readonly string[];
  /** The institutional addresses of the last login, most trustworthy first. */
  institutional: readonly string[];
  /** `users.notification_email`. */
  chosen: string | null;
}

/**
 * The pure rule: the effective address, the default and the options. The
 * institutional options come first, in claim order, then the login address,
 * then the others.
 */
export function resolveNotificationEmail({ login, verified, institutional, chosen }: AddressSources): NotificationEmail {
  const known = new Set([login, ...verified].map(normalizeEmail).filter((e) => e !== ""));
  const asserted = institutional.map(normalizeEmail).filter((e) => known.has(e));
  const emails = [...new Set([...asserted, ...known])];
  const options = emails.map((email) => ({ email, institutional: asserted.includes(email) }));
  const defaultAddress = asserted[0] ?? normalizeEmail(login);
  const address = chosen !== null && known.has(chosen) ? chosen : defaultAddress;
  return { address, defaultAddress, options };
}

/** The account's notification address, its default and its options; null for no account. */
export async function notificationAddress(db: Db, userId: string): Promise<NotificationEmail | null> {
  const [[user], verified, [claims]] = await Promise.all([
    db
      .select({ email: users.email, chosen: users.notificationEmail })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({ email: userEmails.email })
      .from(userEmails)
      .where(and(eq(userEmails.userId, userId), eq(userEmails.verified, true))),
    db.select({ claims: userIdpClaims.claims }).from(userIdpClaims).where(eq(userIdpClaims.userId, userId)).limit(1),
  ]);
  if (!user) return null;
  return resolveNotificationEmail({
    login: user.email,
    verified: verified.map((r) => r.email),
    institutional: claims ? institutionalAddressesOf(claims.claims) : [],
    chosen: user.chosen,
  });
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
