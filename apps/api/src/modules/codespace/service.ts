/**
 * The `codespace` module (ADR-047 as amended 2026-10-07, merge task M6-06):
 * what Quiz says to the online workspace portal (`apps/codespace`), and
 * the entry other modules import. The two applications never import each
 * other: they exchange the two HS256-signed messages of
 * `@quiz/contracts`' `codespace.ts`, signed with `CODESPACE_LAUNCH_SECRET`
 * (environment only, ADR-010) by `signHs256` of `@quiz/domain`.
 *
 *   - Quiz → portal: the project (`PUT /api/assignments/:id`, a 2-minute
 *     service token), sent by the `codespace.sync` job ({@link requestCodespaceSync})
 *     so that a portal restarting never fails a teacher's save; and the
 *     staff's read of its workspaces (`GET /api/assignments/:id/sessions`).
 *   - student → portal: a 5-minute single-use launch token, minted by the
 *     start route (`routes.ts`, {@link launchToken}) and carried in a 303.
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
  SERVICE_AUDIENCE,
  SERVICE_TOKEN_TTL_SECONDS,
  WORK_MODES,
  type LaunchTokenClaims,
  type WorkMode,
  type WorkspaceStartRefusal,
  type ProjectWorkspace,
  type ProjectWorkspaceSessions,
  type ServiceTokenClaims,
  type TeacherCodespaceGrant,
} from "@quiz/contracts";
import { isOnlineMode, quotaHolder, signHs256, workModeRefusal, workspaceStartRefusal } from "@quiz/domain";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, codespaceProjects, courseStaff, enrollments, githubAccounts, projectRepos, projects, teacherGrants, users } from "../../db/schema.js";
import { knownEmails, normalizeEmail } from "../../identity.js";
import { CODESPACE_SYNC_QUEUE } from "../../jobs.js";
import { publishedProject } from "../guards.js";

/** The portal is wired up at all: an empty `CODESPACE_URL` means the feature does not exist (ADR-047 §5). */
export function codespaceOn(config: Pick<AppConfig, "CODESPACE_URL">): boolean {
  return config.CODESPACE_URL !== "";
}

/** A portal call never holds a request or a job for long. */
const PORTAL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------- grants (ADR-047 §4)

/**
 * The workspace grant of an account: the `teacher_grants` rows of any of its
 * VERIFIED addresses — its verified ones (`knownEmails`, GH-11, as the role
 * rule reads them) and its sign-in address when the identity provider
 * verified it — the most permissive winning, as the role rule does. Null without a row: no grant, the
 * default quota. The administrator holds no row (their address cannot be
 * granted), so they are not granted either: an administrator acts on a
 * course as its owner (ADR-054), never past the grant.
 */
export async function grantOf(db: Db | Tx, userId: string): Promise<TeacherCodespaceGrant | null> {
  const [user] = await db.select({ email: users.email, verified: users.emailVerified }).from(users).where(eq(users.id, userId));
  const signIn = user?.verified ? [user.email] : [];
  const emails = [...new Set([...(await knownEmails(db, userId)), ...signIn].map(normalizeEmail))].filter((e) => e !== "");
  if (emails.length === 0) return null;
  const rows = await db
    .select({ enabled: teacherGrants.codespaceEnabled, maxActiveSessions: teacherGrants.codespaceMaxActiveSessions })
    .from(teacherGrants)
    .where(inArray(teacherGrants.email, emails));
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
  return row ?? { syncedAt: null, syncError: null, firstLaunchAt: null, browserExamKeys: [] };
}

/**
 * `GET /app/api/projects/:id/workspace`: the mode, why the CALLER may not
 * change it now (`workModeRefusal`, the very rule `setWorkMode` applies:
 * the screen never offers what the server would refuse), and the last
 * synchronization.
 */
