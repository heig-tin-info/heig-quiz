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
 *     ({@link startReview}, ADR-129), its own audience.
 *
 * Off — `CODESPACE_URL` empty — the module registers nothing (every route a
 * 404) and {@link requestCodespaceSync} does nothing.
 *
 * It owns `codespace_projects` (`db/codespace.ts`) and reads the projects,
 * the course's staff and the grants by join; a project's `work_mode` is
 * written by the `project` module (`setWorkMode`).
 */
import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  CodespaceAssignmentSync,
  CodespaceAssignmentSyncResult,
  CodespaceSessionSummary,
  DEFAULT_MAX_ACTIVE_SESSIONS,
  LAUNCH_AUDIENCE,
  LAUNCH_TOKEN_TTL_SECONDS,
  QUIZ_CODESPACE_ISSUER,
  REVIEW_AUDIENCE,
  REVIEW_GRANT_MINUTES,
  SERVICE_AUDIENCE,
  SERVICE_TOKEN_TTL_SECONDS,
  type LaunchTokenClaims,
  type ReviewLaunchTokenClaims,
  type StaffReviewRefusal,
  type DeviceLevel,
  type WorkMode,
  type WorkspaceStartRefusal,
  type ProjectWorkspace,
  type ProjectWorkspaceSessions,
  type ServiceTokenClaims,
  type TeacherCodespaceGrant,
} from "@quiz/contracts";
import {
  isOnlineMode,
  portalDeadline,
  projectIsLive,
  deviceLevelClients,
  quotaHolder,
  requestBinding,
  signHs256,
  staffReviewRefusal,
  workModeChoices,
  workspaceStartRefusal,
} from "@quiz/domain";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import { kioskProjectsOn, type AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, codespaceLaunches, codespaceProjects, codespaceReviews, courseStaff, enrollments, githubAccounts, projectRepos, projects, teacherGrants, users } from "../../db/schema.js";
import { knownEmails, normalizeEmail } from "../../identity.js";
import { CODESPACE_SYNC_QUEUE } from "../../jobs.js";
import { PORTAL } from "../../auth/session.js";
import { findStudentProjectView, type Caller, type Reach } from "../guards.js";

/** The portal is wired up at all: an empty `CODESPACE_URL` means the feature does not exist (ADR-047 §5). */
export function codespaceOn(config: Pick<AppConfig, "CODESPACE_URL">): boolean {
  return config.CODESPACE_URL !== "";
}

/** A portal call never holds a request or a job for long. */
const PORTAL_TIMEOUT_MS = 10_000;

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
 * amendment of 2026-10-08): their address cannot hold a row.
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

// ---------------------------------------------------------------- the staff's view

/** The `codespace_projects` row of a project, or the empty one it would be. */
async function portalState(db: Db, projectId: string) {
  const [row] = await db.select().from(codespaceProjects).where(eq(codespaceProjects.projectId, projectId));
  return row ?? { syncedAt: null, syncError: null, firstLaunchAt: null };
}

/**
 * `GET /app/api/projects/:id/workspace`: the mode, why the CALLER may not
 * change it now (`workModeRefusal`, the very rule `setWorkMode` applies:
 * the screen never offers what the server would refuse), the device level
 * and whether stations are offered to projects (`kioskProjectsOn`, one of
 * its two readers, ADR-089 amendment point 1), and the last
 * synchronization.
 */
export async function projectWorkspace(
  db: Db,
  config: Pick<AppConfig, "KIOSK_ATTESTATION" | "KIOSK_PROJECTS">,
  project: { id: string; workMode: WorkMode; devices: DeviceLevel; groupMode: boolean; createdBy: string },
  courseId: string,
  caller: { userId: string; owner: boolean },
): Promise<ProjectWorkspace> {
  const state = await portalState(db, project.id);
  const granted = caller.owner && (await grantOf(db, caller.userId))?.enabled === true;
  const kioskOffered = kioskProjectsOn(config);
  const facts = { owner: caller.owner, granted, launched: state.firstLaunchAt !== null, groupMode: project.groupMode, kioskOffered };
  return {
    mode: project.workMode,
    devices: project.devices,
    kioskOffered,
    ...workModeChoices(facts, { mode: project.workMode, devices: project.devices }),
    syncedAt: state.syncedAt?.toISOString() ?? null,
    syncError: state.syncError,
    // A review session exists while the quota holder holds an enabled grant (ADR-129 §3).
    review: (await holderGrant(db, courseId, project.createdBy))?.grant?.enabled === true,
  };
}

// ---------------------------------------------------------------- tokens

/**
 * A server-to-server call to the portal. Its bearer is a two-minute
 * service token bound to THIS request — method, path and query, the SHA-256
 * of the exact body sent — with a fresh `jti` the portal consumes once
 * (audit L25, ADR-078 amendment of 2026-10-11): a token seen in transit is
 * worth neither a second call nor another route or body.
 */
