/**
 * What an OIDC login writes, once the IdP has vouched for the claims. The
 * callback route (plugin.ts) wraps it with the session, the audit and the
 * redirect.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { loginAllowed, type AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { claimEnrollments } from "../modules/org/service.js";
import { syncRoleOfUser } from "../roles.js";
import { recordIdpClaims, syncUserEmails, verifiedAddressesOf } from "./claims.js";
import type { OidcClaims } from "./oidc.js";
import type { SessionUser } from "./plugin.js";

/**
 * The staging allowlist (ADR-028), checked before any row is written, on
 * the verified addresses of the claims only.
 */
export function loginAdmits(
  config: AppConfig,
  claims: Pick<OidcClaims, "raw" | "emailVerified">,
): boolean {
  return loginAllowed(config, verifiedAddressesOf(claims.raw, claims.emailVerified));
}

/**
 * User upsert (key: oidc_sub), then the address set and the affiliations,
 * then the role through the single rule of roles.ts — the same path as any
 * later recompute, so it counts the course seats and runs the pool
 * succession on a loss. A new account starts as a student; an existing one
 * keeps its role until the recompute.
 */
export async function signIn(db: Db, config: AppConfig, claims: OidcClaims): Promise<SessionUser> {
  const profile = {
    email: claims.email,
    emailVerified: claims.emailVerified,
    givenName: claims.givenName,
    familyName: claims.familyName,
    swissEduId: claims.swissEduId,
    pictureUrl: claims.picture,
    lastLoginAt: new Date(),
  };
  const [row] = await db
    .insert(users)
    .values({ id: randomUUID(), oidcSub: claims.sub, ...profile })
    .onConflictDoUpdate({ target: users.oidcSub, set: profile })
    .returning({ id: users.id });
  if (!row) throw new Error("User upsert returned no row");
  // Both are load-bearing: the role reads the affiliations and the verified
  // addresses, and the roster matching reads the addresses. A failed write
  // therefore fails the login — nothing is demoted on a partial picture.
  // Without userinfo the claims lack the affiliations: the previous snapshot
  // is kept, or a transient edu-ID error would demote a teacher and hand
  // their pools on. The address set only ever grows, so it is safe either way.
  if (claims.complete) await recordIdpClaims(db, row.id, claims.raw);
  await syncUserEmails(db, row.id, claims.raw, claims.emailVerified);
  await syncRoleOfUser(db, config, row.id);
  await claimEnrollments(db, row);
  const [user] = await db.select().from(users).where(eq(users.id, row.id));
  if (!user) throw new Error("Signed-in user vanished");
  return user;
}