export async function projectWorkspace(
  db: Db,
  project: { id: string; workMode: WorkMode; groupMode: boolean },
  caller: { userId: string; owner: boolean },
): Promise<ProjectWorkspace> {
  const state = await portalState(db, project.id);
  const granted = caller.owner && (await grantOf(db, caller.userId))?.enabled === true;
  const facts = { owner: caller.owner, granted, launched: state.firstLaunchAt !== null, groupMode: project.groupMode };
  const judged = WORK_MODES.map((to) => ({ to, refusal: workModeRefusal(facts, project.workMode, to) }));
  return {
    mode: project.workMode,
    allowed: judged.filter((j) => j.refusal === null).map((j) => j.to),
    refusal: judged.find((j) => j.refusal !== null)?.refusal ?? null,
    syncedAt: state.syncedAt?.toISOString() ?? null,
    syncError: state.syncError,
    browserExamKeys: state.browserExamKeys,
  };
}

/**
 * `PUT /app/api/projects/:id/workspace/keys`: the Browser Exam Keys the
 * portal accepts for the project (D21 point 5), the whole list replaced;
 * audited by their count, never a key (ADR-047 §7). The caller syncs.
 */
export async function setBrowserExamKeys(db: Db, projectId: string, keys: string[], actor: AuditActor): Promise<void> {
  await db
    .insert(codespaceProjects)
    .values({ projectId, browserExamKeys: keys })
    .onConflictDoUpdate({ target: codespaceProjects.projectId, set: { browserExamKeys: keys } });
  await audit(db, { ...actor, action: "codespace.browser_exam_keys", subjectType: "project", subjectId: projectId, payload: { count: keys.length } });
}

// ---------------------------------------------------------------- tokens

/** Bearer of a server-to-server call to the portal: two minutes. */
export async function serviceToken(config: AppConfig, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: ServiceTokenClaims = { iss: QUIZ_CODESPACE_ISSUER, aud: SERVICE_AUDIENCE, iat, exp: iat + SERVICE_TOKEN_TTL_SECONDS };
  return signHs256({ ...claims }, config.CODESPACE_LAUNCH_SECRET);
}

/**
 * A student's launch token (ADR-047 §6): five minutes, a random `jti` the
 * portal consumes once. Returned with its `jti`, the only part of it that
 * is ever written down (the audit log); the token itself is a bearer
 * credential, never logged, stored nor audited.
 */
export async function launchToken(
  config: AppConfig,
  claims: Omit<LaunchTokenClaims, "iss" | "aud" | "iat" | "exp" | "jti">,
  now: Date,
): Promise<{ token: string; jti: string }> {
  const iat = Math.floor(now.getTime() / 1000);
  const jti = randomUUID();
  const full: LaunchTokenClaims = {
    ...claims,
    iss: QUIZ_CODESPACE_ISSUER,
    aud: LAUNCH_AUDIENCE,
    iat,
    exp: iat + LAUNCH_TOKEN_TTL_SECONDS,
    jti,
  };
  return { token: await signHs256({ ...full }, config.CODESPACE_LAUNCH_SECRET), jti };
}

// ---------------------------------------------------------------- the sync (Quiz → portal)

/** The account that carries a project's quota (decision C): its creator while an owner, else the oldest owner seat. */
async function quotaHolderOf(db: Db, courseId: string, createdBy: string): Promise<{ id: string; email: string } | null> {
  const owners = await db
    .select({ userId: courseStaff.userId, createdAt: courseStaff.createdAt })
    .from(courseStaff)
    .where(and(eq(courseStaff.courseId, courseId), eq(courseStaff.role, "owner")));
  const id = quotaHolder(createdBy, owners);
  if (id === null) return null;
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id));
  return user ?? null;
}

/**
 * The body the portal expects for `projectId`, or null when there is
 * nothing to send: no such project, a project in the students' own tools,
 * or one whose distribution repository is not built yet (the publication
 * sends it again). An `online_seb` project carries its Browser Exam Keys,
 * none meaning the Config Key alone (D21, M6-07). The workspace is seeded
 * from the distribution repository, never the source (N-SEC-20). With the
 * portal's forge off (ADR-047, M6-03 amendment (a)) it can clone only a
 * PUBLIC repository: a private distribution syncs, but cannot seed a
 * workspace until Quiz's App is on the engine VM (M6-04/05).
 */
