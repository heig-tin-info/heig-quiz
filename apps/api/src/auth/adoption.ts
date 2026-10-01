/**
 * Login adoption (ADR-061, merge task M1-06): the first Quiz login of a
 * person the heig-classroom import created takes over that account instead
 * of making a second one.
 *
 * edu-ID gives each client its own `sub` (measured 2026-09-28: 0 of the 55
 * people present in both apps had the same one), so the import cannot key a
 * new account on the person's Quiz `sub`: it writes the placeholder
 * `classroom:<heig-classroom sub>` (`placeholderSub`). The first login whose
 * `sub` no row holds looks for exactly one such placeholder account of the
 * same person, by the rule the import matches with (`decideMatch` of
 * `@quiz/domain`): `swiss_edu_id`, then an institutional address, then a
 * private address held by that account alone in the whole database. A
 * placeholder carrying a `swiss_edu_id` is adopted through that key only.
 *
 * Two steps, so each can be driven on its own: `findAdoption` reads,
 * `applyAdoption` rewrites `oidc_sub` by an UPDATE conditional on the
 * placeholder — of two first logins at once, the second finds the row
 * already adopted and falls through to the ordinary upsert. Only a
 * non-anonymized `classroom:` row is ever touched; a `dev:` row, or any
 * account that ever signed in, never is. Adoption is permanent.
 */
import { and, eq, inArray, isNull, like } from "drizzle-orm";

import { decideMatch, type MatchKey } from "@quiz/domain";

import type { Tx } from "../db/client.js";
import { userEmails, users } from "../db/schema.js";
import { institutionalAddressesOf, verifiedAddressesOf } from "./claims.js";
import type { OidcClaims } from "./oidc.js";

/** The `oidc_sub` prefix of an account the heig-classroom import created. */
export const CLASSROOM_SUB_PREFIX = "classroom:";

/** The placeholder `oidc_sub` the import gives a new account. */
export function placeholderSub(classroomSub: string): string {
  return `${CLASSROOM_SUB_PREFIX}${classroomSub}`;
}

/** No IdP subject may take the shape of a placeholder: such a login is refused. */
export function isPlaceholderSub(sub: string): boolean {
  return sub.startsWith(CLASSROOM_SUB_PREFIX);
}

export type Adoption =
  /** A row already holds this `sub`, or nothing matched: the ordinary upsert. */
  | { kind: "none" }
  | { kind: "candidate"; userId: string; key: MatchKey; previousSub: string }
  | { kind: "ambiguous"; key: MatchKey; candidates: string[] };

/** A placeholder account still waiting for its person. */
const waiting = and(like(users.oidcSub, `${CLASSROOM_SUB_PREFIX}%`), isNull(users.anonymizedAt));

const holderOf = (row: { sub: string; anonymizedAt: Date | null }) =>
  isPlaceholderSub(row.sub) && row.anonymizedAt === null;

/** Reads only: the placeholder account this login would adopt, if any. */
export async function findAdoption(tx: Tx, claims: OidcClaims): Promise<Adoption> {
  const [known] = await tx.select({ id: users.id }).from(users).where(eq(users.oidcSub, claims.sub)).limit(1);
  if (known) return { kind: "none" };

  const columns = {
    id: users.id,
    sub: users.oidcSub,
    swissEduId: users.swissEduId,
    anonymizedAt: users.anonymizedAt,
  };
  const bySwissEduId = claims.swissEduId
    ? await tx.select(columns).from(users).where(and(waiting, eq(users.swissEduId, claims.swissEduId)))
    : [];
  const addresses = verifiedAddressesOf(claims.raw, claims.emailVerified);
  const holders = addresses.length
    ? await tx
        .select({ ...columns, email: userEmails.email })
        .from(userEmails)
        .innerJoin(users, eq(users.id, userEmails.userId))
        .where(and(inArray(userEmails.email, addresses), eq(userEmails.verified, true)))
    : [];
  const institutional = new Set(institutionalAddressesOf(claims.raw));
  const decision = decideMatch({
    swissEduId: claims.swissEduId,
    bySwissEduId: bySwissEduId.map((r) => ({ id: r.id, swissEduId: r.swissEduId, eligible: true })),
    addresses: addresses.map((email) => ({
      email,
      institutional: institutional.has(email),
      holders: holders
        .filter((h) => h.email === email)
        .map((h) => ({ id: h.id, swissEduId: h.swissEduId, eligible: holderOf(h) })),
    })),
    addressNeedsNoSwissEduId: true,
  });
  if (decision.kind !== "match") return decision;
  const sub = [...bySwissEduId, ...holders].find((r) => r.id === decision.id)!.sub;
  return { kind: "candidate", userId: decision.id, key: decision.key, previousSub: sub };
}

/**
 * Rewrites the candidate's `oidc_sub`, if it is still a placeholder. False
 * when another login adopted it in the meantime: the caller's upsert then
 * proceeds as for any login.
 */
export async function applyAdoption(tx: Tx, userId: string, sub: string): Promise<boolean> {
  const adopted = await tx
    .update(users)
    .set({ oidcSub: sub })
    .where(and(eq(users.id, userId), waiting))
    .returning({ id: users.id });
  return adopted.length > 0;
}
