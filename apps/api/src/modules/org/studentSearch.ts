/**
 * Finding a student already on the platform, to add them to a roster
 * (ADR-133). A separate function from the staff directory (`directory.ts`,
 * where a student never appears): this one lists students, inside the
 * caller's school only.
 *
 *  - **The tenant** is the school: the domains of the institutional
 *    addresses the caller's last login asserts (`institutionalAddressesOf`,
 *    the rule of `notifications/address.ts`), matched exactly. A candidate
 *    qualifies by the same rule on their own claims. Not `LOGIN_DOMAINS`
 *    (the admission list, every school one day), not the affiliation scope
 *    (`hes-so.ch` for every HES-SO school).
 *  - **Who may search** (`searchTenant`): the caller's own portal session,
 *    whose role holds without course seats (an admin, a grant, a staff
 *    affiliation), with at least one institutional address.
 *  - **Matched**: the name and the in-tenant school addresses, never the
 *    login address (often private: matching it would tell whether a private
 *    address has an account, and whose). **Returned**: the name and one
 *    such address, nothing else.
 *  - **Left out**: pseudonymized and dormant accounts (ADR-117), accounts
 *    with no claims, anyone who claimed a line of this roster or whose
 *    school address (in the tenant) is on it, and the course's staff
 *    (ADR-018: Join as student). Never by another address of theirs: a line
 *    under a private address would otherwise vanish its holder from the
 *    results, and so name whose address it is. Two pending lines of one
 *    person end as a claim conflict (AU-21), as any other two.
 *
 * The database prefilters, with the fold of `@quiz/domain`'s
 * `foldForSearch` encoded as `translate()`; the domain rule decides.
 */
import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";

import type { RosterCandidate } from "@quiz/contracts";
import {
  FOLD_FROM,
  FOLD_TO,
  STUDENT_SEARCH_LIMIT,
  addressesInTenant,
  matchesEveryWord,
  searchWords,
  tenantOf,
} from "@quiz/domain";

import { INSTITUTIONAL_MAIL_CLAIMS, institutionalAddressesOf } from "../../auth/claims.js";
import type { AppConfig } from "../../config.js";
import { likeContains, type Db } from "../../db/client.js";
import { qualified } from "../../db/qualified.js";
import { courseStaff, enrollments, userIdpClaims, users } from "../../db/schema.js";
import { normalizeEmail } from "../../identity.js";
import { roleForUser } from "../../roles.js";

/** Where a search looks: the roster it adds to, and the caller's school. */
export interface SearchScope {
  classroomId: string;
  courseId: string;
  /** The caller's school domains (`searchTenant`), never empty. */
  tenant: readonly string[];
}

/**
 * The caller's school, when they may search it; null otherwise. `ownSession`
 * is `ownPortalSession(req.auth)`: never a personal token, the MCP server,
 * the help assistant nor an impersonation. Super Powers (ADR-054) widen
 * nothing: the tenant is the caller's own.
 */
export async function searchTenant(
  db: Db,
  config: AppConfig,
  callerId: string,
  ownSession: boolean,
): Promise<string[] | null> {
  if (!ownSession) return null;
  const { role } = await roleForUser(db, config, callerId, { seats: false });
  if (role === "student") return null;
  const [row] = await db
    .select({ claims: userIdpClaims.claims })
    .from(userIdpClaims)
    .where(eq(userIdpClaims.userId, callerId))
    .limit(1);
  const tenant = row ? tenantOf(institutionalAddressesOf(row.claims)) : [];
  return tenant.length > 0 ? tenant : null;
}

/** The institutional mail claims of a row, as one text: a superset to prefilter on. */
const institutionalText = sql.join(
  INSTITUTIONAL_MAIL_CLAIMS.map((claim) => sql`coalesce(${qualified(userIdpClaims.claims)} ->> ${claim}, '')`),
  sql` || ' ' || `,
);

/** `foldForSearch`, in SQL. */
const folded = (text: SQL) => sql`translate(lower(${text}), ${FOLD_FROM}, ${FOLD_TO})`;

/** Rows read before the domain rule decides: the prefilter is a superset. */
const PREFILTER_LIMIT = 100;

/** The candidates of `scope` matching `match`, in family-name order. */
async function candidates(
  db: Db,
  scope: SearchScope,
  match: { words: string[] } | { address: string },
): Promise<RosterCandidate[]> {
  const account = qualified(users.id);
  const haystack = folded(sql`${qualified(users.givenName)} || ' ' || ${qualified(users.familyName)} || ' ' || ${institutionalText}`);
  const prefilter =
    "words" in match
      ? match.words.map((word) => sql`${haystack} LIKE ${likeContains(word)}`)
      : [sql`lower(${institutionalText}) LIKE ${likeContains(match.address)}`];
  // The addresses on this roster: a school address among them leaves its
  // holder out (the search would show that address anyway).
  const onRoster = new Set(
    (await db.select({ email: enrollments.email }).from(enrollments).where(eq(enrollments.classroomId, scope.classroomId))).map(
      (line) => normalizeEmail(line.email),
    ),
  );
  const rows = await db
    .select({ givenName: users.givenName, familyName: users.familyName, claims: userIdpClaims.claims })
    .from(users)
    .innerJoin(userIdpClaims, eq(userIdpClaims.userId, users.id))
    .where(
      and(
        isNull(users.anonymizedAt),
        isNull(users.inactivityNotifiedAt),
        or(...scope.tenant.map((domain) => sql`lower(${institutionalText}) LIKE ${likeContains(`@${domain}`)}`)),
        ...prefilter,
        sql`NOT EXISTS (SELECT 1 FROM ${enrollments}
          WHERE ${qualified(enrollments.classroomId)} = ${scope.classroomId} AND ${qualified(enrollments.userId)} = ${account})`,
        sql`NOT EXISTS (SELECT 1 FROM ${courseStaff}
          WHERE ${qualified(courseStaff.courseId)} = ${scope.courseId} AND ${qualified(courseStaff.userId)} = ${account})`,
      ),
    )
    .orderBy(asc(users.familyName), asc(users.givenName), asc(users.id))
    .limit(PREFILTER_LIMIT);

  const found: RosterCandidate[] = [];
  for (const row of rows) {
    const school = addressesInTenant(institutionalAddressesOf(row.claims), scope.tenant);
    if (school.some((address) => onRoster.has(address))) continue;
    const fits =
      "words" in match
        ? matchesEveryWord(match.words, [row.givenName, row.familyName, ...school])
        : school.includes(match.address);
    if (!fits) continue;
    found.push({
      givenName: row.givenName,
      familyName: row.familyName,
      email: "address" in match ? match.address : school[0]!,
    });
    if (found.length === STUDENT_SEARCH_LIMIT) break;
  }
  return found;
}

/** The people of the caller's school a search names; none under three characters. */
export async function findStudents(db: Db, scope: SearchScope, q: string): Promise<RosterCandidate[]> {
  const words = searchWords(q);
  return words.length === 0 ? [] : candidates(db, scope, { words });
}

/**
 * The candidate a pick names, checked again by the same filter: the client
 * cannot add, by a pick, anyone the search would not have offered it.
 */
export async function findStudentByAddress(
  db: Db,
  scope: SearchScope,
  address: string,
): Promise<RosterCandidate | null> {
  const [found] = await candidates(db, scope, { address: address.trim().toLowerCase() });
  return found ?? null;
}
