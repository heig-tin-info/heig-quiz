/**
 * Which account a person is, from their edu-ID identifiers: the ONE rule of
 * the heig-classroom import (docs/merge/02-data-and-migration.md §2.4) and
 * of login adoption (ADR-061), read from the two ends. Pure: each caller
 * loads the rows, this decides.
 *
 *   1. `swiss_edu_id`: the eligible accounts holding the person's, which
 *      must be non-null. One is a match, several are ambiguous.
 *   2. Failing that, a verified address:
 *      - an INSTITUTIONAL address (asserted by the home organization) reaches
 *        every eligible account holding it, whoever else does;
 *      - any other address only when it is unique: exactly ONE verified
 *        holder in the whole database — eligible or not, of whatever
 *        `swiss_edu_id` — and that holder eligible. A shared address makes
 *        its eligible holders doubtful.
 *   3. An account reached by address is a candidate only if its
 *      `swiss_edu_id` cannot contradict the person's: none at all when
 *      `addressNeedsNoSwissEduId` (adoption: an account with one is adopted
 *      by that key or not at all), else none or the same. Otherwise it is
 *      doubtful too.
 *
 * Exactly one candidate and no other doubtful account: a match. No account
 * at all: none. Anything else: ambiguous, never a guess.
 */

/** An account holding an identifier of the person. */
export interface MatchHolder {
  id: string;
  swissEduId: string | null;
  /** Of the kind sought (an imported placeholder, a live account, ...). */
  eligible: boolean;
}

export interface MatchInput {
  swissEduId: string | null;
  /** The ELIGIBLE accounts whose `swiss_edu_id` equals the person's. */
  bySwissEduId: readonly MatchHolder[];
  /** Each verified address of the person, with EVERY verified holder of it. */
  addresses: readonly { email: string; institutional: boolean; holders: readonly MatchHolder[] }[];
  /** An address may only reach an account without a `swiss_edu_id`. */
  addressNeedsNoSwissEduId: boolean;
}

export type MatchKey = "swiss_edu_id" | "institutional_address" | "private_address";

export type MatchDecision =
  | { kind: "none" }
  | { kind: "match"; id: string; key: MatchKey }
  | { kind: "ambiguous"; key: MatchKey; candidates: string[] };

export function decideMatch(input: MatchInput): MatchDecision {
  if (input.swissEduId !== null && input.bySwissEduId.length > 0) {
    const ids = [...new Set(input.bySwissEduId.map((h) => h.id))].sort();
    return ids.length === 1
      ? { kind: "match", id: ids[0]!, key: "swiss_edu_id" }
      : { kind: "ambiguous", key: "swiss_edu_id", candidates: ids };
  }

  const fits = (h: MatchHolder) =>
    h.swissEduId === null ||
    (!input.addressNeedsNoSwissEduId && (input.swissEduId === null || h.swissEduId === input.swissEduId));
  const hits = new Set<string>();
  const doubtful = new Set<string>();
  // The key names the strongest kind of address that reached an account.
  let key: MatchKey = "private_address";
  for (const address of input.addresses) {
    const eligible = address.holders.filter((h) => h.eligible);
    if (eligible.length > 0 && address.institutional) key = "institutional_address";
    const unique = address.institutional || address.holders.length === 1;
    for (const h of eligible) (unique && fits(h) ? hits : doubtful).add(h.id);
  }

  const all = [...new Set([...hits, ...doubtful])].sort();
  if (all.length === 0) return { kind: "none" };
  const [only] = hits;
  if (hits.size === 1 && all.length === 1 && only !== undefined) return { kind: "match", id: only, key };
  return { kind: "ambiguous", key, candidates: all };
}
