/**
 * The `codespace` module (ADR-047 as amended 2026-10-07, merge task M6-06):
 * what Quiz says to the online workspace portal (`apps/codespace`), and
 * the entry other modules import. The two applications never import each
 * other: they exchange the two HS256-signed messages of
 * `@quiz/contracts`' `codespace.ts`, signed with `CODESPACE_LAUNCH_SECRET`
 * (environment only, ADR-010) by `signHs256` of `@quiz/domain`.
 *
 *   - Quiz → portal: the project (`PUT /api/assignments/:id`, a 2-minute
 *     single-use service token bound to the request, {@link portalCall}),
 *     sent by the `codespace.sync` job ({@link requestCodespaceSync}) so that
 *     a portal restarting never fails a teacher's save; and the staff's read
 *     of its workspaces (`GET /api/assignments/:id/sessions`).
 *   - student → portal: a 5-minute single-use launch token, minted by the
 *     start route (`routes.ts`, {@link launchToken}) and carried in a 303.
 *   - staff → portal: a review launch token on one repository of a project
 *     ({@link startReview}, ADR-129), its own audience — or, an owner's, on
 *     the project's distribution repository (ADR-147), a null repository id.
 *   - Quiz → portal: the close of a kiosk station's sitting
 *     ({@link sendSittingClose}, ADR-089), its own audience.
 *
 * Off — `CODESPACE_URL` empty — the module registers nothing (every route a
 * 404) and {@link requestCodespaceSync} does nothing.
 *
 * It owns `codespace_projects` and `course_workspace_images` (`db/codespace.ts`;
 * a course's images and a project's choice are `images.ts`'s, ADR-146) and
 * reads the projects, the course's staff and the grants by join; a project's
 * `work_mode` is written by the `project` module (`setWorkMode`).
 */
import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { z } from "zod";

