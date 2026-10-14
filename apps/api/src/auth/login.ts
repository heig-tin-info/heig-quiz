/**
 * An OIDC login once the IdP has vouched for the claims: the door it must
 * pass before anything is written (`loginRefusal`), then what it writes
 * (`signIn`). The callback route (plugin.ts) wraps them with the refusal
 * page, the session, the audit and the redirect.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { LoginRefusal } from "@quiz/contracts";
import { admissionRefusal } from "@quiz/domain";

import { audit } from "../audit.js";
import { loginAllowed, type AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { claimEnrollments, hasPendingLine } from "../modules/org/service.js";
import { hasTeacherGrant, syncRoleOfUser } from "../roles.js";
import { applyAdoption, findAdoption, isPlaceholderSub, placeholderFor } from "./adoption.js";
import { affiliationsOf, recordIdpClaims, syncUserEmails, verifiedAddressesOf } from "./claims.js";
import type { OidcClaims } from "./oidc.js";
import type { SessionUser } from "./plugin.js";

/**
 * The door of an OIDC login, judged before any row is written: why it is
 * refused, or null. A subject shaped like an imported placeholder
 * (`classroom:…`, ADR-061) is refused whatever the environment — it would
 * land on that account through the upsert; the super administrator then
 * passes; everyone else must pass the staging allowlist (ADR-028 §3) and
 * admission (ADR-111), on the verified addresses of the claims only.
 * Admission is asked of the claims first, then — only if they do not admit —
 * again with what the database knows: no query while it is off.
 */
export async function loginRefusal(
  db: Db,
  config: AppConfig,
  claims: OidcClaims,
): Promise<LoginRefusal | null> {
  if (isPlaceholderSub(claims.sub)) return "restricted";
  const addresses = verifiedAddressesOf(claims.raw, claims.emailVerified);
  if (config.SUPER_ADMIN_EMAIL !== "" && addresses.includes(config.SUPER_ADMIN_EMAIL)) return null;
  if (!loginAllowed(config, addresses)) return "restricted";
  const asserted = {
    addresses,
    affiliations: affiliationsOf(claims.raw),
    complete: claims.complete,
    known: false,
    invited: false,
  };
  if (admissionRefusal(config.LOGIN_DOMAINS, asserted) === null) return null;
  return admissionRefusal(config.LOGIN_DOMAINS, { ...asserted, ...(await admissionFacts(db, claims, addresses)) });
}

/**
 * What admission reads of the database (ADR-111 §1, §2): whether the login
 * lands on an account — one that holds its subject and is not anonymized,
 * or a placeholder of the import it matches (adopted, or flagged ambiguous
 * by `signIn`) — and whether one of its verified addresses was invited, by
 * a pending roster line or a teacher grant. A course staff seat is keyed on
 * an account, so it invites nobody new.
 */
async function admissionFacts(
  db: Db,
  claims: OidcClaims,
  addresses: readonly string[],
): Promise<{ known: boolean; invited: boolean }> {
  const [[account], line, grant] = await Promise.all([
    db.select({ anonymizedAt: users.anonymizedAt }).from(users).where(eq(users.oidcSub, claims.sub)).limit(1),
    hasPendingLine(db, addresses),
    hasTeacherGrant(db, addresses),
  ]);
  const known = account ? account.anonymizedAt === null : (await placeholderFor(db, claims)).kind !== "none";
  return { known, invited: line || grant };
}

/**
 * Login adoption of an imported heig-classroom account (ADR-061, `adoption.ts`),
 * user upsert (key: oidc_sub), then the address set and the affiliations,
 * then the role through the single rule of roles.ts — the same path as any
 * later recompute, so it counts the course seats — but without the pool
 * succession, which stays tied to the admin and staff actions. A new account starts as a student; an existing one
 * keeps its role until the recompute.
 */
export async function signIn(db: Db, config: AppConfig, claims: OidcClaims): Promise<SessionUser> {
  // `loginRefusal` refused it already; never write under a placeholder subject.
  if (isPlaceholderSub(claims.sub)) throw new Error("A placeholder subject cannot sign in");
  const profile = {
    email: claims.email,
    emailVerified: claims.emailVerified,
    givenName: claims.givenName,
    familyName: claims.familyName,
    swissEduId: claims.swissEduId,
    pictureUrl: claims.picture,
    lastLoginAt: new Date(),
  };
  // Adoption and upsert in one transaction (ADR-061): an account the
  // heig-classroom import made for this person becomes theirs before the
  // upsert, which then lands on it through `oidc_sub`.
  const row = await db.transaction(async (tx) => {
    const found = await findAdoption(tx, claims);
    const adopted = found.kind === "candidate" && (await applyAdoption(tx, found.userId, claims.sub));
    const [upserted] = await tx
      .insert(users)
      .values({ id: randomUUID(), oidcSub: claims.sub, ...profile })
      .onConflictDoUpdate({ target: users.oidcSub, set: profile })
      .returning({ id: users.id });
    if (!upserted) throw new Error("User upsert returned no row");
    const outcome =
      found.kind === "ambiguous"
        ? { action: "auth.adoption_ambiguous" as const, payload: { key: found.key, candidates: found.candidates } }
        : adopted && found.kind === "candidate"
          ? { action: "auth.account_adopted" as const, payload: { key: found.key, previousSub: found.previousSub } }
          : null;
    if (outcome) {
      await audit(tx, { ...outcome, actorUserId: upserted.id, actorType: "system", subjectType: "user", subjectId: upserted.id });
    }
    return upserted;
  });
  // Both are load-bearing: the role reads the affiliations and the verified
  // addresses, and the roster matching reads the addresses. A failed write
  // therefore fails the login — nothing is demoted on a partial picture.
  // Without userinfo the claims lack the affiliations: the previous snapshot
  // is kept, or a transient edu-ID error would demote a teacher and hand
  // their pools on. The address set only ever grows, so it is safe either way.
  if (claims.complete) await recordIdpClaims(db, row.id, claims.raw);
  await syncUserEmails(db, row.id, claims.raw, claims.emailVerified);
  // No pool succession from a login (ADR-013): see storeRole.
  await syncRoleOfUser(db, config, row.id, { succession: false });
  await claimEnrollments(db, row);
  const [user] = await db.select().from(users).where(eq(users.id, row.id));
  if (!user) throw new Error("Signed-in user vanished");
  return user;
}