async function portalCall(
  config: AppConfig,
  now: Date,
  method: "GET" | "PUT",
  path: string,
  payload?: unknown,
): Promise<Response> {
  const url = new URL(`${config.CODESPACE_URL}${path}`);
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const iat = Math.floor(now.getTime() / 1000);
  const claims: ServiceTokenClaims = {
    iss: QUIZ_CODESPACE_ISSUER,
    aud: SERVICE_AUDIENCE,
    iat,
    exp: iat + SERVICE_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
    ...(await requestBinding(method, url.pathname + url.search, body)),
    method,
  };
  const token = await signHs256({ ...claims }, config.CODESPACE_LAUNCH_SECRET);
  return fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
  });
}

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
 * sends it again). `online_seb` is sent like `online`, with no Browser
 * Exam Key: the Config Key alone (D21, M6-07; a BEK list waits for proof B
 * step 7, 06 §6.3). The workspace is seeded
 * from the distribution repository, never the source (N-SEC-20). A private
 * one seeds through the portal's `quiz` forge: Quiz grants it a read token
 * on that repository for an `online_seb` project (ADR-078, M6-10). Its
 * `deadlineAt` is `portalDeadline`'s: none for an `online` project under
 * the `commit` strategy, whose start route decides student by student
 * (#958; ADR-078 as amended 2026-10-29).
 */
export async function syncPayload(db: Db, projectId: string): Promise<CodespaceAssignmentSync | null> {
  const [row] = await db
    .select({ project: projects, classroomName: classrooms.name, courseId: classrooms.courseId })
    .from(projects)
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(eq(projects.id, projectId));
  if (!row || !isOnlineMode(row.project.workMode) || row.project.distributionFullName === null) return null;
  const { project } = row;
  const held = await holderGrant(db, row.courseId, project.createdBy);
  if (held === null) return null;
  const { holder, grant } = held;
  return CodespaceAssignmentSync.parse({
    id: project.id,
    slug: project.slug,
    name: project.name,
    classroomId: project.classroomId,
    classroomName: row.classroomName,
    mode: project.workMode,
    image: null,
    sourceRepo: { fullName: project.distributionFullName, defaultBranch: project.branches[0] ?? "main" },
    browserExamKeys: [],
    teacher: holder,
    quota: { maxActiveSessions: grant?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS },
    startAt: project.startAt.toISOString(),
    deadlineAt: portalDeadline(project)?.toISOString() ?? null,
  });
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

// ---------------------------------------------------------------- the staff's review (ADR-129)

/** A repository of a project, as both review routes read it: `findAccessibleProjectRepo`'s row, and the token route's. */
export interface ReviewedRepo {
  project: typeof projects.$inferSelect;
  repo: typeof projectRepos.$inferSelect;
  courseId: string;
  classroomArchivedAt: Date | null;
}

/**
 * THE one place the facts of `staffReviewRefusal` (ADR-129 §5) are built,
 * for the launch and for the token route (§7): the row's archives, its
 * repository, its mode, and the quota holder's grant read now. Granted: the
 * live repository's name and GitHub id, the holder and their grant.
 */
export async function reviewDecision(
  db: Db | Tx,
  row: ReviewedRepo,
): Promise<
  | { refusal: StaffReviewRefusal }
  | { refusal: null; fullName: string; githubRepoId: number; holder: { id: string; email: string }; grant: TeacherCodespaceGrant }
> {
  const { project, repo } = row;
  const held = await holderGrant(db, row.courseId, project.createdBy);
  const refusal = staffReviewRefusal({
    holderGranted: held?.grant?.enabled === true,
    classroomArchived: row.classroomArchivedAt !== null,
    projectArchived: project.archivedAt !== null,
    repo,
    workMode: project.workMode,
  });
  if (refusal !== null) return { refusal };
  // Granted and live, by the rule above; the test only tells the compiler so.
  if (!held?.grant || repo.fullName === null || repo.githubRepoId === null) return { refusal: "review_repo_unavailable" };
  return { refusal: null, fullName: repo.fullName, githubRepoId: repo.githubRepoId, holder: held.holder, grant: held.grant };
}

/**
 * The review route's work (ADR-129 §5) on the repository its loader read
 * (`findAccessibleProjectRepo`): {@link reviewDecision}; then the launch
 * recorded (`codespace_reviews`, its window `REVIEW_GRANT_MINUTES` from the
 * database's clock, §6), a review launch token signed (§7) and audited
 * `codespace.review_launched` by its `jti` (§8) — the token never. It never
 * marks the project launched, never writes `codespace_launches` and never
 * asks for a sync: a review freezes no mode and opens nothing to students.
 *
 * The holder's grant is read in the transaction that records the launch;
 * the row's own facts (archives, repository, mode) are the loader's read,
 * just before it. That is safe: the launch grants nothing by itself — the
 * token route applies the same decision again, on facts it reads at its own
 * request (§7, check 4), so a change between the two reads is refused there.
 */
export async function startReview(
  db: Db,
  config: AppConfig,
  row: ReviewedRepo,
  who: { user: { id: string; email: string; givenName: string; familyName: string }; reach: Reach; actor: AuditActor },
  now: Date,
): Promise<{ token: string; jti: string } | StaffReviewRefusal> {
  return db.transaction(async (tx) => {
    const { project, repo } = row;
    const decision = await reviewDecision(tx, row);
    if (decision.refusal !== null) return decision.refusal;
    await tx
      .insert(codespaceReviews)
      .values({ userId: who.user.id, projectRepoId: repo.id, grantUntil: sql`now() + make_interval(mins => ${REVIEW_GRANT_MINUTES})` })
      .onConflictDoUpdate({ target: [codespaceReviews.userId, codespaceReviews.projectRepoId], set: { grantUntil: sql`excluded.grant_until` } });
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
        repo: { fullName: decision.fullName, defaultBranch: repo.defaultBranch ?? project.branches[0] ?? "main" },
        projectId: project.id,
        projectRepoId: repo.id,
        holder: decision.holder,
        maxActiveSessions: decision.grant.maxActiveSessions,
      },
      now,
    );
    await audit(tx, {
      ...who.actor,
      action: "codespace.review_launched",
      subjectType: "project",
      subjectId: project.id,
      payload: { projectRepoId: repo.id, repository: decision.fullName, jti: issued.jti, reach: who.reach },
    });
    return issued;
  });
}

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
