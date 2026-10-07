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
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
