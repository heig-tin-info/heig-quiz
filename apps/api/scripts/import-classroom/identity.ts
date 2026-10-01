/**
 * The identity cascade of the import (docs/merge/02-data-and-migration.md
 * §2.4, D08): which Quiz account each heig-classroom user becomes. Reads
 * only; the rule is `decideMatch` of `@quiz/domain`, the very one login
 * adoption applies (ADR-061), and the importer writes what it decides.
 *
 *   1. equal `swiss_edu_id` — exactly one Quiz account;
 *   2. a verified address held by that classroom user alone on the source
 *      side, and by exactly one account in the whole Quiz database
 *      (`sub` is never a key: edu-ID's subjects are pairwise);
 *   3. otherwise a new account, keeping its classroom id where free, under
 *      the placeholder `classroom:<sub>` (`placeholderSub`) that login
 *      adoption rewrites at the person's first Quiz login.
 *
 * Several candidates, or two classroom users landing on one Quiz account,
 * is AMBIGUOUS: reported, never merged, and `--apply` refuses until a person
 * settles it. A `dev:` or anonymized Quiz account is never a candidate. An
 * anonymized classroom user is never matched: it becomes a new, still
 * anonymized, account. A `dev:` classroom user is not imported at all: its
 * placeholder would be adoptable by whoever holds its addresses.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, notLike } from "drizzle-orm";

import { decideMatch } from "@quiz/domain";

import { placeholderSub } from "../../src/auth/adoption.js";
import type { Db } from "../../src/db/client.js";
import { userEmails, users } from "../../src/db/schema.js";
import { normalizeEmail } from "../../src/identity.js";
import type { SourceSnapshot, SourceUser } from "./source.js";

export type Identity =
  | { kind: "mapped"; targetId: string }
  /** `placeholder`: an account an earlier import made, whose `id_map` row is gone. */
  | { kind: "matched"; targetId: string; how: "swiss_edu_id" | "address" | "placeholder" }
  | { kind: "new"; targetId: string; sub: string }
  | { kind: "ambiguous"; reason: string; candidates: string[] }
  /** Left out on purpose (a development account of heig-classroom). */
  | { kind: "excluded"; reason: string };

/** The Quiz account an identity stands for, when it stands for one. */
export function targetOf(identity: Identity | undefined): string | undefined {
  return identity && "targetId" in identity ? identity.targetId : undefined;
}

/** The addresses that identify a classroom user: verified, held by them alone on the source side. */
function sourceAddresses(snapshot: SourceSnapshot, holders: Map<string, Set<string>>, user: SourceUser): string[] {
  const mine = snapshot.userEmails
    .filter((r) => r.userId === user.id && r.verified)
    .map((r) => normalizeEmail(r.email));
  return [...new Set(mine)].filter((e) => e !== "" && holders.get(e)?.size === 1);
}

/** A Quiz account a classroom user may become. */
const eligible = and(notLike(users.oidcSub, "dev:%"), isNull(users.anonymizedAt));

async function cascade(
  db: Db,
  snapshot: SourceSnapshot,
  sourceHolders: Map<string, Set<string>>,
  user: SourceUser,
): Promise<Identity> {
  if (user.oidcSub.startsWith("dev:")) return { kind: "excluded", reason: "a development account of heig-classroom" };
  const fresh = async (): Promise<Identity> => {
    const sub = placeholderSub(user.oidcSub);
    const [made] = await db.select({ id: users.id }).from(users).where(eq(users.oidcSub, sub));
    if (made) return { kind: "matched", targetId: made.id, how: "placeholder" };
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    // A uuid collision is all but impossible; a new id then, never a merge.
    return { kind: "new", targetId: taken ? randomUUID() : user.id, sub };
  };
  if (user.anonymizedAt !== null || user.oidcSub.startsWith("anon-")) return fresh();

  const bySwissEduId = user.swissEduId
    ? await db
        .select({ id: users.id, swissEduId: users.swissEduId })
        .from(users)
        .where(and(eligible, eq(users.swissEduId, user.swissEduId)))
    : [];
  const addresses = sourceAddresses(snapshot, sourceHolders, user);
  const holders = addresses.length
    ? await db
        .selectDistinct({
          id: users.id,
          email: userEmails.email,
          swissEduId: users.swissEduId,
          sub: users.oidcSub,
          anonymizedAt: users.anonymizedAt,
        })
        .from(userEmails)
        .innerJoin(users, eq(users.id, userEmails.userId))
        .where(and(inArray(userEmails.email, addresses), eq(userEmails.verified, true)))
    : [];
  const decision = decideMatch({
    swissEduId: user.swissEduId,
    bySwissEduId: bySwissEduId.map((r) => ({ ...r, eligible: true })),
    addresses: addresses.map((email) => ({
      email,
      // The import asks every address to be unique on both sides.
      institutional: false,
      holders: holders
        .filter((h) => h.email === email)
        .map((h) => ({
          id: h.id,
          swissEduId: h.swissEduId,
          eligible: !h.sub.startsWith("dev:") && h.anonymizedAt === null,
        })),
    })),
    addressNeedsNoSwissEduId: false,
  });
  if (decision.kind === "none") return fresh();
  if (decision.kind === "match") {
    return { kind: "matched", targetId: decision.id, how: decision.key === "swiss_edu_id" ? "swiss_edu_id" : "address" };
  }
  return {
    kind: "ambiguous",
    reason:
      decision.key === "swiss_edu_id"
        ? "several Quiz accounts share the swiss_edu_id"
        : "a verified address is not unique, or its Quiz account has another swiss_edu_id",
    candidates: decision.candidates,
  };
}

/**
 * The identity of every user the import reaches, keyed by source id. An id
 * already in `id_map` (`mapped`, the target ids keyed by source id) is
 * settled; the rest go through the cascade, then two classroom users on one
 * Quiz account turn both ambiguous.
 */
export async function resolveIdentities(
  db: Db,
  snapshot: SourceSnapshot,
  reached: readonly string[],
  mapped: ReadonlyMap<string, string>,
): Promise<Map<string, Identity>> {
  const byId = new Map(snapshot.users.map((u) => [u.id, u]));
  const sourceHolders = new Map<string, Set<string>>();
  for (const row of snapshot.userEmails) {
    if (!row.verified) continue;
    const email = normalizeEmail(row.email);
    sourceHolders.set(email, (sourceHolders.get(email) ?? new Set()).add(row.userId));
  }

  const identities = new Map<string, Identity>();
  for (const id of reached) {
    const user = byId.get(id);
    if (!user) continue;
    const targetId = mapped.get(id);
    identities.set(id, targetId ? { kind: "mapped", targetId } : await cascade(db, snapshot, sourceHolders, user));
  }

  const claimants = new Map<string, string[]>();
  for (const [sourceId, identity] of identities) {
    if (identity.kind !== "matched" && identity.kind !== "mapped") continue;
    claimants.set(identity.targetId, [...(claimants.get(identity.targetId) ?? []), sourceId]);
  }
  for (const [targetId, sources] of claimants) {
    if (sources.length < 2) continue;
    for (const sourceId of sources) {
      identities.set(sourceId, {
        kind: "ambiguous",
        reason: `several heig-classroom accounts (${sources.join(", ")}) would become one Quiz account`,
        candidates: [targetId],
      });
    }
  }
  return identities;
}
