/**
 * The GitHub substrate (ADR-035, spec 05 §5.3 and §5.11,
 * docs/merge/03-github-projects.md §3.3). Owned by the `github` module
 * (`modules/github/`, merge tasks M2-02 to M2-04): installations, the
 * classroom's link to an organization, the user's account link, the webhook
 * intake. The project and journal modules read these tables by join and
 * never write them; the intake reaches them through its handler registry.
 *
 * **No column holds a token, a key or a secret** (invariant 15, N-SEC-16):
 * installation tokens live in memory only, and the user token of the
 * account-linking round trip is discarded once the account is read.
 * `github.db.test.ts` asserts it on the columns themselves.
 *
 * GitHub's own ids (`github_org_id`, `installation_id`, `github_user_id`,
 * `github_repo_id`) are immutable, and are what a rename is followed by;
 * logins are display, refreshed when they change. UNIQUE constraints are the
 * idempotency of every handler (ADR-011): replaying an event, from a webhook
 * or a reconciliation, never writes a second row.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { GITHUB_ORG_STATUSES } from "@quiz/contracts";

import { users } from "./auth.js";
import { classrooms } from "./org.js";

/**
 * One organization known to Quiz's App (D23): learnt from the App's setup
 * return, an installation event, or the import of heig-classroom (M8-01).
 * Never deleted. Two independent facts, each held by one column only:
 *   - whether Quiz's App is installed: `installation_id` null or not;
 *   - whether the organization still exists on GitHub: `status`.
 */
export const githubOrganizations = pgTable("github_organizations", {
  id: uuid("id").primaryKey(),
  /** GitHub's id of the organization; null for an imported row not yet resolved. */
  githubOrgId: bigint("github_org_id", { mode: "number" }).unique(),
  login: text("login").notNull().unique(),
  /**
   * The installation of QUIZ's App (D23), never heig-classroom's; null
   * while the App is not installed. Every staging refresh from production
   * nulls it (N-SEC-18, M2-06), and that alone makes the row uninstalled.
   */
  installationId: bigint("installation_id", { mode: "number" }).unique(),
  status: text("status", { enum: GITHUB_ORG_STATUSES }).notNull().default("active"),
  /** GitHub's billing plan (`free`, `team`, ...), read through the App; null while unread. */
  plan: text("plan"),
});

/**
 * A classroom's organization (F-GH-01, D02): at most one per classroom, by
 * its primary key; any number of classrooms per organization. Deleting the
 * classroom drops the link; an organization is never deleted, so its links
 * outlive an uninstallation.
 */
export const githubClassroomLinks = pgTable(
  "github_classroom_links",
  {
    classroomId: uuid("classroom_id")
      .primaryKey()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => githubOrganizations.id),
    linkedBy: uuid("linked_by")
      .notNull()
      .references(() => users.id),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The classrooms of an organization: a rename, an uninstallation, a deletion.
  (t) => [index("github_classroom_links_org_idx").on(t.orgId)],
);

/**
 * A user's GitHub account (F-GH-05). One account belongs to one user: the
 * UNIQUE on `github_user_id` is the refusal of a second link
 * (`?github=conflict`). The id is the person's, not the App's, so the link
 * survives a change of App (D23). No token: the one obtained at linking
 * serves once, to read the account, and is discarded.
 */
export const githubAccounts = pgTable("github_accounts", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  githubUserId: bigint("github_user_id", { mode: "number" }).notNull().unique(),
  /** Followed through the immutable id when the account is renamed (#41). */
  login: text("login").notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every webhook delivery received (N-SEC-17). The primary key is GitHub's
 * `X-GitHub-Delivery`: a redelivery, or a delivery seen twice, is
 * acknowledged and ignored. The row is kept after its payload is purged, so
 * the deduplication outlives GitHub's redelivery window.
 *
 * `payload` is the parsed body, stored because the worker reads it (the job
 * carries only the delivery id) and because a delivery left unprocessed is
 * replayed from it by `reconcile.deliveries` (ADR-011, M2-04): the replay
 * goes through the same handlers, so it needs the event exactly as GitHub
 * sent it. It is set to null 30 days after receipt once processed (spec 05
 * §5.11), which is all a replay or a support question needs; an
 * unprocessed delivery keeps it.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    deliveryId: uuid("delivery_id").primaryKey(),
    /** `X-GitHub-Event`: `push`, `installation`, ... */
    event: text("event").notNull(),
    action: text("action"),
    /** Null once purged. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** The server's receipt time (`app.clock`), written by the intake: no default. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /** Why the last handling failed; cleared by a success. */
    error: text("error"),
  },
  (t) => [
    // The reconciliation: deliveries left unprocessed, oldest first.
    index("webhook_deliveries_pending_idx")
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);

/**
 * The server's receipt of a push (heig-classroom ADR-012, Quiz's ADR-012
 * addendum): written SYNCHRONOUSLY by the intake, before the job is queued,
 * for the repositories a handler registered as tracked (projects' student
 * repositories; the journal writes none). `received_at` is the legal
 * reference of a deadline, never the git timestamp.
 *
 * Keyed on GitHub's repository id, not on a project repository's row: the
 * direction is project → github (03 §3.3), so this module owns no foreign
 * key into `project`, and a receipt is a fact about a GitHub repository.
 * The project module joins it through its repositories' `github_repo_id`.
 * The UNIQUE keeps the FIRST receipt of a head sha (`ON CONFLICT DO
 * NOTHING`): a redelivery never moves it later.
 */
export const pushReceipts = pgTable(
  "push_receipts",
  {
    id: uuid("id").primaryKey(),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    branch: text("branch").notNull(),
    headSha: text("head_sha").notNull(),
    /** The server's receipt time (`app.clock`), written by the intake: no default. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** Pushed by the App's bot (heig-classroom's or Quiz's, D23). */
    isBot: boolean("is_bot").notNull().default(false),
    forced: boolean("forced").notNull().default(false),
  },
  (t) => [uniqueIndex("push_receipts_repo_sha_uq").on(t.githubRepoId, t.headSha)],
);
