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

import type { Db, Tx } from "../db/client.js";
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
 * The claims whose addresses the home organization assigned (the school's
 * own mailbox), as opposed to those the person chose: what login adoption
 * accepts without asking the address to be unique (ADR-061).
 */
const INSTITUTIONAL_MAIL_CLAIMS = [
  "swissEduIDLinkedAffiliationMail",
  "swissEduPersonOrganizationalMail",
] as const;

/** The institutional addresses of a login, normalized and deduplicated. */
export function institutionalAddressesOf(claims: Record<string, unknown>): string[] {
  const all = INSTITUTIONAL_MAIL_CLAIMS.flatMap((claim) =>
    claimList(claims[claim]).map(normalizeEmail),
  );
  return [...new Set(all)].filter((e) => e !== "");
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

export interface KnownAddress {
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
 * The addresses a login may act on BEFORE anything is stored (the staging
 * allowlist). Everything after reads the stored set (`knownEmails`), whose
 * `verified` flag follows the same `addressesOf`.
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
 * the IdP says *now*, not to build a history nobody would read. The
 * affiliations it stores drive the role (roles.ts).
 *
 * `at` dates a snapshot taken elsewhere (the heig-classroom import, M1-06):
 * it then replaces the stored one only if newer. Returns whether a row was
 * written.
 */
export async function recordIdpClaims(
  db: Db | Tx,
  userId: string,
  claims: Record<string, unknown>,
  at?: Date,
): Promise<boolean> {
  const kept = persistableClaims(claims);
  const written = await db
    .insert(userIdpClaims)
    .values({ userId, claims: kept, affiliations: affiliationsOf(kept), updatedAt: at ?? new Date() })
    .onConflictDoUpdate({
      target: userIdpClaims.userId,
      set: {
        claims: sql`excluded.claims`,
        affiliations: sql`excluded.affiliations`,
        updatedAt: sql`excluded.updated_at`,
      },
      ...(at ? { setWhere: sql`excluded.updated_at > ${userIdpClaims.updatedAt}` } : {}),
    })
    .returning({ userId: userIdpClaims.userId });
  return written.length > 0;
}

/**
 * THE writer of an account's address set. Purely additive: an address seen
 * once is never removed; `verified` only ever rises (a login address
 * verified later becomes verified, never the reverse); `first_seen_at`
 * keeps the earliest date known (a login's is now; the heig-classroom
 * import brings older ones). Returns the number of addresses added or
 * changed.
 */
export async function addAddresses(
  db: Db | Tx,
  userId: string,
  addresses: readonly (KnownAddress & { firstSeenAt?: Date })[],
): Promise<number> {
  // One row per address, or the statement would touch a row twice.
  const merged = new Map<string, KnownAddress & { firstSeenAt?: Date }>();
  for (const a of addresses) {
    const email = normalizeEmail(a.email);
    if (email === "") continue;
    const seen = merged.get(email);
    if (!seen) merged.set(email, { ...a, email });
    else {
      seen.verified ||= a.verified;
      if (a.firstSeenAt && (!seen.firstSeenAt || a.firstSeenAt < seen.firstSeenAt)) seen.firstSeenAt = a.firstSeenAt;
    }
  }
  if (merged.size === 0) return 0;
  const written = await db
    .insert(userEmails)
    .values([...merged.values()].map((a) => ({ userId, email: a.email, source: a.source, verified: a.verified, ...(a.firstSeenAt ? { firstSeenAt: a.firstSeenAt } : {}) })))
    .onConflictDoUpdate({
      target: [userEmails.userId, userEmails.email],
      set: {
        verified: sql`${userEmails.verified} or excluded.verified`,
        firstSeenAt: sql`least(${userEmails.firstSeenAt}, excluded.first_seen_at)`,
      },
      setWhere: sql`(excluded.verified and not ${userEmails.verified}) or excluded.first_seen_at < ${userEmails.firstSeenAt}`,
    })
    .returning({ email: userEmails.email });
  return written.length;
}

/** Records the addresses a login revealed (`addressesOf`), through `addAddresses`. */
export async function syncUserEmails(
  db: Db,
  userId: string,
  claims: Record<string, unknown>,
  loginVerified: boolean,
): Promise<number> {
  return addAddresses(db, userId, addressesOf(claims, loginVerified));
}
