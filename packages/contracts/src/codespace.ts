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

import {
  DEVICE_LEVEL_IDS,
  GIT_TOKEN_REFUSALS,
  STAFF_REVIEW_REFUSALS,
  SUPERVISED_DEVICE_LEVELS,
  WORK_MODE_REFUSALS,
  WORK_MODES,
  WORKSPACE_START_REFUSALS,
} from "@quiz/domain";

import { ProtectedPath, RepositoryFullName, Sha1 } from "./gitNames.js";

/**
 * Work mode of a project; `online_seb` is supervised: it opens only from
 * the trusted clients of its device level (ADR-089).
 * The lists are `@quiz/domain`'s (`workMode.ts`), re-exported here.
 */
export { GIT_TOKEN_REFUSALS, STAFF_REVIEW_REFUSALS, WORK_MODE_REFUSALS, WORK_MODES, WORKSPACE_START_REFUSALS };
export const WorkMode = z.enum(WORK_MODES);
export type WorkMode = z.infer<typeof WorkMode>;

/**
 * A device level (ADR-089, amendment of 2026-11-15, point 2): `any`, `seb`,
 * `either` (SEB or a kiosk station), `kiosk`. `@quiz/domain`'s
 * `DEVICE_LEVELS` owns the list and the clients of each.
 */
export const DeviceLevel = z.enum(DEVICE_LEVEL_IDS);
export type DeviceLevel = z.infer<typeof DeviceLevel>;

/** A level that requires a trusted client: what an `online_seb` project holds. */
export const SupervisedDeviceLevel = z.enum(SUPERVISED_DEVICE_LEVELS);
export type SupervisedDeviceLevel = z.infer<typeof SupervisedDeviceLevel>;

/**
 * The two issuers of a launch token accepted during the transition
 * (docs/merge/06 §6.2): heig-classroom's own, and Quiz's. Quiz signs with
 * its own, and a service token comes from Quiz only (ADR-078, amendment of
 * 2026-10-11).
 */
export const CODESPACE_ISSUERS = ["heig-classroom", "heig-quiz"] as const;
export type CodespaceIssuer = (typeof CODESPACE_ISSUERS)[number];
export const QUIZ_CODESPACE_ISSUER = "heig-quiz" satisfies CodespaceIssuer;

/** The portal's own issuer: its service calls, and the two git relay routes it calls on Quiz (ADR-078). */
export const PORTAL_ISSUER = "heig-codespace";

/** The portal's two audiences: a student launch, and server-to-server calls. */
export const LAUNCH_AUDIENCE = "heig-codespace";
export const SERVICE_AUDIENCE = "heig-codespace-api";

/** Lifetimes in seconds: a launch token is single use (`jti`) and short. */
export const LAUNCH_TOKEN_TTL_SECONDS = 300;
export const SERVICE_TOKEN_TTL_SECONDS = 120;

/**
 * A token's own lifetime, `exp - iat`, is positive and at most `ttl`: a
 * token signed for longer is refused even before it expires (audit M11),
 * so a consumed `jti` never has to be remembered past `ttl` plus the skew.
 */
const lifetimeWithin =
  (ttl: number) =>
  (c: { iat: number; exp: number }): boolean =>
    c.exp > c.iat && c.exp - c.iat <= ttl;

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
  fullName: RepositoryFullName,
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
 * The claims every token that opens a portal session carries, defined once
 * (ADR-129 §7): the signature's frame and who opens it, on which repository.
 */
const launchIdentityClaims = <A extends string>(aud: A) =>
  z.object({
    iss: z.enum(CODESPACE_ISSUERS),
    aud: z.literal(aud),
    iat: z.number(),
    exp: z.number(),
    jti: z.string().min(1),
    /** The user's stable id on the platform; names a volume directory. */
    sub: z.string().refine(isSafeId, "subject unsuitable for a volume path"),
    email: z.string().min(1),
    displayName: z.string(),
    githubLogin: z.string().nullable(),
    /** The target repository; null when it is not provisioned yet. */
    repo: CodespaceRepoRef.nullable(),
  });