export async function syncPayload(db: Db, projectId: string): Promise<CodespaceAssignmentSync | null> {
  const [row] = await db
    .select({ project: projects, classroomName: classrooms.name, courseId: classrooms.courseId })
    .from(projects)
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(eq(projects.id, projectId));
  if (!row || !isOnlineMode(row.project.workMode) || row.project.distributionFullName === null) return null;
  const { project } = row;
  const { browserExamKeys } = await portalState(db, project.id);
  const holder = await quotaHolderOf(db, row.courseId, project.createdBy);
  if (holder === null) return null;
  const grant = await grantOf(db, holder.id);
  return CodespaceAssignmentSync.parse({
    id: project.id,
    slug: project.slug,
    name: project.name,
    classroomId: project.classroomId,
    classroomName: row.classroomName,
    mode: project.workMode,
    image: null,
    sourceRepo: { fullName: project.distributionFullName, defaultBranch: project.branches[0] ?? "main" },
    browserExamKeys: project.workMode === "online_seb" ? browserExamKeys : [],
    teacher: { id: holder.id, email: holder.email || holder.id },
    quota: { maxActiveSessions: grant?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS },
    startAt: project.startAt.toISOString(),
    deadlineAt: project.deadlineAt.toISOString(),
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
    response = await fetch(`${config.CODESPACE_URL}/api/assignments/${encodeURIComponent(projectId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${await serviceToken(config, now)}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
    });
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
    const response = await fetch(`${config.CODESPACE_URL}/api/assignments/${encodeURIComponent(project.id)}/sessions`, {
      headers: { authorization: `Bearer ${await serviceToken(config, app.clock.now())}` },
      signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
    });
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
 * published (not archived), in `online_seb`, of a classroom not archived,
 * where `userId` holds a claimed seat (a staff seat testing it included,
 * ADR-077) — checked when the `.seb` is downloaded and again when SEB
 * trades its ticket. Null otherwise, and when the feature is off (the
 * module's routes do not exist then).
 */
export async function sebProjectSeat(db: Db, userId: string, projectId: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(classrooms, and(eq(classrooms.id, projects.classroomId), isNull(classrooms.archivedAt)))
    .innerJoin(enrollments, and(eq(enrollments.classroomId, projects.classroomId), eq(enrollments.userId, userId)))
    .where(and(eq(projects.id, projectId), eq(projects.workMode, "online_seb"), publishedProject()))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------- the start (student → portal)

/** Who launches, as the start route loaded them. */
export interface Launcher {
  user: { id: string; email: string; givenName: string; familyName: string };
  /** A staff seat (ADR-077): a teacher testing their project; their launch does not freeze the mode. */
  staffSeat: boolean;
  classroomArchived: boolean;
  actor: AuditActor;
  /**
   * The Config Key of the `seb` session confined to this project the launch
   * comes from (D21 point 4), null from a portal session. It travels in the
   * token's `seb` claim: the portal checks SEB's header against it.
   */
  sebConfigKey: string | null;
}

/**
 * The start route's work (ADR-047 §6), in one transaction: the project
 * under a share lock — a change of its mode waits for this launch, then
 * finds it frozen —, the student's own repository (online modes are
 * individual), the decision of `workspaceStartRefusal`; then the first
 * launch marked (never by a staff seat: a teacher testing the project does
 * not freeze its mode), a launch token minted — with this student's Config
 * Key from a `seb` session — and its `jti` audited
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
    const fromSeb = who.sebConfigKey !== null;
    const refusal = workspaceStartRefusal({ project, repo: repo ?? null, classroomArchived: who.classroomArchived, fromSeb }, now);
    if (refusal) return refusal;
    const [account] = await tx.select({ login: githubAccounts.login }).from(githubAccounts).where(eq(githubAccounts.userId, who.user.id));
    if (!who.staffSeat) await markLaunched(tx, project.id, now);
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
        ...(fromSeb && { seb: { configKey: who.sebConfigKey! } }),
      },
      now,
    );
    // The `jti` links Quiz's log to the portal's; the token itself never enters a log (AU-41).
    await audit(tx, {
      ...who.actor,
      action: "codespace.launch_issued",
      subjectType: "project",
      subjectId: project.id,
      payload: { jti: issued.jti, mode: project.workMode, ...(fromSeb && { seb: true }) },
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
