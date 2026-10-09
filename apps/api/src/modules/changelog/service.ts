/**
 * What's new on the platform (ADR-087). The texts ship in the build
 * (`bundle.ts`); `changelog_entries` dates each one by the first boot that
 * served it, on the database's clock, and `users.changelog_seen_at` (the auth
 * module's, read here by join, written by `POST /app/api/me/changelog`) says
 * what a reader has acknowledged. Both times are the database's, so they
 * compare.
 */
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";

import type { ChangelogAudience, ChangelogEntry, ChangelogSource } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { changelogEntries, users } from "../../db/schema.js";

/**
 * At boot: every bundled entry gets its row, once. A row already there keeps
 * its first date and commit, whatever deploy comes after.
 */
export async function syncChangelog(db: Db, entries: readonly ChangelogSource[], commitSha: string | null) {
  if (entries.length === 0) return;
  await db
    .insert(changelogEntries)
    .values(entries.map((e) => ({ id: e.id, commitSha })))
    .onConflictDoNothing();
}

/** A student reads the student entries; staff (a teacher, an admin) both audiences. */
const audiencesOf = (role: string): ChangelogAudience[] =>
  role === "student" ? ["student"] : ["student", "teacher"];

/**
 * The entries `user` may read, newest first: all of them, or (`unseen`) those
 * live after their last acknowledgement. Only the bundle's texts are served:
 * a row whose entry left the build is never shown.
 */
export async function changelogFor(
  db: Db,
  entries: readonly ChangelogSource[],
  user: { id: string; role: string },
  unseen: boolean,
): Promise<ChangelogEntry[]> {
  const audiences = audiencesOf(user.role);
  const texts = new Map(entries.filter((e) => audiences.includes(e.audience)).map((e) => [e.id, e]));
  if (texts.size === 0) return [];
  const rows = await db
    .select({ id: changelogEntries.id, liveAt: changelogEntries.firstLiveAt, commitSha: changelogEntries.commitSha })
    .from(changelogEntries)
    .innerJoin(users, eq(users.id, user.id))
    .where(
      and(
        inArray(changelogEntries.id, [...texts.keys()]),
        unseen ? gt(changelogEntries.firstLiveAt, users.changelogSeenAt) : undefined,
      ),
    )
    .orderBy(desc(changelogEntries.firstLiveAt), asc(changelogEntries.id));
  return rows.map(({ id, liveAt, commitSha }) => {
    const { kind, en, fr } = texts.get(id)!;
    return { id, kind, text: { en, fr }, liveAt: liveAt.toISOString(), commitSha };
  });
}