import {
  BranchName,
  CodespaceAssignmentSync,
  CodespaceAssignmentSyncResult,
  CodespaceSessionSummary,
  type CodespaceWorkspaceUpdate,
  DEFAULT_MAX_ACTIVE_SESSIONS,
  LAUNCH_AUDIENCE,
  LAUNCH_TOKEN_TTL_SECONDS,
  QUIZ_CODESPACE_ISSUER,
  REVIEW_AUDIENCE,
  REVIEW_GRANT_MINUTES,
  SERVICE_AUDIENCE,
  SERVICE_TOKEN_TTL_SECONDS,
  SITTING_CLOSE_AUDIENCE,
  SITTING_CLOSE_PATH,
  type LaunchTokenClaims,
  type SittingCloseClaims,
  type ReviewLaunchTokenClaims,
  type StaffReviewRefusal,
  type DistributionReviewRefusal,
  type DeviceLevel,
  type WorkMode,
  type WorkspaceStartRefusal,
  type ProjectWorkspace,
  type ProjectWorkspaceSessions,
  type ServiceTokenClaims,
  type TeacherCodespaceGrant,
} from "@quiz/contracts";
import {
  hasTwoWritePaths,
  isLabMode,
  isOnlineMode,
  portalDeadline,
  portalMode,
  projectIsLive,
  projectIsVisible,
  deviceLevelClients,
  quotaHolder,
  requestBinding,
  signHs256,
  distributionReviewRefusal,
  staffReviewRefusal,
  workModeChoices,
  workspaceStartRefusal,
} from "@quiz/domain";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import { kioskProjectsOn, type AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import {
  botCommits,
  classrooms,
  codespaceLaunches,
  codespaceProjects,
  codespaceRelays,
  codespaceReviews,
  courseStaff,
  courseWorkspaceImages,
  enrollments,
  githubAccounts,
  projectRepos,
  projects,
  pushReceipts,
  teacherGrants,
  users,
} from "../../db/schema.js";
import { knownEmails, normalizeEmail } from "../../identity.js";
import { CODESPACE_SYNC_QUEUE } from "../../jobs.js";
import { PORTAL } from "../../auth/session.js";
import { findStudentProjectView, type Caller, type Reach } from "../guards.js";
import { portalCall, PORTAL_TIMEOUT_MS } from "./portal.js";

/** The portal is wired up at all: an empty `CODESPACE_URL` means the feature does not exist (ADR-047 §5). */
export function codespaceOn(config: Pick<AppConfig, "CODESPACE_URL">): boolean {
  return config.CODESPACE_URL !== "";
}

// ---------------------------------------------------------------- grants (ADR-047 §4)

/**
 * The workspace grant of an account, THE one read of it (the mode switch,
 * the staff's view and the quota sent to the portal all ask it): the
 * `teacher_grants` rows of any of its VERIFIED addresses — its verified ones
 * (`knownEmails`, GH-11, as the role rule reads them) and its sign-in
 * address when the identity provider verified it — the most permissive
 * winning, as the role rule does. Null without a row: no grant, the default
 * quota. An administrator (`users.role = 'admin'`, the account role the role
 * rule gives `SUPER_ADMIN_EMAIL`, with or without active Super Powers)
 * ALWAYS holds the grant, with at least the default quota (ADR-047,
 * amendment of 2026-10-08), and a row of theirs raises the quota, never
 * lowers it nor turns the workspace off (amendment of 2026-11-16).
 */
export async function grantOf(db: Db | Tx, userId: string): Promise<TeacherCodespaceGrant | null> {
  const [user] = await db.select({ email: users.email, verified: users.emailVerified, role: users.role }).from(users).where(eq(users.id, userId));
  const signIn = user?.verified ? [user.email] : [];
  const emails = [...new Set([...(await knownEmails(db, userId)), ...signIn].map(normalizeEmail))].filter((e) => e !== "");
  const rows: TeacherCodespaceGrant[] =
    emails.length === 0
      ? []
      : await db
          .select({ enabled: teacherGrants.codespaceEnabled, maxActiveSessions: teacherGrants.codespaceMaxActiveSessions })
          .from(teacherGrants)
          .where(inArray(teacherGrants.email, emails));
  if (user?.role === "admin") rows.push({ enabled: true, maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS });
  if (rows.length === 0) return null;
  return {
    enabled: rows.some((r) => r.enabled),
    maxActiveSessions: Math.max(...rows.map((r) => r.maxActiveSessions)),
  };
}

/** The account holds an enabled workspace grant ({@link grantOf}): ADR-047 rule 4, what every workspace setting asks. */
export async function hasGrant(db: Db | Tx, userId: string): Promise<boolean> {
  return (await grantOf(db, userId))?.enabled === true;
}

// ---------------------------------------------------------------- the staff's view

/** The `codespace_projects` row of a project, or the empty one it would be, with the course image it picks (ADR-146 §4). */
async function portalState(db: Db, projectId: string) {
  const [row] = await db
    .select({
      syncedAt: codespaceProjects.syncedAt,
      syncError: codespaceProjects.syncError,
      firstLaunchAt: codespaceProjects.firstLaunchAt,
      imageId: courseWorkspaceImages.id,
      imageName: courseWorkspaceImages.name,
    })
    .from(codespaceProjects)
    .leftJoin(courseWorkspaceImages, eq(courseWorkspaceImages.id, codespaceProjects.imageId))
    .where(eq(codespaceProjects.projectId, projectId));
  return row ?? { syncedAt: null, syncError: null, firstLaunchAt: null, imageId: null, imageName: null };
}

/**
 * THE image a project's containers run, its sync's and its reviews'
 * (ADR-146 §4, §6; ADR-147 §6): the digest in service of the course image
 * the project picks, or null — the default — for a project with none and
 * for a `free` project, whose students never run one. Never a tag, never a
 * Refresh's candidate.
 */
async function projectImageOf(db: Db | Tx, project: { id: string; workMode: WorkMode }): Promise<string | null> {
  if (!isOnlineMode(project.workMode)) return null;
  const [row] = await db
    .select({ image: courseWorkspaceImages.digestReference })
    .from(codespaceProjects)
    .innerJoin(courseWorkspaceImages, eq(courseWorkspaceImages.id, codespaceProjects.imageId))
    .where(eq(codespaceProjects.projectId, project.id));
  return row?.image ?? null;
}

/**
 * `GET /app/api/projects/:id/workspace`: the mode, why the CALLER may not
 * change it now (`workModeRefusal`, the very rule `setWorkMode` applies:
 * the screen never offers what the server would refuse), the device level
 * and whether stations are offered to projects (`kioskProjectsOn`, one of
 * its two readers, ADR-089 amendment point 1), the last synchronization,
 * and the quota the setting warns against (ADR-089 amendment point 7): the
 * holder's `maxActiveSessions` beside the classroom's claimed student seats.
 */
export async function projectWorkspace(
  db: Db,
  config: Pick<AppConfig, "KIOSK_ATTESTATION" | "KIOSK_PROJECTS">,
  project: { id: string; classroomId: string; workMode: WorkMode; devices: DeviceLevel; groupMode: boolean; createdBy: string },
  courseId: string,
  caller: { userId: string; owner: boolean },
): Promise<ProjectWorkspace> {
  const state = await portalState(db, project.id);
  const granted = caller.owner && (await hasGrant(db, caller.userId));
  const kioskOffered = kioskProjectsOn(config);
  const facts = { owner: caller.owner, granted, launched: state.firstLaunchAt !== null, groupMode: project.groupMode, kioskOffered };
  const holder = await holderGrant(db, courseId, project.createdBy);
  const [claimed] = await db
    .select({ seats: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, project.classroomId), eq(enrollments.staff, false), isNotNull(enrollments.userId)));
  return {
    mode: project.workMode,
    devices: project.devices,
    kioskOffered,
    ...workModeChoices(facts, { mode: project.workMode, devices: project.devices }),
    syncedAt: state.syncedAt?.toISOString() ?? null,
    syncError: state.syncError,
    // A review session exists while the quota holder holds an enabled grant (ADR-129 §3).
    review: holder?.grant?.enabled === true,
    // The distribution's, for an owner only (ADR-147 §2): `isCourseOwner` is `requireCourseRole(owner)`'s rule.
    distributionReview: caller.owner && holder?.grant?.enabled === true,
    quota: holder?.grant ? { max: holder.grant.maxActiveSessions, seats: claimed?.seats ?? 0 } : null,
    image: state.imageId === null || state.imageName === null ? null : { id: state.imageId, name: state.imageName },
  };
}

