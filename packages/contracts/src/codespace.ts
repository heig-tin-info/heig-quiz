/**
 * The online workspace contract (ADR-047, M6-01): two HS256-signed messages
 * between the platform and the portal (`apps/codespace`), which never import
 * each other. The shapes come from heig-classroom's
 * `packages/contracts/src/codespace.ts` and stay wire-compatible with it.
 *
 * The secret (`CODESPACE_LAUNCH_SECRET`) signs and verifies; it is never in
 * a payload, a log or the database (ADR-010).
 */
import { z } from "zod";

import { WORK_MODE_REFUSALS, WORK_MODES, WORKSPACE_START_REFUSALS } from "@quiz/domain";

/**
 * Work mode of a project; `online_seb` opens only from Safe Exam Browser.
 * The lists are `@quiz/domain`'s (`workMode.ts`), re-exported here.
 */
export { WORK_MODE_REFUSALS, WORK_MODES, WORKSPACE_START_REFUSALS };
export const WorkMode = z.enum(WORK_MODES);
export type WorkMode = z.infer<typeof WorkMode>;

/**
 * The two issuers accepted during the transition (docs/merge/06 §6.2):
 * heig-classroom's own, and Quiz's. The portal accepts both; Quiz signs
 * with its own.
 */
export const CODESPACE_ISSUERS = ["heig-classroom", "heig-quiz"] as const;
export type CodespaceIssuer = (typeof CODESPACE_ISSUERS)[number];
export const QUIZ_CODESPACE_ISSUER: CodespaceIssuer = "heig-quiz";

/** The portal's two audiences: a student launch, and server-to-server calls. */
export const LAUNCH_AUDIENCE = "heig-codespace";
export const SERVICE_AUDIENCE = "heig-codespace-api";
export const PLATFORM_SERVICE_AUDIENCE = "heig-classroom-api";

/** Lifetimes in seconds: a launch token is single use (`jti`) and short. */
export const LAUNCH_TOKEN_TTL_SECONDS = 300;
export const SERVICE_TOKEN_TTL_SECONDS = 120;

/**
 * An id that names a directory under the portal's volumes root: refused here
 * rather than at the first session start. (`.` and `..` are excluded.)
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isSafeId = (value: string): boolean => SAFE_ID.test(value) && value !== "." && value !== "..";

const IsoDate = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), "ISO 8601 date expected");

const ConfigKey = z.string().regex(/^[0-9a-f]{64}$/);

/** A student's target repository. */
export const CodespaceRepoRef = z.object({
  /** `<owner>/<name>` on the forge. */
  fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repository expected in the form owner/name"),
  defaultBranch: z.string().min(1),
});
export type CodespaceRepoRef = z.infer<typeof CodespaceRepoRef>;

/**
 * An assignment as the portal needs it: sent (PUT, idempotent) every time an
 * `online*` assignment is saved, before any student can launch it.
 */
export const CodespaceAssignmentSync = z.object({
  id: z.string().refine(isSafeId, "id unsuitable for a path"),
  slug: z.string().min(1),
  name: z.string().min(1),
  classroomId: z.string().min(1),
  classroomName: z.string(),
  mode: WorkMode.exclude(["free"]),
  /** Image from the portal catalog; null = default image. */
  image: z.string().min(1).nullable(),
  /** Template repository: what the workspace is seeded from in exam mode. */
  sourceRepo: CodespaceRepoRef,
  /**
   * Accepted Browser Exam Keys (`online_seb`), one per platform/version
   * pair. Empty: the Config Key alone (D21, Quiz's default).
   */
  browserExamKeys: z.array(z.string().min(1)),
  /** Owning teacher: the holder of the quota. */
  teacher: z.object({ id: z.string().min(1), email: z.string().min(1) }),
  quota: z.object({ maxActiveSessions: z.number().int().min(0) }),
  startAt: IsoDate,
  deadlineAt: IsoDate.nullable(),
});
export type CodespaceAssignmentSync = z.infer<typeof CodespaceAssignmentSync>;

/**
 * The portal's answer to the PUT, wire-compatible with heig-classroom's: the
 * Config Key and link of a `.seb` the portal generated. Since D21 (M6-07) the
 * platform builds every `.seb`, so Quiz's portal answers null for both.
 */
export const CodespaceAssignmentSyncResult = z.object({
  id: z.string().min(1),
  /** Config Key of the `.seb` served for this assignment: 64 lowercase hex. */
  configKey: ConfigKey.nullable(),
  /** The `sebs://` deep link, the student's one-click hand-over to SEB. */
  sebLink: z.string().min(1).nullable(),
});
export type CodespaceAssignmentSyncResult = z.infer<typeof CodespaceAssignmentSyncResult>;

