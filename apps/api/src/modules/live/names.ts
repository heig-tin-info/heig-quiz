import { eq } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";

/**
 * How the staff's readers of the `live` module name a person: "Given Family",
 * or the fallback (an e-mail) when both are blank.
 */
export function fullName(given: string | null, family: string | null, fallback: string): string {
  return `${given ?? ""} ${family ?? ""}`.trim() || fallback;
}

/**
 * Who wrote `attempt`, as the staff name them: the account's {@link fullName}
 * and e-mail, or `Guest` and no e-mail for a guest's attempt (a poll's),
 * which has no account. The dashboard's inspector and the staff copy read it.
 */
export async function attemptOwnerName(
  db: Db,
  attempt: { userId: string | null },
): Promise<{ displayName: string; email: string | null }> {
  if (attempt.userId === null) return { displayName: "Guest", email: null };
  const [user] = await db
    .select({ givenName: users.givenName, familyName: users.familyName, email: users.email })
    .from(users)
    .where(eq(users.id, attempt.userId))
    .limit(1);
  return user
    ? { displayName: fullName(user.givenName, user.familyName, user.email), email: user.email }
    : { displayName: "Guest", email: null };
}