/** Who opens a portal session, on which repository: the claims both launch tokens share. */
export type LaunchIdentityClaims = Pick<
  z.infer<ReturnType<typeof launchIdentityClaims>>,
  "sub" | "email" | "displayName" | "githubLogin" | "repo"
>;

/**
 * Launch token (5 min, single use): minted when a student clicks Start,
 * verified by the portal on `GET /launch?token=`. `seb` is present when the
 * launch comes from a `seb` session (D21, M6-07): the Config Key of this
 * student's own `.seb`, built by the platform. The portal checks SEB's
 * `X-SafeExamBrowser-ConfigKeyHash` against this claim, and refuses an exam
 * launch without it (docs/merge/06 §6.3 point 4). `kiosk` is present instead
 * when the launch comes from a kiosk station's session (ADR-089 §4): the
 * station, and the `sitting` — the id of the pairing that seated the
 * student there, never a session's key — whose end closes the portal
 * session. Never both.
 */
export const LaunchTokenClaims = launchIdentityClaims(LAUNCH_AUDIENCE)
  .extend({
    assignmentId: z.string().min(1),
    seb: z.object({ configKey: ConfigKey }).optional(),
    kiosk: z.object({ deviceId: z.uuid(), sitting: z.uuid() }).optional(),
  })
  .refine((c) => c.seb === undefined || c.kiosk === undefined, "one trusted client per launch")
  .refine(lifetimeWithin(LAUNCH_TOKEN_TTL_SECONDS), "a launch token lives five minutes at most");
export type LaunchTokenClaims = z.infer<typeof LaunchTokenClaims>;

/**
 * The staff's review session (ADR-129): its own audience, so that a review
 * token is never read as a student's launch, nor the reverse; verified by
 * the portal on its own route, `GET /review?token=`, never on `/launch`.
 */
export const REVIEW_AUDIENCE = "heig-codespace-review";

/**
 * Review launch token (5 min, single use, ADR-129 §7): a staff member opens
 * one repository of a project. `repo` is the reviewed repository; `holder`
 * the project's quota holder, whose quota the session counts against, and
 * `maxActiveSessions` that holder's grant.
 */
export const ReviewLaunchTokenClaims = launchIdentityClaims(REVIEW_AUDIENCE)
  .extend({
    projectId: z.uuid(),
    projectRepoId: z.uuid(),
    holder: z.object({ id: z.string().min(1), email: z.string().min(1) }),
    maxActiveSessions: z.number().int().min(0),
  })
  .refine(lifetimeWithin(LAUNCH_TOKEN_TTL_SECONDS), "a launch token lives five minutes at most");
export type ReviewLaunchTokenClaims = z.infer<typeof ReviewLaunchTokenClaims>;

/**
 * Service token (2 min) for Quiz's calls to the portal
 * (`PUT /api/assignments/:id`, `GET /api/assignments/:id/sessions`,
 * `POST /api/assignments/:id/collections`). It
 * authorizes ONE request, `@quiz/domain`'s `requestBinding` of it, and the
 * portal consumes its `jti` once (audit L25, ADR-078's amendment of
 * 2026-10-11, which owns the rule).
 */
export const ServiceTokenClaims = z
  .object({
    iss: z.literal(QUIZ_CODESPACE_ISSUER),
    aud: z.literal(SERVICE_AUDIENCE),
    iat: z.number(),
    exp: z.number(),
    jti: z.string().min(1).max(200),
    method: z.enum(["GET", "PUT", "POST"]),
    path: z.string().startsWith("/"),
    bodyHash: z.string().min(1).optional(),
  })
  .refine(lifetimeWithin(SERVICE_TOKEN_TTL_SECONDS), "a service token lives two minutes at most");
export type ServiceTokenClaims = z.infer<typeof ServiceTokenClaims>;

// ---------------------------------------------------------- the close of a kiosk sitting (ADR-089)

/**
 * The close of a kiosk station's sitting (ADR-089, amendment of 2026-11-15,
 * point 4): Quiz → portal, `POST /api/sittings/close` with the token as its
 * bearer and no body. Its own audience, so it is never read as a service
 * token nor a launch, nor the reverse.
 */
