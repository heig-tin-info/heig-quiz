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
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { ADMISSION_IN_FLIGHT, ADMISSION_STATES, IMAGE_REFUSALS } from "@quiz/contracts";
import { COLLECTION_FAILURE_REASONS, COLLECTION_OUTCOMES } from "@quiz/domain";

import { users } from "./auth.js";
import { oneOf } from "./columns.js";
import { courses } from "./org.js";
import { projectRepos, projects } from "./project.js";

/**
 * A course's workspace images (ADR-146 §4): at most five per course, a name
 * unique in it (case ignored), the reference its owner gave (canonical, by
 * tag or digest; never changed), and the digest in service. Written by this
 * module only; the portal admits (§5), Quiz mirrors.
 *
 * `digest_reference` is what a project picking the image runs
 * (`registry/repository@sha256:…`): null until the first admission is
 * ready, swapped only when a Refresh's candidate is (§6). While an admission
 * is in flight, `candidate_reference` names it and `state` is its
 * `downloading` or `checking`; `state`, `reason` and `detail` are always the
 * last admission's, `base_version` and `disk_bytes` the image in service's.
 * Goes with its course (cascade); a project's choice holds it
 * (`codespace_projects.image_id`).
 */
export const courseWorkspaceImages = pgTable(
  "course_workspace_images",
  {
    id: uuid("id").primaryKey(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The owner's reference, canonical: `registry/repository:tag` or `…@sha256:…`. */
    reference: text("reference").notNull(),
    /** The digest in service, canonical; null until the first admission is ready. */
    digestReference: text("digest_reference"),
    /** The digest reference of the admission in flight (the first, or a Refresh's); null when none. */
    candidateReference: text("candidate_reference"),
    state: text("state", { enum: ADMISSION_STATES }).notNull(),
    reason: text("reason", { enum: IMAGE_REFUSALS }),
    /** The portal's raw diagnostic of a refusal, never prose. */
    detail: text("detail"),
    baseVersion: text("base_version"),
    diskBytes: bigint("disk_bytes", { mode: "number" }),
    /** When the last admission was asked, Quiz's clock: its follow-up gives up 30 minutes on. */
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    /** NO ACTION: an account is pseudonymized, never deleted (ADR-117). */
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // One name per course, case ignored; it also serves the course's foreign key.
    uniqueIndex("course_workspace_images_course_name_uq").on(t.courseId, sql`lower(${t.name})`),
    check("course_workspace_images_state_ck", oneOf(t.state, ADMISSION_STATES)),
    check("course_workspace_images_reason_ck", sql`${t.reason} IS NULL OR ${oneOf(t.reason, IMAGE_REFUSALS)}`),
    // A candidate exactly while an admission is in flight.
    check(
      "course_workspace_images_candidate_ck",
      sql`(${t.candidateReference} IS NOT NULL) = (${oneOf(t.state, ADMISSION_IN_FLIGHT)})`,
    ),
  ],
);

export const codespaceProjects = pgTable(
  "codespace_projects",
  {
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
    /**
     * The course image the project runs (ADR-146 §4), one of its course's;
     * null: the default, `quiz-base`. Never frozen by a launch: a change
     * reaches the containers started afterwards. The module refuses to
     * remove an image in use (`409 image_in_use`), under the image row's
     * lock that a concurrent choice's key check waits for. The key itself
     * SETS NULL rather than restricting: a course's delete reaches both rows
     * by two cascades, and a RESTRICT (or NO ACTION) key fails it when the
     * image's goes first.
     */
    imageId: uuid("image_id").references(() => courseWorkspaceImages.id, { onDelete: "set null" }),
  },
  (t) => [index("codespace_projects_image_idx").on(t.imageId)],
);

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
 * The staff's review launches (ADR-129 §6): per (staff member, repository),
 * until when the portal may ask for the read token of the review session
 * just launched — the launch time plus `REVIEW_GRANT_MINUTES`, by the
 * database's clock, moved by every launch. The token route's only proof
 * that this user launched a review of this repository; never a credential.
 */
export const codespaceReviews = pgTable(
  "codespace_reviews",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectRepoId: uuid("project_repo_id")
      .notNull()
      .references(() => projectRepos.id, { onDelete: "cascade" }),
    grantUntil: timestamp("grant_until", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectRepoId] })],
);

/**
 * An owner's review launches of a project's distribution repository
 * (ADR-147 §4): per (owner, project), the twin of {@link codespaceReviews}
 * keyed by the project, since the distribution has no `project_repos` row.
 * Until when the portal may ask for the distribution's read token, the
 * launch time plus `REVIEW_GRANT_MINUTES` by the database's clock, moved by
 * every launch. Never a credential.
 */
export const codespaceDistributionReviews = pgTable(
  "codespace_distribution_reviews",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    grantUntil: timestamp("grant_until", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] })],
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

/**
 * The workspace collected at a repository's deadline (ADR-130 §2, §7): one
 * row per (repository, effective deadline), claimed before the portal is
 * called — the unique key is the at-most-once — and settled with its
 * outcome. `outcome` null: ordered, never settled (a crash), shown to the
 * staff as unconfirmed and never ordered again for that deadline. An
 * extension that reopens the repository gives it a new deadline, so a
 * second row. Written by the deadline job's collection only. Never a
 * credential, never file content.
 */
export const codespaceCollections = pgTable(
  "codespace_collections",
  {
    id: uuid("id").primaryKey(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => projectRepos.id, { onDelete: "cascade" }),
    /** The effective deadline it was collected for. */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    /** When the collection was claimed, Quiz's clock. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    outcome: text("outcome", { enum: COLLECTION_OUTCOMES }),
    reason: text("reason", { enum: COLLECTION_FAILURE_REASONS }),
    /** The branch committed to: what the next job reads to settle a row a crash left unsettled. */
    branch: text("branch"),
    /** The signed commit, written BEFORE the branch moves (with its receipt), cleared if it never reaches it. */
    sha: text("sha"),
    /** Files the portal could not read; null when unknown. */
    unreadable: integer("unreadable"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("codespace_collections_repo_deadline_uq").on(t.repoId, t.deadlineAt)],
);

/**
 * The relay's requests already served (ADR-078 §2, amendment of 2026-10-11,
 * #743): one row per consumed `jti` of `POST /app/codespace/git-token` and
 * `POST /app/codespace/relay-heads`. The primary key IS the single use — a
 * second `INSERT` of the same `jti` conflicts and the route answers `401` —
 * not a read followed by a write. `exp` (the request's) is kept for the
 * purge alone, which waits until `verifyHs256` would refuse the request
 * anyway (`exp` plus the skew plus a minute). Never a credential.
 */
export const codespaceRelayJtis = pgTable(
  "codespace_relay_jtis",
  {
    jti: text("jti").primaryKey(),
    exp: timestamp("exp", { withTimezone: true }).notNull(),
    /** The receipt, by the server's clock. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("codespace_relay_jtis_exp_idx").on(t.exp)],
);
