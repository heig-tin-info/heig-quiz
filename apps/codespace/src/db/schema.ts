/**
 * Drizzle schema (SQLite, better-sqlite3).
 *
 * The four entities of the framing document, and nothing else: `users`,
 * `assignments`, `sessions`, `push_events`. The portal has no login session
 * (its OIDC login was removed at M6-03): a user exists through the platform's
 * launch token only.
 *
 * The schema and its migrations are unchanged from heig-classroom's portal, so
 * a database carried over opens as is; a column that only served the removed
 * login (`users.role`, the `oidc_sub` name) stays until a migration is worth
 * it.
 *
 * Timestamps are stored as epoch milliseconds (`timestamp_ms`), UTC, like
 * heig-classroom stores `timestamptz`. SQLite has no timestamp type and a
 * text date would sort badly across time zones.
 */
import { ADMISSION_STATES, CODESPACE_SESSION_STATES, IMAGE_REFUSALS, IMAGE_SOURCES, type CodespaceWorkspaceUpdate } from "@quiz/contracts";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * One row per ref changed by a successful `receive-pack` on a staging
 * repository. This is the timestamped proof of submission (invariant 7: the
 * row is written *before* any relay to the forge is attempted), and the work
 * queue for the relay job at the same time.
 *
 * `state` stays `pending` for as long as the relay is worth retrying — a
 * forge outage must never turn into a lost submission — and only moves to
 * `failed` once the attempt budget is exhausted.
 */
export const PUSH_EVENT_STATES = ["pending", "relayed", "failed", "rejected"] as const;

export const pushEvents = sqliteTable(
  "push_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    student: text("student").notNull(),
    assignment: text("assignment").notNull(),
    /** Full ref name, e.g. `refs/heads/main`. */
    ref: text("ref").notNull(),
    /** Ref value after the push. */
    sha: text("sha").notNull(),
    /** Ref value before the push; null when the ref was created. */
    oldSha: text("old_sha"),
    /** Null when the ref was deleted. */
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * `rejected` (ADR-078 §6): terminal, GitHub refused the ref — a
     * non-fast-forward (the App committed meanwhile: the student pulls) or a
     * change the relay may not make (a workflow file) — or a branch deletion,
     * never relayed. `last_error` carries the reason; the student sees it in
     * the workspace, the staff in the platform's workspace list.
     */
    state: text("state", { enum: PUSH_EVENT_STATES })
      .notNull()
      .default("pending"),
    /** Relay attempts already made; drives the backoff. */
    attempts: integer("attempts").notNull().default(0),
    /** Epoch ms before which the relay job must not pick this row up. */
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    relayedAt: integer("relayed_at", { mode: "timestamp_ms" }),
    /** Last relay error, tokens redacted (see git/relay.ts). */
    lastError: text("last_error"),
  },
  (t) => [
    index("push_events_state_idx").on(t.state, t.nextAttemptAt),
    index("push_events_session_idx").on(t.sessionId, t.receivedAt),
  ],
);

export type PushEventRow = typeof pushEvents.$inferSelect;
export type NewPushEventRow = typeof pushEvents.$inferInsert;

/**
 * The three other entities of the framing document (milestone-0 V1): the user, the
 * assignment, the session. Together with `push_events` above, that makes the
 * four announced tables and nothing else.
 */