export const SITTING_CLOSE_AUDIENCE = "heig-codespace-sitting-close";
export const SITTING_CLOSE_PATH = "/api/sittings/close";

/**
 * The message IS the token (as ADR-078's requests are): two minutes at most,
 * single use (`jti`), naming the `sitting` — the approving pairing's id, the
 * `kiosk.sitting` of the launch tokens it opened — and its project while the
 * project still exists (null once deleted). The portal revokes that
 * sitting's `exam_session` cookies, drops the sockets upgraded under them and
 * rotates the portal session that sitting opened last; idempotent, a
 * replay or an unknown sitting answering success without effect.
 */
export const SittingCloseClaims = z
  .object({
    iss: z.literal(QUIZ_CODESPACE_ISSUER),
    aud: z.literal(SITTING_CLOSE_AUDIENCE),
    iat: z.number(),
    exp: z.number(),
    jti: z.string().min(1).max(200),
    sitting: z.uuid(),
    projectId: z.uuid().nullable(),
  })
  .refine(lifetimeWithin(SERVICE_TOKEN_TTL_SECONDS), "a close lives two minutes at most");
export type SittingCloseClaims = z.infer<typeof SittingCloseClaims>;

// ---------------------------------------------------------- the git relay's tokens (ADR-078)

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
    projectId: z.uuid(),
    /** The Quiz user the workspace belongs to (the launch token's `sub`). */
    userId: z.uuid(),
    repository: RepositoryFullName,
  });

/**
 * `POST /app/codespace/git-token`: an installation token on ONE repository.
 * `reviewRepoId` (a `project_repos.id`) names a repository a staff member
 * launched a review session of (ADR-129 §7): a read grant, decided by that
 * record and the user's staff access, never by ADR-078's launch rule.
 */
export const GitTokenRequestClaims = gitRequestClaims(GIT_TOKEN_AUDIENCE)
  .extend({ reviewRepoId: z.uuid().optional() })
  .refine(lifetimeWithin(GIT_REQUEST_TTL_SECONDS), "a request lives one minute at most");
export type GitTokenRequestClaims = z.infer<typeof GitTokenRequestClaims>;

/** A head the portal is about to push: a ref and a full SHA-1 (GitHub serves SHA-1 repositories only; ADR-130, 2026-11-16). */
export const RelayHead = z.object({
  ref: z.string().regex(/^refs\/[^\s\0]+$/).max(255),
  sha: Sha1,
});
export type RelayHead = z.infer<typeof RelayHead>;

/** `POST /app/codespace/relay-heads`: the heads of the next relay push, declared before it (204). */
export const RelayHeadsClaims = gitRequestClaims(RELAY_HEADS_AUDIENCE)
  .extend({ heads: z.array(RelayHead).min(1).max(RELAY_HEADS_MAX) })
  .refine(lifetimeWithin(GIT_REQUEST_TTL_SECONDS), "a request lives one minute at most");
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
export const GIT_TOKEN_ERRORS = [...GIT_TOKEN_REFUSALS, "unauthorized", "github_unavailable"] as const;
export const GitTokenError = z.object({ error: z.enum(GIT_TOKEN_ERRORS) });
export type GitTokenError = z.infer<typeof GitTokenError>;

// ---------------------------------------------------------- the collection at the deadline (ADR-130)

/** Quiz → portal: collect one student's workspace (ADR-130 §4), a service token bound to the request. */
export const collectionsPath = (assignmentId: string): string => `/api/assignments/${assignmentId}/collections`;

/**
 * The temporary ref Quiz names for one collection: under `refs/quiz/collect/`,
 * one component of letters, digits, `-` and `_` — no dot (so no `..` nor
 * `.lock`), no slash, never a branch.
 */
export const CollectionRef = z.string().regex(/^refs\/quiz\/collect\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "a ref under refs/quiz/collect/ expected");

