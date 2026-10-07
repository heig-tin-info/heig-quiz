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

/**
 * One row of the portal's answer to `GET /api/assignments/:id/sessions`
 * (service token): the teacher's view of an assignment's workspaces.
 * `userId` is the platform's id (the launch token's `sub`) when the account
 * came from a launch, so the platform can match it to its own users.
 */
/** A workspace session's lifecycle on the portal (its `sessions.state`). */
export const CODESPACE_SESSION_STATES = ["starting", "running", "stopped", "closed", "failed"] as const;
export type CodespaceSessionState = (typeof CODESPACE_SESSION_STATES)[number];

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