/** A workspace session's lifecycle on the portal (its `sessions.state`). */
export const CODESPACE_SESSION_STATES = ["starting", "running", "stopped", "closed", "failed"] as const;
export type CodespaceSessionState = (typeof CODESPACE_SESSION_STATES)[number];

/**
 * One row of the portal's answer to `GET /api/assignments/:id/sessions`
 * (service token): the teacher's view of an assignment's workspaces.
 * `userId` is the platform's id (the launch token's `sub`) when the account
 * came from a launch, so the platform can match it to its own users.
 */
export const CodespaceSessionSummary = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  email: z.string(),
  state: z.enum(CODESPACE_SESSION_STATES),
  createdAt: IsoDate,
  /** The last heartbeat of the proxy; set when the session is created. */
  lastSeenAt: IsoDate,
  lastPushAt: IsoDate.nullable(),
  /**
   * The session's last push GitHub refused (ADR-078 §6): a non-fast-forward
   * — the App committed meanwhile, the student must pull — or a change
   * GitHub forbids the relay (a workflow file), with GitHub's reason. Null
   * when none, or when a later push of the same branch went through.
   * Absent from an older portal: null.
   */
  rejectedPush: z
    .object({ ref: z.string().min(1), at: IsoDate, reason: z.string() })
    .nullable()
    .default(null),
});
export type CodespaceSessionSummary = z.infer<typeof CodespaceSessionSummary>;

/**
 * Launch token (5 min, single use): minted when a student clicks Start,
 * verified by the portal on `GET /launch?token=`. `seb` is present when the
 * launch comes from a `seb` session (D21, M6-07): the Config Key of this
 * student's own `.seb`, built by the platform. The portal checks SEB's
 * `X-SafeExamBrowser-ConfigKeyHash` against this claim, and refuses an exam
 * launch without it (docs/merge/06 §6.3 point 4).
 */
export const LaunchTokenClaims = z.object({
  iss: z.enum(CODESPACE_ISSUERS),
  aud: z.literal(LAUNCH_AUDIENCE),
  iat: z.number(),
  exp: z.number(),
  jti: z.string().min(1),
  /** The user's stable id on the platform; names a volume directory. */
  sub: z.string().refine(isSafeId, "subject unsuitable for a volume path"),
  email: z.string().min(1),
  displayName: z.string(),
  githubLogin: z.string().nullable(),
  assignmentId: z.string().min(1),
  /** The target repository; null when it is not provisioned yet. */
  repo: CodespaceRepoRef.nullable(),
  seb: z.object({ configKey: ConfigKey }).optional(),
});
export type LaunchTokenClaims = z.infer<typeof LaunchTokenClaims>;

/** Service token (2 min) for server-to-server calls, either direction. */
export const ServiceTokenClaims = z.object({
  iss: z.enum([...CODESPACE_ISSUERS, "heig-codespace"]),
  aud: z.enum([SERVICE_AUDIENCE, PLATFORM_SERVICE_AUDIENCE]),
  iat: z.number(),
  exp: z.number(),
});
export type ServiceTokenClaims = z.infer<typeof ServiceTokenClaims>;

// ---------------------------------------------------------- the git relay's tokens (ADR-078)

/** The portal's issuer on the two routes it calls on Quiz. */
export const PORTAL_ISSUER = "heig-codespace";
/** `POST /app/codespace/git-token`'s audience: refused anywhere else, and anything else refused there. */
export const GIT_TOKEN_AUDIENCE = "heig-quiz-git-token";
/** `POST /app/codespace/relay-heads`'s audience. */
export const RELAY_HEADS_AUDIENCE = "heig-quiz-relay-heads";
export const GIT_TOKEN_PATH = "/app/codespace/git-token";
export const RELAY_HEADS_PATH = "/app/codespace/relay-heads";
/** A request token lives one minute at most (`exp - iat`). */
export const GIT_REQUEST_TTL_SECONDS = 60;
/** At most this many heads per declaration. */
export const RELAY_HEADS_MAX = 50;

/** `owner/name`, as GitHub names a repository. */
const RepositoryFullName = z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repository expected in the form owner/name");

/**
 * The claims both routes share (ADR-078 §2): the request IS the signed
 * token, so a token seen in transit cannot be re-aimed at another
 * repository, and it expires within a minute.
 */
