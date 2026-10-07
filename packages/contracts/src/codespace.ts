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

/** Work mode of an assignment; `online_seb` opens only from Safe Exam Browser. */
export const WORK_MODES = ["free", "online", "online_seb"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

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
  mode: z.enum(["online", "online_seb"]),
  /** Image from the portal catalog; null = default image. */
  image: z.string().min(1).nullable(),
  /** Template repository: what the workspace is seeded from in exam mode. */
  sourceRepo: CodespaceRepoRef,
  /** Accepted Browser Exam Keys (`online_seb`), one per platform/version pair. */
  browserExamKeys: z.array(z.string().min(1)),
  /** Owning teacher: the holder of the quota. */
  teacher: z.object({ id: z.string().min(1), email: z.string().min(1) }),
  quota: z.object({ maxActiveSessions: z.number().int().min(0) }),
  startAt: IsoDate,
  deadlineAt: IsoDate.nullable(),
});
export type CodespaceAssignmentSync = z.infer<typeof CodespaceAssignmentSync>;

/**
 * The portal's answer to the PUT: what the platform cannot compute (it depends
 * on the `.seb` the portal generates). Both are null outside exam mode.
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
});
export type CodespaceSessionSummary = z.infer<typeof CodespaceSessionSummary>;

/**
 * Launch token (5 min, single use): minted when a student clicks Start,
 * verified by the portal on `GET /launch?token=`. `seb` is present when the
 * launch comes from a `seb` session: this student's Config Key, which the
 * portal checks against the `.seb` it served (docs/merge/06 §6.3 point 4).
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

// ---------------------------------------------------------- Quiz's own routes (M6-06)

/**
 * The student's start route, `GET /app/codespace/start/:projectId` (ADR-047
 * §6, as amended 2026-10-07): a navigable GET, because it is also the
 * `startURL` of Safe Exam Browser (M6-07). Its refusals other than the 404
 * come back to the student's project page as `?workspace=<code>`:
 *   - `not_online` — the project is worked in the student's own tools;
 *   - `seb_required` — an `online_seb` project opens from Safe Exam
 *     Browser only (M6-07: until then, never);
 *   - `not_accepted` — no live repository of theirs yet: accept first;
 *   - `closed` — their deadline has passed.
 */
export const WORKSPACE_START_REFUSALS = ["not_online", "seb_required", "not_accepted", "closed"] as const;
export const WorkspaceStartRefusal = z.enum(WORKSPACE_START_REFUSALS);
export type WorkspaceStartRefusal = z.infer<typeof WorkspaceStartRefusal>;

/** The path of the start route of a project: what the student's button and SEB's `startURL` open. */
export const workspaceStartPath = (projectId: string): string => `/app/codespace/start/${encodeURIComponent(projectId)}`;

/**
 * Why the caller may not set a project's work mode now (ADR-047 as amended
 * 2026-10-07; the pure rule is `workModeRefusal` of `@quiz/domain`):
 * `owner_required` (403, an assistant), `codespace_not_granted` (403, an
 * owner without the administrator's grant), `work_mode_frozen` (409, a
 * workspace was launched), `work_mode_group` (409, a group project).
 */
export const WORK_MODE_REFUSALS = ["owner_required", "codespace_not_granted", "work_mode_frozen", "work_mode_group"] as const;
export const WorkModeRefusal = z.enum(WORK_MODE_REFUSALS);
export type WorkModeRefusal = z.infer<typeof WorkModeRefusal>;

/** `PUT /app/api/projects/:id/workspace/mode`: the project's work mode. */
export const ProjectWorkModeBody = z.strictObject({ mode: z.enum(WORK_MODES) });
export type ProjectWorkModeBody = z.infer<typeof ProjectWorkModeBody>;

/**
 * `GET /app/api/projects/:id/workspace` (staff): the project's work mode,
 * which modes the CALLER may set now and why not the others (the screen
 * offers only what the server would accept), and the state of the last
 * synchronization with the portal — when it went through, and the error of
 * the last attempt (null once one went through). `online_seb` is synced
 * from M6-07, with its Browser Exam Keys. The whole route is a 404 when the
 * online workspace is off (`CODESPACE_URL` empty).
 */
export const ProjectWorkspace = z.object({
  mode: z.enum(WORK_MODES),
  /** The modes the caller may set now, the current one included. */
  allowed: z.array(z.enum(WORK_MODES)),
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
 * (`user`, null when the portal names nobody Quiz knows).
 */
export const ProjectWorkspaceSession = CodespaceSessionSummary.omit({ userId: true }).extend({
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

/** `PATCH /app/api/admin/teachers/:gid/codespace` (admin): either field, at least one. */
export const TeacherCodespaceGrantPatch = z
  .strictObject({
    enabled: z.boolean().optional(),
    maxActiveSessions: z.number().int().min(0).max(MAX_ACTIVE_SESSIONS_LIMIT).optional(),
  })
  .refine((b) => b.enabled !== undefined || b.maxActiveSessions !== undefined, { message: "Nothing to update" });
export type TeacherCodespaceGrantPatch = z.infer<typeof TeacherCodespaceGrantPatch>;

/**
 * The project's workspace as its STUDENT reads it (`StudentProject.workspace`):
 * its mode, when it runs in the portal and the feature is on; null
 * otherwise. Nothing of the portal's state, the quota or another student.
 */
export const StudentProjectWorkspace = z.object({ mode: z.enum(["online", "online_seb"]) });
export type StudentProjectWorkspace = z.infer<typeof StudentProjectWorkspace>;
