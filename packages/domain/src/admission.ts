/**
 * Login admission (ADR-111) — a pure rule (invariant 8). Who may have an
 * account created at their first sign-in, judged on what the identity
 * provider asserted and on what the database already holds, both loaded by
 * the caller before anything is written (`apps/api/src/auth/login.ts`).
 */

/**
 * The affiliation kinds (`student`, `staff`, …) asserted by one of `domains`:
 * `staff@hes-so.ch` yields `staff` when `hes-so.ch` is listed, nothing
 * otherwise. An UNSCOPED affiliation (`staff`) names no institution, so it
 * yields nothing either: any edu-ID home organization may assert it. The
 * scope must equal a listed domain: no subdomain matches.
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

/** What the rule reads of the login and of the database. */
export interface AdmissionFacts {
  /** The VERIFIED addresses of the claims, normalized (lowercase). */
  addresses: readonly string[];
  /** The affiliations of the claims, lowercased, scoped or not. */
  affiliations: readonly string[];
  /** Whether userinfo answered: without it, the claims carry no affiliation and few addresses. */
  complete: boolean;
  /**
   * A non-anonymized account already holds this subject, or the login would
   * adopt a placeholder account of the heig-classroom import (ADR-061).
   */
  known: boolean;
  /**
   * One of `addresses` holds a pending roster line (F-ORG-05: matched by
   * address, never through a claimed seat) or an admin's teacher grant.
   */
  invited: boolean;
}

/** Why a login is refused: no reason to admit it, or none found on a partial picture. */
export type AdmissionRefusal = "not_invited" | "retry";

/** The address's domain, exactly: `a@mail.heig-vd.ch` is at `mail.heig-vd.ch`. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * Null when the login is admitted. An empty `domains` admits everyone (the
 * rule is off). Otherwise a known account, an invited address, a verified
 * address at a listed domain or an affiliation scoped on one is admitted.
 * Anything else is refused — with `retry` when userinfo did not answer,
 * since the reason to admit may be in what is missing: fail closed, and say
 * so (ADR-111 §5). The super administrator never reaches it: the door lets
 * them through first (`loginRefusal`, apps/api/src/auth/login.ts).
 */
export function admissionRefusal(
  domains: readonly string[],
  facts: AdmissionFacts,
): AdmissionRefusal | null {
  if (domains.length === 0) return null;
  if (facts.known || facts.invited) return null;
  if (facts.addresses.some((a) => a.includes("@") && domains.includes(domainOf(a)))) return null;
  if (affiliationKindsIn(facts.affiliations, domains).length > 0) return null;
  return facts.complete ? "not_invited" : "retry";
}
