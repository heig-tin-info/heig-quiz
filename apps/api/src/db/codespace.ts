/**
 * The online workspace's side of a project (ADR-047, merge task M6-06),
 * owned by the `codespace` module (`modules/codespace/`): what Quiz knows of
 * the portal's copy of a project. The project's `work_mode` itself is the
 * `project` module's column; this module reads it by join and never writes
 * `projects`.
 *
 * One row per project the portal has heard of, or that a workspace was
 * launched for, written lazily (an upsert): a project in `free` mode that
 * never went online has none. Deleted with its project. Nothing here is a
 * secret: the launch token is never stored (its `jti` is in the audit log).
 */
import { bigint, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { projects } from "./project.js";

export const codespaceProjects = pgTable("codespace_projects", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** The last synchronization the portal accepted (`codespace.sync`). */
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  /** The failure of the last attempt, for the staff; cleared by the next one that goes through. */
  syncError: text("sync_error"),
  /**
   * The first launch token issued for the project, by the server's clock:
   * from then on its work mode is frozen (`409 work_mode_frozen`, ADR-047
   * §3 as amended 2026-10-07). Never cleared.
   */
  firstLaunchAt: timestamp("first_launch_at", { withTimezone: true }),
});

/**
 * Quiz's record of launches (ADR-078 §6): per (project, user), the first and
 * the last launch token issued, written in the start route's transaction —
 * a staff seat's launch too (it freezes no mode, ADR-077, but its workspace
 * relays like any). The git relay's token route reads it: no launch, no
 * token. Nothing in it is a secret.
 */
export const codespaceLaunches = pgTable(
  "codespace_launches",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firstLaunchAt: timestamp("first_launch_at", { withTimezone: true }).notNull(),
    lastLaunchAt: timestamp("last_launch_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

/**
 * The heads the portal declared before relaying them (ADR-078 §2, §6): one
 * row per (GitHub repository, sha), idempotent. A push whose sender is
 * Quiz's App is the student's only when its `after` is one of these — read
 * by join by the `github` module's intake and the `project` module's push
 * handler (one primary-key lookup). Never a credential.
 */
export const codespaceRelays = pgTable(
  "codespace_relays",
  {
    /** GitHub's repository id: what a webhook names. */
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    sha: text("sha").notNull(),
    /** The ref it was declared for (the first declaration's). */
    ref: text("ref").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.githubRepoId, t.sha] })],
);
