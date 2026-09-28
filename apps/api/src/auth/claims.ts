/**
 * IdP claim capture (GH-11).
 *
 * Switch edu-ID identifies a person by a self-chosen preferred address,
 * which may perfectly well be a private mailbox, while GAPS exports the
 * institutional one — so matching a roster line on `users.email` alone
 * fails for those students. The addresses we need (and the affiliations
 * that tell a student from a staff member) live behind the
 * `https://eduid.ch/scope/userinfo.read` scope, and edu-ID only releases
 * what its Resource Registry entry allows: what actually arrives can only
 * be observed on a real login.
 *
 * Hence this module: the whole claim set of every login is persisted, as
 * released. Deliberately NOT minimized — an authentication problem is
 * expensive to diagnose after the fact and this snapshot is the cheap
 * insurance. In exchange the data stays confined here: `user_idp_claims`
 * is never joined into a user-facing view, never displayed, never exposed
 * by the API.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { userEmails, userIdpClaims } from "../db/schema.js";
import { normalizeEmail } from "../identity.js";

/** Claims whose value only means something inside the token exchange. */
const TOKEN_ONLY = new Set([
  "at_hash",
  "c_hash",
  "s_hash",
  "nonce",
  "iss",
  "aud",
  "azp",
  "exp",
  "iat",
  "nbf",
  "jti",
]);

/**
 * A multi-valued claim, normalized. edu-ID specifies JSON arrays, but the
 * SAML-era bridges also hand out a single comma (or semicolon) separated
 * string, so both are accepted.
 */
export function claimList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((v) => (typeof v === "string" ? v.split(/[,;]/) : typeof v === "number" ? [String(v)] : []))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/**
 * The affiliation claims, merged, lowercased, deduplicated. edu-ID releases
 * `eduPersonAffiliation` (unscoped) alongside the scoped ones and does NOT
 * release `eduPersonPrimaryAffiliation` — observed on production, not
 * guessed; the latter is read anyway in case that ever changes.
 */
export function affiliationsOf(claims: Record<string, unknown>): string[] {
  const all = [
    ...claimList(claims.eduPersonPrimaryAffiliation),
    ...claimList(claims.eduPersonAffiliation),
    ...claimList(claims.eduPersonScopedAffiliation),
    ...claimList(claims.swissEduIDLinkedAffiliation),
  ].map((v) => v.toLowerCase());
  return [...new Set(all)];
}

/**
 * Claims carrying e-mail addresses, most trustworthy first. Only
 * `swissEduIDLinkedAffiliationMail` is released to us today; the others cost
 * nothing to read and cover a change in the Resource Registry entry.
 */
const MAIL_CLAIMS = [
  "swissEduIDLinkedAffiliationMail",
  "swissEduPersonOrganizationalMail",
  "swissEduIDAssociatedMail",
  "swissEduPersonPrivateMail",
] as const;

interface KnownAddress {
  email: string;
  /** `login`, or the claim the address came from. */
  source: string;
  /**
   * Whether the address may identify the account. An address asserted by
   * the home organization is verified by construction; the login address
   * only when the IdP says `email_verified` — it is the one the user picked.
   */
  verified: boolean;
}

/**
 * Every address a login reveals: the `email` claim, then those asserted by
 * the institution. Deduplicated on the address, first source wins; an
 * address the institution also asserts is verified whatever the login says.
 */
export function addressesOf(
  claims: Record<string, unknown>,
  loginVerified: boolean,
): KnownAddress[] {
  const found = new Map<string, KnownAddress>();
  const add = (raw: string, source: string, verified: boolean) => {
    const email = normalizeEmail(raw);
    if (email === "") return;
    const seen = found.get(email);
    if (seen) seen.verified ||= verified;
    else found.set(email, { email, source, verified });
  };
  if (typeof claims.email === "string") add(claims.email, "login", loginVerified);
  for (const claim of MAIL_CLAIMS) {
    for (const value of claimList(claims[claim])) add(value, claim, true);
  }
  return [...found.values()];
}

/**
 * The addresses a login may act on — role, staging allowlist — by the same
 * rule `knownEmails` applies to a stored account, so the role computed at
 * login and the one recomputed later cannot diverge.
 */
export function verifiedAddressesOf(
  claims: Record<string, unknown>,
  loginVerified: boolean,
): string[] {
  return addressesOf(claims, loginVerified)
    .filter((a) => a.verified)
    .map((a) => a.email);
}

/**
 * The affiliation kinds (`student`, `staff`, …) asserted by one of `domains`:
 * `staff@hes-so.ch` yields `staff` when `hes-so.ch` is listed, nothing
 * otherwise. An UNSCOPED affiliation (`staff`) names no institution, so it
 * yields nothing either: any edu-ID home organization may assert it.
 */
export function affiliationKindsIn(
  affiliations: readonly string[],
  domains: readonly string[],
): string[] {
  const kinds = affiliations.flatMap((a) => {
    const at = a.indexOf("@");
    return at > 0 && domains.includes(a.slice(at + 1)) ? [a.slice(0, at)] : [];
  });
  return [...new Set(kinds)];
}

/** Everything worth keeping from a login, the token plumbing removed. */
export function persistableClaims(claims: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(claims).filter(([k]) => !TOKEN_ONLY.has(k)));
}

/**
 * One row per user, overwritten at each login: the point is to know what
 * the IdP says *now*, not to build a history nobody would read.
 */
export async function recordIdpClaims(
  db: Db,
  userId: string,
  claims: Record<string, unknown>,
): Promise<void> {
  const kept = persistableClaims(claims);
  const values = {
    userId,
    claims: kept,
    affiliations: affiliationsOf(kept),
    updatedAt: new Date(),
  };
  await db
    .insert(userIdpClaims)
    .values(values)
    .onConflictDoUpdate({
      target: userIdpClaims.userId,
      set: {
        claims: sql`excluded.claims`,
        affiliations: sql`excluded.affiliations`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/**
 * Records the addresses a login revealed. Purely additive: an address seen
 * once is never removed, and `first_seen_at` keeps the date of the login
 * that revealed it. `verified` follows `addressesOf`.
 */
export async function syncUserEmails(
  db: Db,
  userId: string,
  claims: Record<string, unknown>,
  loginVerified: boolean,
): Promise<number> {
  const addresses = addressesOf(claims, loginVerified);
  if (addresses.length === 0) return 0;
  const inserted = await db
    .insert(userEmails)
    .values(addresses.map((a) => ({ userId, ...a })))
    .onConflictDoNothing({ target: [userEmails.userId, userEmails.email] })
    .returning({ email: userEmails.email });
  return inserted.length;
}