/**
 * Portal user, created at its first launch token (`upsertLaunchUser`): no other
 * identity source. `login` is the token's subject: it is what names the volume
 * directory, so it must satisfy the `SAFE_ID` of `git/staging.ts`.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** Prefixed platform subject (`classroom:<sub>`): the identity key. */
    oidcSub: text("oidc_sub").notNull(),
    login: text("login").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull().default(""),
    /**
     * GitHub login, when it is known. It comes from the launch token's claims
     * (the platform is the source of truth for the GitHub link).
     */
    githubLogin: text("github_login"),
    /**
     * Always `student` since M6-03: only the removed OIDC login wrote
     * `teacher`, and a launch token never grants a role.
     */
    role: text("role", { enum: ["student", "teacher"] })
      .notNull()
      .default("student"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("users_oidc_sub_idx").on(t.oidcSub),
    uniqueIndex("users_login_idx").on(t.login),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

/**
 * Assignment, pushed by the platform (`PUT /api/assignments/:id`). The columns
 * that mention a standalone YAML seed served heig-classroom's portal v0; that
 * seed was not imported into Quiz (M6-03), so they are null in practice.
 *
 * `templateRepo` / `targetRepo` carry invariant 6: in exam mode the staging
 * repository is seeded from the **template**, and the target repository is only
 * a relay destination.
 */
export const assignments = sqliteTable("assignments", {
  /** Short identifier, also names the volume subdirectory. */
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  mode: text("mode", { enum: ["lab", "exam"] })
    .notNull()
    .default("lab"),
  /**
   * Legacy: the image the sync froze into the row before ADR-146 (the
   * default at that time when the platform sent none). Still written, for a
   * rollback to an older portal; never read. `imageRef` is what runs.
   */
  image: text("image").notNull(),
  /**
   * The course image the platform's sync names, pinned by digest (ADR-146
   * §4); null = the portal's default, resolved at each container start. A
   * reference the portal has not admitted is stored and refused at session
   * start (`sessions/manager.ts`).
   */
  imageRef: text("image_ref"),
  /** `http.uploadpack` of the staging repository; true by default (analyse.md 3.2). */
  uploadPack: integer("upload_pack", { mode: "boolean" }).notNull().default(true),
  /** The teacher's template repository: URL or path of a local repository. */
  templateRepo: text("template_repo"),
  /** Fixed target repository `<owner>/<name>`. Exclusive with `targetRepoPattern`. */
  targetRepo: text("target_repo"),
  /**
   * Convention, e.g. `codespace/{student}-tp-pointeurs`. `{student}` is
   * substituted. **Fallback**: an assignment synchronised from classroom
   * receives the student's repository through the launch token, and
   * `sessions.targetRepo` is what is authoritative. These two columns remain for
   * the standalone YAML seed (`seed/assignments.yaml`).
   */
  targetRepoPattern: text("target_repo_pattern"),

  // --- Assignment synchronised from heig-classroom ------------------------
  // All null for an assignment coming from the standalone YAML seed.
  /** Owning teacher: carrier of the quota (`sessions.teacherId`). */
  teacherId: text("teacher_id"),
  teacherEmail: text("teacher_email"),
  /** Simultaneous live sessions allowed to this teacher, across all assignments. */
  maxActiveSessions: integer("max_active_sessions"),
  classroomId: text("classroom_id"),
  classroomName: text("classroom_name"),
  /**
   * The teacher's template repository, as classroom names it. Invariant 6: it is
   * from there, and from nowhere else, that an exam staging repository is
   * seeded. `templateRepo` carries its clone URL.
   */
  sourceRepo: text("source_repo", { mode: "json" }).$type<AssignmentRepoRef>(),
  /** Opening window. Null = no bound on that side. */
  opensAt: integer("opens_at", { mode: "timestamp_ms" }),
  closesAt: integer("closes_at", { mode: "timestamp_ms" }),
  /**
   * The Browser Exam Keys of an exam assignment, one per (platform, version)
   * pair: a list, not a scalar (analyse.md 4.4). Empty: the Config Key alone
   * (D21). The `.seb`, its Config Key and its salt are the platform's since
   * M6-07: the Config Key arrives with each launch token.
   */
  beks: text("beks", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /**
   * A staff member's review session (ADR-129 §10): the reviewed project and
   * repository, both Quiz's ids. Null on every synchronized assignment; an
   * assignment is a review if and only if it is set. Its row is upserted by
   * `GET /review` (id `review-<projectRepoId>`), never by a sync.
   */
  reviewOf: text("review_of", { mode: "json" }).$type<ReviewOf>(),
  /**
   * The teacher's update of an `online` project (ADR-132 §11), as the
   * platform's sync sent it: per branch, the commit each `lab` staging
   * repository fetches onto `refs/quiz/update/<branch>`, and the message.
   * Replaced by every sync, null when the platform sends none; never set
   * on an exam (its delivery is still to come) nor on a review.
   */
  workspaceUpdate: text("workspace_update", { mode: "json" }).$type<CodespaceWorkspaceUpdate>(),
});

/** Repository on the forge, as classroom names it (`CodespaceRepoRef`). */
export interface AssignmentRepoRef {
  fullName: string;
  defaultBranch: string;
}

/** What a review assignment reviews (ADR-129 §10): Quiz's project and `project_repos.id`. */
export interface ReviewOf {
  projectId: string;
  projectRepoId: string;
}

export type AssignmentRow = typeof assignments.$inferSelect;
export type NewAssignmentRow = typeof assignments.$inferInsert;

/**
 * Session: a (student, assignment) pair and the container that serves it.
 * Only one live per pair (analyse.md D5); the constraint is held by
 * `sessions/store.ts`, not by a partial index, because "live" is a set of
 * states and SQLite does not index that without duplication.
 *
 * `student` duplicates `users.login` on purpose: the volume path derives from
 * it and must not move if the user record changes.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    student: text("student").notNull(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id),
    /** Podman id; null between the creation of the row and the `run`. */
    containerId: text("container_id"),
    containerName: text("container_name"),
    /** Address on the `codespace` bridge: that is the whole authentication of the Git channel. */
    containerIp: text("container_ip"),
    /** `<VOLUMES_ROOT>/<student>/<assignment>`, kept after the container is destroyed. */
    volumeDir: text("volume_dir").notNull(),
    // The contract's list, so the platform's view of a session and this column
    // cannot drift apart.
    state: text("state", { enum: CODESPACE_SESSION_STATES })
      .notNull()
      .default("starting"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** Heartbeat, updated by the proxy on every request. */
    lastSeen: integer("last_seen", { mode: "timestamp_ms" }).notNull(),
    /** Token of the `cs_session` cookie, carried by the student's browser. */
    cookieToken: text("cookie_token").notNull(),
    /** True if the session was born from an SEB verification (invariant 5). */
    sebVerified: integer("seb_verified", { mode: "boolean" }).notNull().default(false),
    /**
     * Teacher who carries the quota, copied from the assignment at creation
     * time. Copied rather than joined: the quota is counted in a single query,
     * and a reassigned assignment does not move the already open sessions.
     */
    teacherId: text("teacher_id"),
    /** `jti` of the launch token that opened or resumed this session. */
    launchJti: text("launch_jti"),
    /**
     * The student's repository, brought by the launch token. It is the relay's
     * target and, in lab mode, the mirror's source. Null for a session born from
     * the YAML seed: the assignment then carries the convention.
     */
    targetRepo: text("target_repo", { mode: "json" }).$type<AssignmentRepoRef>(),
    /**
     * The kiosk sitting (ADR-089) whose launch opened or resumed this session
     * LAST: the launch token's `kiosk.sitting`, null after any other launch.
     * The close of that sitting rotates the session's cookie only while it
     * still names it (`sessions/sittings.ts`): a browser that resumed the
     * session since already rotated the cookie away from the station.
     */
    openedBySitting: text("opened_by_sitting"),
    /**
     * The image the session's container was last started with (ADR-146
     * §6): a Refresh changes what the next start runs, never a running
     * container, so the image in use is the session's, not the
     * assignment's. Null before its first start.
     */
    image: text("image"),
  },
  (t) => [
    index("sessions_pair_idx").on(t.student, t.assignmentId, t.state),
    index("sessions_state_idx").on(t.state, t.lastSeen),
    // The quota count: a teacher's live sessions, across all assignments.
    index("sessions_teacher_idx").on(t.teacherId, t.state),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;

/**
 * Single use of launch tokens, and of service tokens since audit L25. One row
 * per consumed `jti`; the primary key *is* the guarantee — a second `INSERT`
 * of the same `jti` fails, and it is that refusal that `classroom/routes.ts`
 * turns into a 403 (launch) or a 401 (service).
 *
 * `exp` is kept only for the purge, which waits until `verifyHs256` refuses
 * the token anyway: `exp` plus the skew plus a minute
 * (`JTI_RETENTION_AFTER_EXP_MS`, audit M11).
 */
export const launchTokensUsed = sqliteTable(
  "launch_tokens_used",
  {
    jti: text("jti").primaryKey(),
    /** The token's `exp`, in milliseconds. The row is purged a while after it. */
    exp: integer("exp", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("launch_tokens_used_exp_idx").on(t.exp)],
);

export type LaunchTokenUsedRow = typeof launchTokensUsed.$inferSelect;

/**
 * The kiosk sittings Quiz closed (ADR-089, amendment of 2026-11-15, point
 * 4): the durable revocation of their `exam_session` cookies, which are
 * signed and stateless. The proxy refuses a cookie whose `sitting` has a row
 * here, and `/launch` a token whose `kiosk.sitting` has one, so a close
 * survives a restart. A row is purged once no cookie nor launch token of its
 * sitting can still be valid (`SITTING_RETENTION_MS` of
 * `sessions/sittings.ts`).
 */
export const closedSittings = sqliteTable(
  "closed_sittings",
  {
    sitting: text("sitting").primaryKey(),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("closed_sittings_closed_at_idx").on(t.closedAt)],
);

export type ClosedSittingRow = typeof closedSittings.$inferSelect;

/**
 * The images the portal admitted, or is admitting (ADR-146 §5), one row per
 * REFERENCE: one digest may be admitted under several (`--pull=never` runs
 * a digest only under a name the store holds it by), and a row is never
 * rewritten by a request under another reference. A session runs a course
 * image only once its row is `ready` (`images/admission.ts`); the default
 * is admitted at startup (`source` `default`, its earlier defaults'
 * rows removed), a course's through `POST /api/images/admissions`. A row
 * left `downloading` or `checking` by a restart becomes `refused`
 * `interrupted`. Removed only by the administrator's un-admission
 * (`DELETE /api/images?reference=`, ADR-146 §8), which never touches the
 * store.
 *
 * The default before the first `quiz-base` release is a local tag: its
 * `digest` is then the local image id.
 */
export const admittedImages = sqliteTable(
  "admitted_images",
  {
    /** `registry/repository@digest`, canonical; the local tag of a default not pinned yet. */
    reference: text("reference").primaryKey(),
    digest: text("digest").notNull(),
    state: text("state", { enum: ADMISSION_STATES }).notNull(),
    reason: text("reason", { enum: IMAGE_REFUSALS }),
    /** A quoted diagnostic (byte counts, field names, a last output line), never prose; at most `IMAGE_DETAIL_MAX`. */
    detail: text("detail"),
    /** The released `quiz-base` its first layers are (its version label), once read. */
    baseVersion: text("base_version"),
    compressedBytes: integer("compressed_bytes"),
    diskBytes: integer("disk_bytes"),
    source: text("source", { enum: IMAGE_SOURCES }).notNull(),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    admittedAt: integer("admitted_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("admitted_images_digest_idx").on(t.digest)],
);

export type AdmittedImageRow = typeof admittedImages.$inferSelect;