/**
 * The order (ADR-130 §4): whose workspace (`userId`, the launch token's
 * `sub`, which names the volume), the repository, the head on GitHub of the
 * branch it is collected to (`base`), the commit that would otherwise be
 * graded (`target`, null when the student never pushed in time: the base is
 * then compared), the paths taken from the base (`keep`,
 * `collectionKeptPaths`), and the temporary ref Quiz names. The portal parses
 * it with this schema before anything runs: no other check.
 */
export const CodespaceCollectionRequest = z
  .object({
    userId: z.string().refine(isSafeId, "user id unsuitable for a volume path"),
    repository: RepositoryFullName,
    base: Sha1,
    target: Sha1.nullable(),
    keep: z.array(ProtectedPath).max(200),
    ref: CollectionRef,
  })
  .strict();
export type CodespaceCollectionRequest = z.infer<typeof CodespaceCollectionRequest>;

/**
 * Why a collection failed on the portal's side: Quiz or GitHub refused the
 * credential (`forge_refused`), GitHub or Quiz could not be reached
 * (`forge_unavailable`), GitHub refused the push (`push_rejected`), git
 * failed on the host (`git_error`), or the collection's time budget ran out
 * (`timeout`). Details stay in the portal's log.
 */
export const COLLECTION_FAILURES = ["forge_refused", "forge_unavailable", "push_rejected", "git_error", "timeout"] as const;
export type CollectionFailure = (typeof COLLECTION_FAILURES)[number];

/**
 * When the snapshot was taken (the engine's clock), and how many files the
 * portal could not read (their last version is kept); null when the last
 * snapshot was used instead of a fresh one, whose count is not known.
 */
const SnapshotFacts = { snapshotAt: IsoDate, unreadable: z.number().int().min(0).nullable() };

/**
 * The portal's answer: `pushed` — a throwaway commit of `tree` on the base,
 * on the temporary ref; only Quiz decides whether that becomes a collection
 * (ADR-130 §4) —, `unchanged` (the tree is the target's: nothing pushed), why
 * nothing was collected (ADR-130 §3), or `failed`.
 */
export const CodespaceCollectionResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("pushed"), tree: Sha1, ...SnapshotFacts }),
  z.object({ outcome: z.literal("unchanged"), ...SnapshotFacts }),
  z.object({ outcome: z.literal("too_large"), ...SnapshotFacts }),
  z.object({ outcome: z.literal("stale_snapshot"), snapshotAt: IsoDate }),
  z.object({ outcome: z.literal("no_snapshot") }),
  z.object({ outcome: z.literal("failed"), reason: z.enum(COLLECTION_FAILURES) }),
]);
export type CodespaceCollectionResult = z.infer<typeof CodespaceCollectionResult>;

// ---------------------------------------------------------- Quiz's own routes (M6-06)

/**
 * The student's start route, `POST /app/api/projects/:projectId/workspace/start`
 * (ADR-047 §6, as amended 2026-10-07 and for audit L7): a write of the
 * project page, Safe Exam Browser's too (from the project page its `.seb`
 * opened, D21), never a navigation — a cross-site link must not launch. It
 * answers {@link WorkspaceStart}; its refusals other than the 404 are `409 {
 * error: <code> }`, which the page shows as `?workspace=<code>`:
 *   - `not_online` — the project is worked in the student's own tools;
 *   - `seb_required` — an `online_seb` project whose level accepts SEB
 *     opens from the trusted clients of that level only (M6-07, ADR-089);
 *   - `kiosk_required` — one at Kiosk only opens from a kiosk station only
 *     (ADR-089, amendment point 2);
 *   - `not_accepted` — no live repository of theirs yet: accept first;
 *   - `closed` — their deadline has passed, or the classroom is archived.
 * The rule is `workspaceStartRefusal` of `@quiz/domain`.
 */
export const WorkspaceStartRefusal = z.enum(WORKSPACE_START_REFUSALS);
export type WorkspaceStartRefusal = z.infer<typeof WorkspaceStartRefusal>;

/** The start route, as the server registers it. */
export const WORKSPACE_START_ROUTE = "/app/api/projects/:id/workspace/start";

/** The start route of a project: what the student's *Open workspace* POSTs to. */
export const workspaceStartPath = (projectId: string): string =>
  `/app/api/projects/${encodeURIComponent(projectId)}/workspace/start`;

