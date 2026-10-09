/**
 * The changelog's releases (ADR-087), owned by the `changelog` module
 * (`modules/changelog/`). The TEXT of an entry is not here: it ships in the
 * build (`dist/changelog.json`, from `changes/<slug>.md`). A row only says
 * when the entry first went live — the database's clock at the first boot
 * whose bundle held it — and that boot's commit. Inserted at boot with `ON
 * CONFLICT DO NOTHING`, so a later deploy never moves it; a row whose entry
 * left the bundle is ignored when reading.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const changelogEntries = pgTable("changelog_entries", {
  /** The entry's slug, its file name: immutable once merged. */
  id: text("id").primaryKey(),
  firstLiveAt: timestamp("first_live_at", { withTimezone: true }).notNull().defaultNow(),
  /** `COMMIT_SHA` of that boot; null when the build carried none. */
  commitSha: text("commit_sha"),
});
