/**
 * The login GitHub knows today for a linked account (F-GH-05, M2-03), the
 * rename half of `auth`'s writes to `github_accounts` (`githubLink.ts` holds
 * the link, the unlink and the import). A leaf: the modules that name a
 * student on GitHub (project, journal) import it without loading the link
 * plugin, which itself calls the `project` module.
 */
import { and, eq } from "drizzle-orm";
import type { Octokit } from "octokit";

import { GITHUB_ACCOUNT_STALE } from "@quiz/contracts";

import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { githubAccounts } from "../db/schema.js";
import { currentLogin } from "../github/collaborators.js";

/**
 * The login GitHub knows TODAY for a user's linked account, followed through
 * its immutable id (`GET /user/{account_id}`, heig-classroom #41): a renamed
 * account's row is updated and `github.renamed` audited. A user with no link
 * left, or whose account GitHub no longer has, gets `GITHUB_ACCOUNT_STALE` —
 * the `409` body, "Relink GitHub" in the web. Any other failure (GitHub
 * unreachable, rate limit) throws: the caller may then go on with the stored
 * login. `octokit` is an installation client of the caller's organization
 * (an App JWT cannot read users).
 *
 * For the tasks that name or invite a student on GitHub: a project's
 * Accept (`modules/project/accept.ts`, M3-03), and M4-03.
 */
export async function linkedLogin(
  db: Db,
  octokit: Octokit,
  userId: string,
  /** The user's link when the caller has read it already. */
  loaded?: typeof githubAccounts.$inferSelect,
): Promise<string | typeof GITHUB_ACCOUNT_STALE> {
  const [linked] = loaded ? [loaded] : await db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId));
  if (!linked) return GITHUB_ACCOUNT_STALE;
  const login = await currentLogin(octokit, linked.githubUserId);
  if (login === null) return GITHUB_ACCOUNT_STALE;
  if (login === linked.login) return login;
  // Conditional on the login read: two requests that notice the same rename
  // audit it once.
  const moved = await db
    .update(githubAccounts)
    .set({ login })
    .where(and(eq(githubAccounts.userId, userId), eq(githubAccounts.login, linked.login)))
    .returning({ userId: githubAccounts.userId });
  if (moved.length > 0) {
    await audit(db, {
      actorUserId: null,
      actorType: "system",
      action: "github.renamed",
      subjectType: "user",
      subjectId: userId,
      payload: { githubUserId: linked.githubUserId, from: linked.login, to: login },
    });
  }
  return login;
}