const gitRequestClaims = <A extends string>(aud: A) =>
  z.object({
    iss: z.literal(PORTAL_ISSUER),
    aud: z.literal(aud),
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.string().min(1).max(200),
    /** The project (the portal's `assignmentId`). */
    projectId: z.string().min(1),
    /** The Quiz user the workspace belongs to (the launch token's `sub`). */
    userId: z.string().min(1),
    repository: RepositoryFullName,
  });
const shortLived = (c: { iat: number; exp: number }) => c.exp - c.iat <= GIT_REQUEST_TTL_SECONDS && c.exp > c.iat;

/** `POST /app/codespace/git-token`: an installation token on ONE repository. */
export const GitTokenRequestClaims = gitRequestClaims(GIT_TOKEN_AUDIENCE).refine(shortLived, "a request lives one minute at most");
export type GitTokenRequestClaims = z.infer<typeof GitTokenRequestClaims>;

/** A head the portal is about to push: a ref and a full sha (SHA-1 or SHA-256). */
export const RelayHead = z.object({
  ref: z.string().regex(/^refs\/[^\s\0]+$/).max(255),
  sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});
export type RelayHead = z.infer<typeof RelayHead>;

/** `POST /app/codespace/relay-heads`: the heads of the next relay push, declared before it (204). */
export const RelayHeadsClaims = gitRequestClaims(RELAY_HEADS_AUDIENCE)
  .extend({ heads: z.array(RelayHead).min(1).max(RELAY_HEADS_MAX) })
  .refine(shortLived, "a request lives one minute at most");
export type RelayHeadsClaims = z.infer<typeof RelayHeadsClaims>;

/**
 * Quiz's answer to the token route, sent with `Cache-Control: no-store`.
 * `expiresAt` is GitHub's; `useUntil` the last instant the portal may use
 * it: for a write grant `min(expiresAt, effective deadline + grace)`, for
 * a read grant `expiresAt`.
 */
export const GitTokenGrant = z.object({
  token: z.string().min(1),
  expiresAt: IsoDate,
  useUntil: IsoDate,
  repository: z.object({ fullName: RepositoryFullName, githubRepoId: z.number().int().positive() }),
  permission: z.enum(["write", "read"]),
});
export type GitTokenGrant = z.infer<typeof GitTokenGrant>;

/**
 * Why the two routes refuse: `unauthorized` (401, the signature, audience,
 * lifetime or `jti`), `not_found` (404), `not_online` and `closed` (409),
 * `github_unavailable` (503). The first four are not outages: the portal
 * waits on its slow backoff (ADR-078 §3).
 */
export const GIT_TOKEN_ERRORS = ["unauthorized", "not_found", "not_online", "closed", "github_unavailable"] as const;
export const GitTokenError = z.object({ error: z.enum(GIT_TOKEN_ERRORS) });
export type GitTokenError = z.infer<typeof GitTokenError>;

// ---------------------------------------------------------- Quiz's own routes (M6-06)

/**
 * The student's start route, `GET /app/codespace/start/:projectId` (ADR-047
 * §6, as amended 2026-10-07): a navigable GET, which Safe Exam Browser
 * follows too (from the project page its `.seb` opened, D21). Its refusals
 * other than the 404 come back to the student's project page as
 * `?workspace=<code>`:
 *   - `not_online` — the project is worked in the student's own tools;
 *   - `seb_required` — an `online_seb` project opens from its Safe Exam
 *     Browser session only (M6-07);
 *   - `not_accepted` — no live repository of theirs yet: accept first;
 *   - `closed` — their deadline has passed, or the classroom is archived.
 * The rule is `workspaceStartRefusal` of `@quiz/domain`.
 */
export const WorkspaceStartRefusal = z.enum(WORKSPACE_START_REFUSALS);
export type WorkspaceStartRefusal = z.infer<typeof WorkspaceStartRefusal>;

/** The path of the start route of a project: what the student's *Open workspace* opens. */
export const workspaceStartPath = (projectId: string): string => `/app/codespace/start/${encodeURIComponent(projectId)}`;

/**
 * The student's `.seb` of an `online_seb` project (D21, M6-07): a one-time
 * file whose start URL opens a `seb` session confined to the project.
 */
export const projectSebPath = (projectId: string): string => `/app/api/projects/${encodeURIComponent(projectId)}/seb`;