// ---------------------------------------------------------------- tokens

/**
 * A student's launch token (ADR-047 §6): five minutes, a random `jti` the
 * portal consumes once. Returned with its `jti`, the only part of it that
 * is ever written down (the audit log); the token itself is a bearer
 * credential, never logged, stored nor audited.
 */
export function launchToken(
  config: AppConfig,
  claims: Omit<LaunchTokenClaims, "iss" | "aud" | "iat" | "exp" | "jti">,
  now: Date,
): Promise<{ token: string; jti: string }> {
  return sessionToken<LaunchTokenClaims>(config, LAUNCH_AUDIENCE, claims, now);
}

/**
 * The close of a kiosk station's sitting (ADR-089, amendment of 2026-11-15,
 * point 4): `POST <CODESPACE_URL>/api/sittings/close`, the bearer token
 * being the whole message — its own audience, two minutes, a fresh `jti`,
 * the `sitting` (the approving pairing's id) and its project while it
 * exists. The portal answers 204 to a close it applied and to a replay or an
 * unknown sitting alike, so a retry is always safe; any other answer, or no
 * answer, throws, for the caller's job to retry. Returns `"sent"` once the
 * portal answered 204, `"off"` without calling anything when the workspace
 * portal is off (`codespaceOn` false: no portal, so no session to close).
 * The token is never logged.
 */