/** The start route's answer: the portal's `/launch?token=…`, where the page goes. Never cached. */
export const WorkspaceStart = z.object({ url: z.url() });
export type WorkspaceStart = z.infer<typeof WorkspaceStart>;

/**
 * The staff's review session (ADR-129 §5): `POST
 * /app/api/projects/:id/repos/:rid/workspace/review`, a session write of the
 * project page, no body, answering {@link WorkspaceReview}. Its refusals
 * past the 404 are `409 { error: <code> }` ({@link StaffReviewRefusal}, the
 * rule `staffReviewRefusal` of `@quiz/domain`).
 */
export const StaffReviewRefusal = z.enum(STAFF_REVIEW_REFUSALS);
export type StaffReviewRefusal = z.infer<typeof StaffReviewRefusal>;

/**
 * How long after a review launch the portal may ask for its read token
 * (ADR-129 §6, which owns the figure), in minutes.
 */
export const REVIEW_GRANT_MINUTES = 15;

/** The review route, as the server registers it. */
export const WORKSPACE_REVIEW_ROUTE = "/app/api/projects/:id/repos/:rid/workspace/review";

/** The review route of one repository of a project. */
export const workspaceReviewPath = (projectId: string, repoId: string): string =>
  `/app/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}/workspace/review`;

/** The review route's answer: the portal's `/review?token=…`, where the page goes. Never cached. */
export const WorkspaceReview = z.object({ url: z.url() });
export type WorkspaceReview = z.infer<typeof WorkspaceReview>;

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
 * workspace was launched), `work_mode_group` (409, a group project),
 * `kiosk_unavailable` (422, a change to a level that accepts a kiosk station
 * while the platform does not offer them to projects, ADR-089).
 */
export const WorkModeRefusal = z.enum(WORK_MODE_REFUSALS);
export type WorkModeRefusal = z.infer<typeof WorkModeRefusal>;

/**
 * `PUT /app/api/projects/:id/workspace/mode`: the project's work mode and,
 * under supervision only, its device level (ADR-089, amendment point 2): a
 * union discriminated by `mode`, so a mismatched pair is refused here
 * (invariant 7). Out of `online_seb` the server writes the level `any`.
 */
export const ProjectWorkModeBody = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("free") }),
  z.strictObject({ mode: z.literal("online") }),
  z.strictObject({ mode: z.literal("online_seb"), devices: SupervisedDeviceLevel }),
]);
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
  /** The device level (ADR-089): `any` out of `online_seb`. */
  devices: DeviceLevel,
  /**
   * The platform offers kiosk stations to projects (`KIOSK_PROJECTS`,
   * ADR-089 amendment point 1): a change to a level that accepts one is
   * refused otherwise (`kiosk_unavailable`), the level in force kept.
   */
  kioskOffered: z.boolean(),
  /** The modes the caller may set now, the current one included. */
  allowed: z.array(WorkMode),
  /** Why another mode is refused to the caller (the first refusal met); null when every mode is open. */
  refusal: WorkModeRefusal.nullable(),
  syncedAt: z.iso.datetime().nullable(),
  syncError: z.string().nullable(),
  /**
   * The staff may open a repository in a review session (ADR-129 §3, §11):
   * the project's quota holder holds an enabled workspace grant.
   */
  review: z.boolean(),
  /**
   * The quota a station sitting runs against (ADR-089, amendment point 7):
   * the quota holder's `maxActiveSessions` and the classroom's claimed
   * student seats; the setting warns when the seats exceed it. Null without
   * a quota holder or without a grant.
   */
  quota: z.object({ max: z.number().int().min(0), seats: z.number().int().min(0) }).nullable(),
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
 * its mode and device level (ADR-089: Kiosk only offers no `.seb`), when it
 * runs in the portal and the feature is on; null
 * otherwise. Nothing of the portal's state, the quota or another student.
 */
export const StudentProjectWorkspace = z.object({ mode: WorkMode.exclude(["free"]), devices: DeviceLevel });
export type StudentProjectWorkspace = z.infer<typeof StudentProjectWorkspace>;