/**
 * Why the caller may not set a project's work mode now (ADR-047 as amended
 * 2026-10-07; the pure rule is `workModeRefusal` of `@quiz/domain`):
 * `owner_required` (403, an assistant), `codespace_not_granted` (403, an
 * owner without the administrator's grant), `work_mode_frozen` (409, a
 * workspace was launched), `work_mode_group` (409, a group project).
 */
export const WorkModeRefusal = z.enum(WORK_MODE_REFUSALS);
export type WorkModeRefusal = z.infer<typeof WorkModeRefusal>;

/** `PUT /app/api/projects/:id/workspace/mode`: the project's work mode. */
export const ProjectWorkModeBody = z.strictObject({ mode: WorkMode });
export type ProjectWorkModeBody = z.infer<typeof ProjectWorkModeBody>;

/**
 * `GET /app/api/projects/:id/workspace` (staff): the project's work mode,
 * which modes the CALLER may set now and why not the others (the screen
 * offers only what the server would accept), and the state of the last
 * synchronization with the portal — when it went through, and the error of
 * the last attempt (null once one went through). The whole route is a 404
 * when the online workspace is off (`CODESPACE_URL` empty).
 */
export const ProjectWorkspace = z.object({
  mode: WorkMode,
  /** The modes the caller may set now, the current one included. */
  allowed: z.array(WorkMode),
  /** Why another mode is refused to the caller (the first refusal met); null when every mode is open. */
  refusal: WorkModeRefusal.nullable(),
  syncedAt: z.iso.datetime().nullable(),
  syncError: z.string().nullable(),
});
export type ProjectWorkspace = z.infer<typeof ProjectWorkspace>;

/**
 * One workspace of the project as the staff read it
 * (`GET /app/api/projects/:id/workspace/sessions`): the portal's
 * {@link CodespaceSessionSummary}, its `userId` matched to a Quiz account
 * (`user`, null when the portal names nobody of the classroom). Never the
 * portal's address of an account: an unmatched one is not the staff's to read.
 */
export const ProjectWorkspaceSession = CodespaceSessionSummary.omit({ userId: true, email: true }).extend({
  user: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type ProjectWorkspaceSession = z.infer<typeof ProjectWorkspaceSession>;

/** The project's workspaces, live from the portal; `reachable: false` when it could not be asked (never an error page). */
export const ProjectWorkspaceSessions = z.object({
  reachable: z.boolean(),
  sessions: z.array(ProjectWorkspaceSession),
});
export type ProjectWorkspaceSessions = z.infer<typeof ProjectWorkspaceSessions>;

/** The resync's answer (`POST /app/api/projects/:id/workspace/sync`, 202): when it was asked. */
export const ProjectWorkspaceSyncAccepted = z.object({ requestedAt: z.iso.datetime() });
export type ProjectWorkspaceSyncAccepted = z.infer<typeof ProjectWorkspaceSyncAccepted>;

/** The default quota of a grant: the portal's capacity is a handful of sessions (ADR-047 §4). */
export const DEFAULT_MAX_ACTIVE_SESSIONS = 2;
/** The largest quota an administrator may grant. */
export const MAX_ACTIVE_SESSIONS_LIMIT = 200;

/**
 * A teacher's workspace grant (ADR-047 §4): may they put a project in the
 * portal, and how many of their workspaces may run at once. On each row of
 * `GET /app/api/admin/teachers`; null there when the feature is off.
 */
export const TeacherCodespaceGrant = z.object({
  enabled: z.boolean(),
  maxActiveSessions: z.number().int().min(0).max(MAX_ACTIVE_SESSIONS_LIMIT),
});
export type TeacherCodespaceGrant = z.infer<typeof TeacherCodespaceGrant>;

/** `PATCH /app/api/admin/teachers/:gid/codespace` (admin): either field of {@link TeacherCodespaceGrant}, at least one. */
export const TeacherCodespaceGrantPatch = TeacherCodespaceGrant.partial()
  .strict()
  .refine((b) => b.enabled !== undefined || b.maxActiveSessions !== undefined, { message: "Nothing to update" });
export type TeacherCodespaceGrantPatch = z.infer<typeof TeacherCodespaceGrantPatch>;

/**
 * The project's workspace as its STUDENT reads it (`StudentProject.workspace`):
 * its mode, when it runs in the portal and the feature is on; null
 * otherwise. Nothing of the portal's state, the quota or another student.
 */
export const StudentProjectWorkspace = z.object({ mode: WorkMode.exclude(["free"]) });
export type StudentProjectWorkspace = z.infer<typeof StudentProjectWorkspace>;