export async function sendSittingClose(
  config: AppConfig,
  close: { sitting: string; projectId: string | null },
  now: Date,
): Promise<"sent" | "off"> {
  if (!codespaceOn(config)) return "off";
  const iat = Math.floor(now.getTime() / 1000);
  const claims: SittingCloseClaims = {
    iss: QUIZ_CODESPACE_ISSUER,
    aud: SITTING_CLOSE_AUDIENCE,
    iat,
    exp: iat + SERVICE_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
    sitting: close.sitting,
    projectId: close.projectId,
  };
  const token = await signHs256({ ...claims }, config.CODESPACE_LAUNCH_SECRET);
  const reply = await fetch(`${config.CODESPACE_URL}${SITTING_CLOSE_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
  });
  if (reply.status !== 204) throw new Error(`the portal answered ${reply.status} to the close of a sitting`);
  return "sent";
}

/**
 * THE signer of a token that opens a portal session — a student's launch or
 * a staff member's review (ADR-129 §7), each with its own audience: five
 * minutes, a random `jti`, over `CODESPACE_LAUNCH_SECRET`.
 */
async function sessionToken<C extends LaunchTokenClaims | ReviewLaunchTokenClaims>(
  config: AppConfig,
  aud: C["aud"],
  claims: Omit<C, "iss" | "aud" | "iat" | "exp" | "jti">,
  now: Date,
): Promise<{ token: string; jti: string }> {
  const iat = Math.floor(now.getTime() / 1000);
  const jti = randomUUID();
  const full = { ...claims, iss: QUIZ_CODESPACE_ISSUER, aud, iat, exp: iat + LAUNCH_TOKEN_TTL_SECONDS, jti };
  return { token: await signHs256(full, config.CODESPACE_LAUNCH_SECRET), jti };
}

// ---------------------------------------------------------------- the sync (Quiz → portal)

/**
 * The account that carries a project's quota (decision C) — its creator
 * while an owner, else the oldest owner seat; its address as the portal
 * names it (the id when it has none) — and that account's grant
 * ({@link grantOf}). Null for a course without an owner.
 */
export async function holderGrant(
  db: Db | Tx,
  courseId: string,
  createdBy: string,
): Promise<{ holder: { id: string; email: string }; grant: TeacherCodespaceGrant | null } | null> {
  const owners = await db
    .select({ userId: courseStaff.userId, createdAt: courseStaff.createdAt })
    .from(courseStaff)
    .where(and(eq(courseStaff.courseId, courseId), eq(courseStaff.role, "owner")));
  const id = quotaHolder(createdBy, owners);
  if (id === null) return null;
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id));
  if (!user) return null;
  return { holder: { id: user.id, email: user.email || user.id }, grant: await grantOf(db, user.id) };
}

/**
 * The body the portal expects for `projectId`, or null when there is
 * nothing to send: no such project, a project in the students' own tools,
 * or one whose distribution repository is not built yet (the publication
 * sends it again). `hybrid` is sent AS `online`, the portal's lab mode
 * (`portalMode`, ADR-149 §3). `online_seb` is sent like `online`, with no Browser
 * Exam Key: the Config Key alone (D21, M6-07; a BEK list waits for proof B
 * step 7, 06 §6.3). The workspace is seeded
 * from the distribution repository, never the source (N-SEC-20). A private
 * one seeds through the portal's `quiz` forge: Quiz grants it a read token
 * on that repository for an `online_seb` project (ADR-078, M6-10). Its
 * `deadlineAt` is `portalDeadline`'s: none for an `online` project under
 * the `commit` strategy (`hybrid` alike), whose start route decides student by student
 * (#958; ADR-078 as amended 2026-10-29). It carries the teacher's update of
 * an `online` or `hybrid` project ({@link workspaceUpdateOf}, ADR-132 §11), which the end
 * of every sync pass sends again. Its `image` is {@link projectImageOf}'s.
 * (While the portal has no image route, no image is ever admitted, so it
 * stays null.)
 */
export async function syncPayload(db: Db, projectId: string): Promise<CodespaceAssignmentSync | null> {
  const [row] = await db
    .select({ project: projects, classroomName: classrooms.name, courseId: classrooms.courseId })
    .from(projects)
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(eq(projects.id, projectId));
  if (!row) return null;
  const { project } = row;
  const mode = project.workMode;
  if (!isOnlineMode(mode) || project.distributionFullName === null) return null;
  const held = await holderGrant(db, row.courseId, project.createdBy);
  if (held === null) return null;
  const { holder, grant } = held;
  return CodespaceAssignmentSync.parse({
    id: project.id,
    slug: project.slug,
    name: project.name,
    classroomId: project.classroomId,
    classroomName: row.classroomName,
    mode: portalMode(mode),
    image: await projectImageOf(db, project),
    sourceRepo: { fullName: project.distributionFullName, defaultBranch: project.branches[0] ?? "main" },
    browserExamKeys: [],
    teacher: holder,
    quota: { maxActiveSessions: grant?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS },
    startAt: project.startAt.toISOString(),
    deadlineAt: portalDeadline(project)?.toISOString() ?? null,
    workspaceUpdate: workspaceUpdateOf(project),
    refreshOnOpen: hasTwoWritePaths(mode),
  });
}

/**
 * The update an `online` or `hybrid` project's workspaces offer to merge
 * (ADR-132 §11, ADR-149 §4; `isLabMode`): the heads its latest
 * sync handed out, on the handed-out branches, with that sync's message —
 * on a project its students can read only, as the message itself
 * (`requestSync`). `online_seb` waits for its own delivery (§11), `free`
 * has no workspace.
 */
export function workspaceUpdateOf(
  project: Pick<typeof projects.$inferSelect, "workMode" | "state" | "branches" | "syncHeads" | "syncMessage" | "syncMessageAt">,
): CodespaceWorkspaceUpdate | null {
  if (!isLabMode(project.workMode) || !projectIsVisible(project.state) || project.syncHeads === null) return null;
  // A branch the contract refuses (GitHub's default taken as it is, `développement`)
  // carries no update, rather than failing every assignment sync of the project.
  const heads = project.branches.flatMap((branch) => {
    const sha = project.syncHeads?.[branch];
    return sha && BranchName.safeParse(branch).success ? [{ branch, sha }] : [];
  });
  if (heads.length === 0) return null;
  const message =
    project.syncMessage === null || project.syncMessageAt === null
      ? null
      : { text: project.syncMessage, at: project.syncMessageAt.toISOString() };
  return { heads, message };
}

/**
 * Whether a repository's head `sha` came from the online workspace, THE one
 * read of it (ADR-078 §6, ADR-130 §6): `collection` when the deadline job
 * recorded it as a collection (its receipt, written before the ref moved),
 * `relayed` when the portal declared it before relaying it (a row of
 * `codespace_relays`) and it is none of the App's own commits
 * (`bot_commits`: a restore, a sync or a deadline commit is never the
 * student's, declared or not); null otherwise. Primary-key lookups
 * (N-SEC-17), the `github` and `project` modules' tables read by join. The
 * intake names a push's author by it (`pushAuthor`), the deadline's
 * collection weighs the last writer by it (ADR-149 §2).
 */
export async function workspaceHead(db: Db | Tx, githubRepoId: number, sha: string): Promise<"collection" | "relayed" | null> {
  const [collection] = await db
    .select({ id: pushReceipts.id })
    .from(pushReceipts)
    .where(and(eq(pushReceipts.githubRepoId, githubRepoId), eq(pushReceipts.headSha, sha), eq(pushReceipts.collected, true)))
    .limit(1);
  if (collection) return "collection";
  const ownCommit = db
    .select({ sha: botCommits.sha })
    .from(botCommits)
    .innerJoin(projectRepos, eq(projectRepos.id, botCommits.repoId))
    .where(and(eq(projectRepos.githubRepoId, githubRepoId), eq(botCommits.sha, sha)));
  const [declared] = await db
    .select({ sha: codespaceRelays.sha })
    .from(codespaceRelays)
    .where(and(eq(codespaceRelays.githubRepoId, githubRepoId), eq(codespaceRelays.sha, sha), notExists(ownCommit)))
    .limit(1);
  return declared ? "relayed" : null;
}

/** Writes the outcome of a sync attempt on the project's portal row. */
async function recordSync(db: Db, projectId: string, outcome: { at: Date } | { error: string }): Promise<void> {
  const set = "at" in outcome ? { syncedAt: outcome.at, syncError: null } : { syncError: outcome.error.slice(0, 500) };
  await db
    .insert(codespaceProjects)
    .values({ projectId, ...set })
    .onConflictDoUpdate({ target: codespaceProjects.projectId, set });
}

/**
 * The `codespace.sync` job: PUT the project to the portal, record the
 * outcome for the staff, and throw on failure so that the queue retries
 * with backoff (ADR-004; the portal's PUT is idempotent). A project with
 * nothing to send ({@link syncPayload}) is done at once. The service token
 * never leaves the request; the error kept names the status, never a header.
 */
export async function runCodespaceSync(
  app: Pick<FastifyInstance, "db" | "clock">,
  config: AppConfig,
  projectId: string,
  log: FastifyBaseLogger,
): Promise<"synced" | "skipped"> {
  if (!codespaceOn(config)) return "skipped";
  const db = app.db;
  const payload = await syncPayload(db, projectId);
  if (payload === null) return "skipped";
  const now = app.clock.now();
  let response: Response;
  try {
    response = await portalCall(config, now, "PUT", `/api/assignments/${encodeURIComponent(projectId)}`, payload);
  } catch (err) {
    const error = `portal unreachable: ${err instanceof Error ? err.message : String(err)}`;
    await recordSync(db, projectId, { error });
    throw new Error(error);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = `portal answered ${response.status}: ${body.slice(0, 200)}`;
    await recordSync(db, projectId, { error });
    throw new Error(error);
  }
  // The answer's Config Key and link were the portal's own `.seb`'s: Quiz builds every `.seb` now (D21), nothing to keep.
  const result = CodespaceAssignmentSyncResult.safeParse(await response.json().catch(() => null));
  if (!result.success) log.warn({ projectId }, "codespace.sync: the portal's answer is not a CodespaceAssignmentSyncResult");
  await recordSync(db, projectId, { at: now });
  await audit(db, {
    ...SYSTEM_ACTOR,
    action: "codespace.synced",
    subjectType: "project",
    subjectId: projectId,
    payload: { mode: payload.mode, quotaHolder: payload.teacher.id, maxActiveSessions: payload.quota.maxActiveSessions },
  });
  return "synced";
}

/**
 * Asks for a project's sync, after anything the portal reads of it
 * changed: its mode, name, dates, publication. Nothing when the feature is
 * off; a project the portal does not take ({@link syncPayload} null) is a
 * job that does nothing. Through the queue when there is one;
 * inline otherwise (`JOBS_DISABLED`), its failure recorded and swallowed:
 * the portal never fails a teacher's save.
 */
export async function requestCodespaceSync(
  app: Pick<FastifyInstance, "db" | "clock" | "boss" | "log">,
  config: AppConfig,
  projectId: string,
): Promise<void> {
  if (!codespaceOn(config)) return;
  if (app.boss) {
    await app.boss.send(CODESPACE_SYNC_QUEUE, { projectId });
    return;
  }
  try {
    await runCodespaceSync(app, config, projectId, app.log);
  } catch (err) {
    app.log.warn({ err, projectId }, "codespace.sync inline failed");
  }
}

// ---------------------------------------------------------------- the staff's view of the workspaces

const SessionList = z.array(CodespaceSessionSummary);

/**
 * `GET /app/api/projects/:id/workspace/sessions`: the portal's workspaces
 * of the project, each `userId` matched to the Quiz account of a claimed
 * seat of the project's classroom (the portal's word is not a reason to
 * name anybody else). A portal that cannot be asked, or answers what the
 * contract does not, is `reachable: false` — never an error page; a
 * project the portal never heard of has no workspace.
 */
export async function projectSessions(
  app: Pick<FastifyInstance, "db" | "clock" | "log">,
  config: AppConfig,
  project: { id: string; classroomId: string },
): Promise<ProjectWorkspaceSessions> {
  let listed: z.infer<typeof SessionList>;
  try {
    const response = await portalCall(config, app.clock.now(), "GET", `/api/assignments/${encodeURIComponent(project.id)}/sessions`);
    if (response.status === 404) return { reachable: true, sessions: [] };
    if (!response.ok) throw new Error(`portal answered ${response.status}`);
    listed = SessionList.parse(await response.json());
  } catch (err) {
    app.log.warn({ err: err instanceof Error ? err.message : String(err), projectId: project.id }, "codespace sessions unreadable");
    return { reachable: false, sessions: [] };
  }
  const ids = [...new Set(listed.map((s) => s.userId))].filter((id) => z.uuid().safeParse(id).success);
  const known =
    ids.length === 0
      ? []
      : await app.db
          .selectDistinct({ id: users.id, givenName: users.givenName, familyName: users.familyName })
          .from(users)
          .innerJoin(enrollments, and(eq(enrollments.userId, users.id), eq(enrollments.classroomId, project.classroomId)))
          .where(inArray(users.id, ids));
  const names = new Map(known.map((u) => [u.id, `${u.givenName} ${u.familyName}`.trim()]));
  return {
    reachable: true,
    // The portal's address of an account the classroom does not hold is not the staff's to read.
    sessions: listed.map(({ userId, email: _email, ...s }) => ({
      ...s,
      user: names.has(userId) ? { id: userId, name: names.get(userId)! } : null,
    })),
  };
}

// ---------------------------------------------------------------- Safe Exam Browser (D21, M6-07)

/**
 * The project a `seb` session may be opened for, the twin of `sebSeat`:
 * the project's student view (`findStudentProjectView`, read as the
 * caller's own portal would: published, not archived) with a claimed seat
 * of the caller's (a staff seat testing it included, ADR-077), in
 * `online_seb` at a level that accepts SEB — at Kiosk only none is served
 * (ADR-089 amendment point 2) —, open (`projectIsLive`: a scheduled project serves no `.seb`
 * and says nothing of its mode, ADR-127, N-SEC-20), of a classroom not archived — checked when the `.seb` is
 * downloaded and again when SEB trades its ticket, where the caller is the
 * ticket's user (`callerFor(user, null)`: no Super Powers). Null otherwise.
 */
export async function sebProjectSeat(db: Db, caller: Caller, projectId: string): Promise<{ id: string } | null> {
  const scope = await findStudentProjectView(db, caller, PORTAL, projectId);
  const ok =
    scope !== null &&
    scope.seat !== null &&
    projectIsLive(scope.project.state) &&
    deviceLevelClients(scope.project.devices).includes("seb") &&
    scope.room.archivedAt === null;
  return ok ? { id: scope.project.id } : null;
}

// ---------------------------------------------------------------- the start (student → portal)

/**
 * The session confined to this project a launch comes from (D21 point 4,
 * ADR-089 §4), null from the student's portal session: a `seb` one with the
 * Config Key it was launched with — the token's `seb` claim, which the
 * portal checks SEB's header against —, or a kiosk station's with its
 * device and its sitting (the approving pairing's id) — the `kiosk` claim.
 */
export type LaunchVia =
  | { kind: "seb"; configKey: string }
  | { kind: "kiosk"; deviceId: string; sitting: string }
  | null;

/** Who launches, as the start route loaded them. */
export interface Launcher {
  user: { id: string; email: string; givenName: string; familyName: string };
  /** A staff seat (ADR-077): a teacher testing their project; their launch does not freeze the mode. */
  staffSeat: boolean;
  classroomArchived: boolean;
  actor: AuditActor;
  via: LaunchVia;
}

/**
 * The start route's work (ADR-047 §6), in one transaction: the project
 * under a share lock — a change of its mode waits for this launch, then
 * finds it frozen —, the student's own repository (online modes are
 * individual), the decision of `workspaceStartRefusal`; then the first
 * launch marked (never by a staff seat: a teacher testing the project does
 * not freeze its mode), a launch token minted — with the claim of the
 * trusted client it comes from ({@link LaunchVia}) — and its `jti` audited
 * (`codespace.launch_issued`; the token never). Null: no such project.
 */
export async function startWorkspace(
  db: Db,
  config: AppConfig,
  projectId: string,
  who: Launcher,
  now: Date,
): Promise<{ token: string; jti: string } | WorkspaceStartRefusal | null> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("share");
    if (!project) return null;
    const [repo] = await tx
      .select()
      .from(projectRepos)
      .where(and(eq(projectRepos.projectId, project.id), eq(projectRepos.userId, who.user.id), isNull(projectRepos.groupId)));
    const { via } = who;
    const refusal = workspaceStartRefusal(
      { project, repo: repo ?? null, classroomArchived: who.classroomArchived, via: via?.kind ?? null },
      now,
    );
    if (refusal) return refusal;
    const [account] = await tx.select({ login: githubAccounts.login }).from(githubAccounts).where(eq(githubAccounts.userId, who.user.id));
    if (!who.staffSeat) await markLaunched(tx, project.id, now);
    // Every launch, a staff seat's too: the git relay's token route reads it (ADR-078 §6).
    await recordLaunch(tx, project.id, who.user.id, now);
    const { user } = who;
    const issued = await launchToken(
      config,
      {
        sub: user.id,
        email: user.email,
        displayName: `${user.givenName} ${user.familyName}`.trim() || user.email,
        githubLogin: account?.login ?? null,
        assignmentId: project.id,
        repo: { fullName: repo!.fullName!, defaultBranch: repo!.defaultBranch ?? project.branches[0] ?? "main" },
        ...(via?.kind === "seb" && { seb: { configKey: via.configKey } }),
        ...(via?.kind === "kiosk" && { kiosk: { deviceId: via.deviceId, sitting: via.sitting } }),
      },
      now,
    );
    // The `jti` links Quiz's log to the portal's; the token itself never enters a log (AU-41).
    await audit(tx, {
      ...who.actor,
      action: "codespace.launch_issued",
      subjectType: "project",
      subjectId: project.id,
      payload: { jti: issued.jti, mode: project.workMode, ...(via && { [via.kind]: true }) },
    });
    return issued;
  });
}

// ---------------------------------------------------------------- the staff's review (ADR-129, ADR-147)

/** A project, as the review routes read it: their loaders' row, and the token route's. */
export interface ReviewedProject {
  project: typeof projects.$inferSelect;
  courseId: string;
  classroomArchivedAt: Date | null;
}

/**
 * What a review session opens: one repository of the project (ADR-129), or
 * the project's distribution repository (ADR-147 §4), which has no
 * `project_repos` row.
 */
export type ReviewTarget = { kind: "repo"; repo: typeof projectRepos.$inferSelect } | { kind: "distribution" };

/** Why a review is refused: the repository's rule or the distribution's. */
export type ReviewRefusal = StaffReviewRefusal | DistributionReviewRefusal;

/**
 * THE one place the facts of a review's rule are built, for the launch and
 * for the token route (ADR-129 §5, §7; ADR-147 §3, §5): the row's archives,
 * the quota holder's grant read now, and the target's own facts — the
 * repository and the mode (`staffReviewRefusal`), or the stored
 * distribution (`distributionReviewRefusal`). Granted: the target's name
 * and GitHub id, the holder and their grant.
 */
export async function reviewDecision(
  db: Db | Tx,
  row: ReviewedProject,
  target: ReviewTarget,
): Promise<
  | { refusal: ReviewRefusal }
  | { refusal: null; fullName: string; githubRepoId: number; holder: { id: string; email: string }; grant: TeacherCodespaceGrant }
> {
  const { project } = row;
  const held = await holderGrant(db, row.courseId, project.createdBy);
  const gate = { holderGranted: held?.grant?.enabled === true, classroomArchived: row.classroomArchivedAt !== null, projectArchived: project.archivedAt !== null };
  const [fullName, githubRepoId] =
    target.kind === "repo" ? [target.repo.fullName, target.repo.githubRepoId] : [project.distributionFullName, project.distributionRepoId];
  const refusal =
    target.kind === "repo"
      ? staffReviewRefusal({ ...gate, repo: target.repo, workMode: project.workMode })
      : distributionReviewRefusal({ ...gate, distributionBuilt: fullName !== null && githubRepoId !== null });
  if (refusal !== null) return { refusal };
  // Granted and live, by the rule above; the test only tells the compiler so.
  if (!held?.grant || fullName === null || githubRepoId === null) {
    return { refusal: target.kind === "repo" ? "review_repo_unavailable" : "review_distribution_missing" };
  }
  return { refusal: null, fullName, githubRepoId, holder: held.holder, grant: held.grant };
}

/**
 * A review route's work on what its loader read — a repository
 * (`findAccessibleProjectRepo`, ADR-129 §5) or, for an owner, the project's
 * distribution (`accessibleProject` then `requireCourseRole(owner)`,
 * ADR-147 §4): {@link reviewDecision}; then the launch recorded
 * (`codespace_reviews`, a null repository for the distribution, its window
 * `REVIEW_GRANT_MINUTES` from the database's clock, ADR-129 §6), a review
 * launch token signed (§7) with the target, its branch and the project's
 * image, and audited by its `jti` (`codespace.review_launched` or
 * `codespace.distribution_review_launched`) — the token never. It never
 * marks the project launched, never writes `codespace_launches` and never
 * asks for a sync: a review freezes no mode and opens nothing to students,
 * in any state of the project, a draft included.
 *
 * The holder's grant is read in the transaction that records the launch;
 * the row's own facts (archives, target, mode) are the loader's read, just
 * before it. That is safe: the launch grants nothing by itself — the token
 * route applies the same decision again, on facts it reads at its own
 * request (§7, check 4), so a change between the two reads is refused there.
 */
export async function startReview(
  db: Db,
  config: AppConfig,
  row: ReviewedProject,
  target: ReviewTarget,
  who: { user: Reviewer; reach: Reach; actor: AuditActor },
  now: Date,
): Promise<{ token: string; jti: string } | ReviewRefusal> {
  return db.transaction(async (tx) => {
    const { project } = row;
    const decision = await reviewDecision(tx, row, target);
    if (decision.refusal !== null) return decision.refusal;
    const projectRepoId = target.kind === "repo" ? target.repo.id : null;
    await tx
      .insert(codespaceReviews)
      .values({ id: randomUUID(), userId: who.user.id, projectId: project.id, projectRepoId, grantUntil: sql`now() + make_interval(mins => ${REVIEW_GRANT_MINUTES})` })
      .onConflictDoUpdate({
        target: [codespaceReviews.userId, codespaceReviews.projectId, codespaceReviews.projectRepoId],
        set: { grantUntil: sql`excluded.grant_until` },
      });
    const defaultBranch = (target.kind === "repo" ? target.repo.defaultBranch : null) ?? project.branches[0] ?? "main";
    const image = await projectImageOf(tx, project);
    const [account] = await tx.select({ login: githubAccounts.login }).from(githubAccounts).where(eq(githubAccounts.userId, who.user.id));
    const { user } = who;
    const issued = await sessionToken<ReviewLaunchTokenClaims>(
      config,
      REVIEW_AUDIENCE,
      {
        sub: user.id,
        email: user.email,
        displayName: `${user.givenName} ${user.familyName}`.trim() || user.email,
        githubLogin: account?.login ?? null,
        repo: { fullName: decision.fullName, defaultBranch },
        projectId: project.id,
        projectRepoId,
        holder: decision.holder,
        maxActiveSessions: decision.grant.maxActiveSessions,
        image,
      },
      now,
    );
    const payload = { repository: decision.fullName, jti: issued.jti, reach: who.reach, image };
    await audit(tx, {
      ...who.actor,
      subjectType: "project",
      subjectId: project.id,
      ...(projectRepoId === null
        ? { action: "codespace.distribution_review_launched", payload }
        : { action: "codespace.review_launched", payload: { projectRepoId, ...payload } }),
    });
    return issued;
  });
}

type Reviewer = { id: string; email: string; givenName: string; familyName: string };

// ---------------------------------------------------------------- the launch mark

/**
 * Marks the project's first launch, once and for good, in the start
 * route's transaction (it freezes the mode, ADR-047 §3 as amended).
 */
export async function markLaunched(tx: Tx, projectId: string, now: Date): Promise<void> {
  await tx
    .insert(codespaceProjects)
    .values({ projectId, firstLaunchAt: now })
    .onConflictDoUpdate({
      target: codespaceProjects.projectId,
      set: { firstLaunchAt: sql`coalesce(${codespaceProjects.firstLaunchAt}, ${now.toISOString()}::timestamptz)` },
    });
}

/** Records a launch token issued to `userId` on the project (`codespace_launches`, ADR-078 §6): the first kept, the last moved. */
async function recordLaunch(tx: Tx, projectId: string, userId: string, now: Date): Promise<void> {
  await tx
    .insert(codespaceLaunches)
    .values({ projectId, userId, firstLaunchAt: now, lastLaunchAt: now })
    .onConflictDoUpdate({ target: [codespaceLaunches.projectId, codespaceLaunches.userId], set: { lastLaunchAt: now } });
}

// ---------------------------------------------------------------- the collection at the deadline (ADR-130)

/** The order to the portal and its record, for the deadline job (`project/collection.ts`) and the staff's rows. */
export {
  claimCollection,
  lastCollections,
  orderCollection,
  recordCollectionCommit,
  settleCollection,
  COLLECTION_UNSETTLED,
  unsettledCollections,
  type CollectionSettlement,
} from "./collect.js";
