/**
 * The staff's review session, Quiz's side (ADR-129), over the real
 * application with Quiz's App against the fake GitHub and the local bare
 * repositories, the portal a stub. The test clock is the wall clock: the
 * review window and the Super Powers are read on the database's (`now()`).
 *
 * - `POST /app/api/projects/:id/repos/:rid/workspace/review` (§5): the
 *   refusal matrix — no session, impersonation, a confined session, a
 *   token of either scope, a stranger, an admin without Super Powers, a
 *   repository of another project; the holder ungranted, an archived
 *   classroom or project, a repository not live, an exam not yet applied —
 *   and the launch by an assistant, an owner, an admin with Super Powers, on
 *   a student's, a group's and a staff test repository: a review token the
 *   portal verifies on its own audience, recorded for 15 minutes, audited
 *   without the token, and never a launch, a frozen mode nor a sync;
 * - `POST /app/codespace/git-token` with `reviewRepoId` (§7): read only,
 *   within the window, while the access holds (seat, Super Powers), on the
 *   recorded repository of the request's project; the token in no log line
 *   and no audit row; without the claim, the staff are still refused a
 *   student's repository; `relay-heads` unchanged.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GIT_TOKEN_AUDIENCE,
  GIT_TOKEN_PATH,
  GitTokenGrant,
  PORTAL_ISSUER,
  ProjectSummary,
  ProjectWorkspace,
  RELAY_HEADS_AUDIENCE,
  RELAY_HEADS_PATH,
  REVIEW_AUDIENCE,
  REVIEW_GRANT_MINUTES,
  ReviewLaunchTokenClaims,
  WorkspaceReview,
  workspaceReviewPath,
} from "@quiz/contracts";
import { signHs256, verifyHs256 } from "@quiz/domain";

import { createApiToken } from "../../auth/tokens.js";
import {
  auditLog,
  classrooms,
  codespaceLaunches,
  codespaceProjects,
  codespaceReviews,
  courseStaff,
  projectGroups,
  projectRepos,
  projects,
  sessions,
  teacherGrants,
  users,
} from "../../db/schema.js";
import { orgsRoute } from "../../github/testing.js";
import { sessionOf } from "../../test/http.js";
import { call, newStudent, server, useProjectWorld, usersRoute, world, type Headers } from "../../test/projectWorld.js";
import {
  CODESPACE_ENV,
  PORTAL,
  PORTAL_SECRET as SECRET,
  captureLog,
  connectedClassroom,
  fakePortal,
  grantedTeacher as grantedWith,
  scopedMint,
  workModeBody,
  type Room,
} from "./testing.js";

const DAY = 24 * 60 * 60_000;

interface Person {
  id: string;
  headers: Headers;
}

let owner: Person;

// ---------------------------------------------------------------- the fakes

const mint = scopedMint();
const { minted } = mint;
const portal = fakePortal();
/** Every line pino writes, from `beforeAll` on. */
let logLines: string[] = [];

// ---------------------------------------------------------------- the world

/** A teacher with or without the workspace grant, a quota of five. */
const grantedTeacher = (enabled: boolean | null) => grantedWith(enabled, 5);
const connected = (students: { id: string }[], teacher: Person = owner) => connectedClassroom(teacher, students, { prefix: "vorg" });

const seat = (room: Room, userId: string, role: "owner" | "assistant") =>
  server.app.db.insert(courseStaff).values({ courseId: room.courseId, userId, role });

async function project(room: Room, mode: "free" | "online" | "online_seb" = "free", by: Person = owner): Promise<ProjectSummary> {
  const created = await call("POST", `/app/api/classrooms/${room.classroomId}/projects`, by.headers, {
    name: `Review ${randomUUID().slice(0, 6)}`,
    sourceRepo: "starter",
    deadlineAt: new Date(Date.now() + 7 * DAY).toISOString(),
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  expect((await call("POST", `/app/api/projects/${summary.id}/publish`, by.headers)).statusCode).toBe(200);
  if (mode !== "free") {
    expect((await call("PUT", `/app/api/projects/${summary.id}/workspace/mode`, by.headers, workModeBody(mode))).statusCode).toBe(200);
  }
  return summary;
}

const repoOf = async (projectId: string, userId: string) =>
  (await server.app.db.select().from(projectRepos).where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.userId, userId))))[0]!;

/** A student's accepted repository on a fresh project of `mode`, an assistant on the course. */
async function reviewable(mode: "free" | "online" | "online_seb" = "free") {
  const student = await newStudent();
  const room = await connected([student]);
  const lab = await project(room, mode);
  const accepted = await call("POST", `/app/api/student/projects/${lab.id}/accept`, student.headers);
  expect(accepted.statusCode, accepted.body).toBe(200);
  const assistant = await grantedTeacher(null);
  await seat(room, assistant.id, "assistant");
  return { student, room, lab, assistant, repo: await repoOf(lab.id, student.id) };
}
type Fixture = Awaited<ReturnType<typeof reviewable>>;

/** Another repository row of the project, as the staff's test or a group's would be (ADR-077, ADR-048). */
async function extraRepo(projectId: string, userId: string, over: Partial<typeof projectRepos.$inferInsert> = {}) {
  const id = randomUUID();
  const n = Math.floor(Math.random() * 1e9);
  await server.app.db.insert(projectRepos).values({
    id,
    projectId,
    userId,
    githubRepoId: n,
    fullName: `vorg/extra-${n}`,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: new Date(),
    ...over,
  });
  return id;
}

const review = (projectId: string, repoId: string, headers: Headers = {}) => call("POST", workspaceReviewPath(projectId, repoId), headers);
const refused = (res: { statusCode: number; json: () => { error: string } }) => [res.statusCode, res.json().error];

/** A launch that succeeds: the token's claims as the portal verifies them. */
async function launchReview(projectId: string, repoId: string, who: Person) {
  const res = await review(projectId, repoId, who.headers);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  const url = new URL(WorkspaceReview.parse(res.json()).url);
  expect(`${url.origin}${url.pathname}`).toBe(`${PORTAL}/review`);
  const token = url.searchParams.get("token")!;
  const verdict = await verifyHs256<Record<string, unknown>>(token, SECRET, {
    audience: REVIEW_AUDIENCE,
    issuer: "heig-quiz",
    requireJti: true,
    now: () => Math.floor(server.clock.now().getTime() / 1000),
  });
  expect(verdict.ok).toBe(true);
  return { token, claims: ReviewLaunchTokenClaims.parse(verdict.ok ? verdict.claims : null) };
}

const reviewAudits = (projectId: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.review_launched"), eq(auditLog.subjectId, projectId)));

/** The portal's token request for a review. */
async function askReview(userId: string, projectId: string, repository: string, reviewRepoId: string | undefined, aud = GIT_TOKEN_AUDIENCE, extra: object = {}) {
  const iat = Math.floor(server.clock.now().getTime() / 1000);
  const token = await signHs256(
    { iss: PORTAL_ISSUER, aud, iat, exp: iat + 60, jti: randomUUID(), projectId, userId, repository, ...(reviewRepoId && { reviewRepoId }), ...extra },
    SECRET,
  );
  return server.app.inject({ method: "POST", url: aud === GIT_TOKEN_AUDIENCE ? GIT_TOKEN_PATH : RELAY_HEADS_PATH, headers: { authorization: `Bearer ${token}` } });
}
const askFor = (f: Fixture, who: Person, over: { projectId?: string; repository?: string } = {}) =>
  askReview(who.id, over.projectId ?? f.lab.id, over.repository ?? f.repo.fullName!, f.repo.id);

useProjectWorld({ routes: [mint.route, orgsRoute(() => []), usersRoute, world.route], env: CODESPACE_ENV, fetch: portal.fetch, teacher: false });

beforeAll(async () => {
  logLines = captureLog(server.app);
  owner = await grantedTeacher(true);
});

beforeEach(() => {
  // The wall clock: the review window and the Super Powers are the database's `now()`.
  server.clock.set(new Date().toISOString());
  world.allowPushes();
  mint.status = null;
});

// ---------------------------------------------------------------- the launch

describe("POST /app/api/projects/:id/repos/:rid/workspace/review (ADR-129 §5)", () => {
  it("launches a review for an assistant and an owner: a review token, recorded, audited, never a launch", async () => {
    const f = await reviewable("online");
    portal.calls.length = 0;
    const before = await server.app.db.select().from(codespaceProjects).where(eq(codespaceProjects.projectId, f.lab.id));

    const { token, claims } = await launchReview(f.lab.id, f.repo.id, f.assistant);
    expect(claims).toMatchObject({
      sub: f.assistant.id,
      projectId: f.lab.id,
      projectRepoId: f.repo.id,
      repo: { fullName: f.repo.fullName },
      holder: { id: owner.id },
      maxActiveSessions: 5,
    });
    expect(claims.exp - claims.iat).toBe(300);
    const [record] = await server.app.db
      .select({ ahead: sql<number>`extract(epoch from ${codespaceReviews.grantUntil} - now())` })
      .from(codespaceReviews)
      .where(and(eq(codespaceReviews.userId, f.assistant.id), eq(codespaceReviews.projectRepoId, f.repo.id)));
    expect(Number(record!.ahead)).toBeGreaterThan(REVIEW_GRANT_MINUTES * 60 - 30);
    expect(Number(record!.ahead)).toBeLessThanOrEqual(REVIEW_GRANT_MINUTES * 60);
    const [audited] = await reviewAudits(f.lab.id);
    expect(audited!.payload).toEqual({ projectRepoId: f.repo.id, repository: f.repo.fullName, jti: claims.jti, reach: "seats" });
    expect(audited!.actorUserId).toBe(f.assistant.id);

    await launchReview(f.lab.id, f.repo.id, owner);
    // No launch record, no frozen mode, no sync: the mode still changes.
    expect(await server.app.db.select().from(codespaceLaunches).where(eq(codespaceLaunches.projectId, f.lab.id))).toEqual([]);
    expect(await server.app.db.select().from(codespaceProjects).where(eq(codespaceProjects.projectId, f.lab.id))).toEqual(before);
    expect(portal.calls).toEqual([]);
    expect((await call("PUT", `/app/api/projects/${f.lab.id}/workspace/mode`, owner.headers, { mode: "free" })).statusCode).toBe(200);
    // The token is in no audit row and no log line.
    const audits = JSON.stringify(await server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, f.lab.id)));
    expect(audits).not.toContain(token.split(".")[2]!);
    expect(logLines.join("\n")).not.toContain(token.split(".")[2]!);
  });

  it("refuses whoever may not launch it, before anything is recorded", async () => {
    const f = await reviewable();
    const other = await project(f.room);
    const admin = await server.signIn("admin");
    const stranger = await grantedTeacher(true);
    const { headers } = f.assistant;

    expect((await review(f.lab.id, f.repo.id)).statusCode).toBe(401);
    const noCsrf = { cookie: headers.cookie! };
    expect(refused(await review(f.lab.id, f.repo.id, noCsrf))).toEqual([403, "csrf"]);
    const impersonation = await sessionOf(server.app.db, f.student.id, { kind: "impersonation", actorUserId: admin.id });
    expect(refused(await review(f.lab.id, f.repo.id, impersonation))).toEqual([403, "impersonation_read_only"]);
    // A confined session is not served here at all (ADR-027): anonymous, the 401.
    expect((await review(f.lab.id, f.repo.id, await sessionOf(server.app.db, f.assistant.id, { kind: "seb", projectId: f.lab.id }))).statusCode).toBe(401);
    expect((await review(f.lab.id, f.repo.id, await sessionOf(server.app.db, f.assistant.id, { kind: "kiosk", evaluationId: f.room.evaluationId }))).statusCode).toBe(401);
    // A personal token: `quiz` does not reach the route (N-SEC-22), `api` does and meets the loader's 404.
    const quiz = await createApiToken(server.app.db, f.assistant.id, { name: "q", expiresInDays: 30, scope: "quiz" });
    expect(refused(await review(f.lab.id, f.repo.id, { authorization: `Bearer ${quiz.token}` }))).toEqual([403, "insufficient_scope"]);
    const api = await createApiToken(server.app.db, f.assistant.id, { name: "a", expiresInDays: 30, scope: "api" });
    expect(refused(await review(f.lab.id, f.repo.id, { authorization: `Bearer ${api.token}` }))).toEqual([404, "not_found"]);
    for (const who of [stranger, admin, f.student]) expect(refused(await review(f.lab.id, f.repo.id, who.headers))).toEqual([404, "not_found"]);
    expect((await review(other.id, f.repo.id, headers)).statusCode).toBe(404);
    expect((await review(f.lab.id, randomUUID(), headers)).statusCode).toBe(404);
    expect((await review(randomUUID(), f.repo.id, headers)).statusCode).toBe(404);
    expect((await review(f.lab.id, "not-a-uuid", headers)).statusCode).toBe(404);

    expect(await reviewAudits(f.lab.id)).toEqual([]);
    expect(await server.app.db.select().from(codespaceReviews).where(eq(codespaceReviews.projectRepoId, f.repo.id))).toEqual([]);
  });

  it("lets an administrator with Super Powers in, and audits their reach", async () => {
    const f = await reviewable();
    const admin = await server.signInWithSuperPowers();
    const { claims } = await launchReview(f.lab.id, f.repo.id, admin);
    const [audited] = await reviewAudits(f.lab.id);
    expect(audited!.payload).toMatchObject({ jti: claims.jti, reach: "all" });
  });

  it("opens a group's repository and a staff test repository alike", async () => {
    const f = await reviewable();
    const groupId = randomUUID();
    await server.app.db.insert(projectGroups).values({ id: groupId, projectId: f.lab.id, name: "G1", slug: "g1", position: 0 });
    const group = await extraRepo(f.lab.id, f.student.id, { groupId });
    const test = await extraRepo(f.lab.id, f.assistant.id);
    await launchReview(f.lab.id, group, f.assistant);
    await launchReview(f.lab.id, test, f.assistant);
  });

  it("answers 409 with staffReviewRefusal's code, and opens once the cause is gone", async () => {
    const f = await reviewable();
    const db = server.app.db;
    const pending = await extraRepo(f.lab.id, f.assistant.id, { provisionStatus: "pending", fullName: null, githubRepoId: null });
    expect(refused(await review(f.lab.id, pending, f.assistant.headers))).toEqual([409, "review_repo_unavailable"]);
    const deleted = await extraRepo(f.lab.id, (await server.signIn("teacher")).id, { deletedAt: new Date() });
    expect(refused(await review(f.lab.id, deleted, f.assistant.headers))).toEqual([409, "review_repo_unavailable"]);

    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, f.lab.id));
    expect(refused(await review(f.lab.id, f.repo.id, f.assistant.headers))).toEqual([409, "review_archived"]);
    await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, f.lab.id));
    await db.update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, f.room.classroomId));
    expect(refused(await review(f.lab.id, f.repo.id, f.assistant.headers))).toEqual([409, "review_archived"]);
    await db.update(classrooms).set({ archivedAt: null }).where(eq(classrooms.id, f.room.classroomId));
    expect(await reviewAudits(f.lab.id)).toEqual([]);
    await launchReview(f.lab.id, f.repo.id, f.assistant);
  });

  it("does not exist while the quota holder holds no enabled grant", async () => {
    const ungranted = await grantedTeacher(false);
    const student = await newStudent();
    const room = await connected([student], ungranted);
    const lab = await project(room, "free", ungranted);
    expect((await call("POST", `/app/api/student/projects/${lab.id}/accept`, student.headers)).statusCode).toBe(200);
    const repo = await repoOf(lab.id, student.id);
    expect(refused(await review(lab.id, repo.id, ungranted.headers))).toEqual([409, "review_not_granted"]);
    const ws = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, ungranted.headers)).json());
    expect(ws.review).toBe(false);
    const granted = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${(await reviewable()).lab.id}/workspace`, owner.headers)).json());
    expect(granted.review).toBe(true);
  });

  it("opens an online_seb repository only once its deadline is applied", async () => {
    const f = await reviewable("online_seb");
    expect(refused(await review(f.lab.id, f.repo.id, f.assistant.headers))).toEqual([409, "review_exam_open"]);
    await server.app.db.update(projectRepos).set({ deadlineAppliedAt: new Date() }).where(eq(projectRepos.id, f.repo.id));
    await launchReview(f.lab.id, f.repo.id, f.assistant);
    expect(await server.app.db.select().from(codespaceLaunches).where(eq(codespaceLaunches.projectId, f.lab.id))).toEqual([]);
  });
});

// ---------------------------------------------------------------- the token

describe("POST /app/codespace/git-token for a review (ADR-129 §7)", () => {
  it("mints contents:read on the recorded repository, until its own expiry, audited without the token", async () => {
    const f = await reviewable("online");
    await launchReview(f.lab.id, f.repo.id, f.assistant);
    logLines.length = 0;
    minted.length = 0;
    const res = await askFor(f, f.assistant, { repository: f.repo.fullName!.toUpperCase() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const grant = GitTokenGrant.parse(res.json());
    expect(grant).toMatchObject({ permission: "read", repository: { fullName: f.repo.fullName, githubRepoId: f.repo.githubRepoId } });
    expect(grant.useUntil).toBe(grant.expiresAt);
    expect(minted.at(-1)!.body).toMatchObject({ repository_ids: [f.repo.githubRepoId], permissions: { contents: "read" } });

    const [issued] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "codespace.git_token_issued"), eq(auditLog.subjectId, f.lab.id)));
    expect(issued!.payload).toMatchObject({ userId: f.assistant.id, permission: "read", reviewRepoId: f.repo.id, repository: f.repo.fullName });
    const all = JSON.stringify(await server.app.db.select().from(auditLog));
    expect(all).not.toContain(grant.token);
    expect(logLines.join("\n")).not.toContain(grant.token);
  });

  it("refuses without a record, after the window, on another name or another project's record", async () => {
    const f = await reviewable();
    expect(refused(await askFor(f, f.assistant))).toEqual([404, "not_found"]);
    await launchReview(f.lab.id, f.repo.id, f.assistant);
    expect(refused(await askFor(f, f.assistant, { repository: "vorg/someone-else" }))).toEqual([404, "not_found"]);
    const other = await project(f.room);
    expect(refused(await askFor(f, f.assistant, { projectId: other.id }))).toEqual([404, "not_found"]);
    // Another staff member did not launch it.
    expect(refused(await askFor(f, owner))).toEqual([404, "not_found"]);
    expect((await askFor(f, f.assistant)).statusCode).toBe(200);
    await server.app.db
      .update(codespaceReviews)
      .set({ grantUntil: sql`now() - interval '1 second'` })
      .where(eq(codespaceReviews.userId, f.assistant.id));
    minted.length = 0;
    expect(refused(await askFor(f, f.assistant))).toEqual([404, "not_found"]);
    expect(minted).toEqual([]);
  });

  it("refuses once the seat is gone", async () => {
    const f = await reviewable();
    await launchReview(f.lab.id, f.repo.id, f.assistant);
    await server.app.db.delete(courseStaff).where(and(eq(courseStaff.courseId, f.room.courseId), eq(courseStaff.userId, f.assistant.id)));
    expect(refused(await askFor(f, f.assistant))).toEqual([404, "not_found"]);
  });

  it("refuses once the administrator's Super Powers end, switched off or expired", async () => {
    const f = await reviewable();
    const admin = await server.signInWithSuperPowers();
    await launchReview(f.lab.id, f.repo.id, admin);
    expect((await askFor(f, admin)).statusCode).toBe(200);
    expect((await call("DELETE", "/app/api/me/super-powers", admin.headers)).statusCode).toBe(200);
    expect(refused(await askFor(f, admin))).toEqual([404, "not_found"]);

    expect((await call("POST", "/app/api/me/super-powers", admin.headers)).statusCode).toBe(200);
    expect((await askFor(f, admin)).statusCode).toBe(200);
    await server.app.db.update(sessions).set({ superPowersUntil: sql`now() - interval '1 second'` }).where(eq(sessions.userId, admin.id));
    expect(refused(await askFor(f, admin))).toEqual([404, "not_found"]);
  });

  it("counts Super Powers only on a live portal session of the admin's own, while the admin role holds", async () => {
    const f = await reviewable();
    const db = server.app.db;
    const admin = await server.signInWithSuperPowers();
    await launchReview(f.lab.id, f.repo.id, admin);
    const ahead = sql`now() + interval '30 minutes'`;
    const own = eq(sessions.userId, admin.id);

    // The only session holding them has expired, its Super Powers still ahead.
    await db.update(sessions).set({ expiresAt: sql`now() - interval '1 second'` }).where(own);
    expect(refused(await askFor(f, admin))).toEqual([404, "not_found"]);
    // A delegated session of theirs, and an impersonation one, live and holding them, count for nothing.
    await db.delete(sessions).where(own);
    await sessionOf(db, admin.id, { kind: "portal", actorUserId: f.assistant.id });
    await sessionOf(db, admin.id, { kind: "impersonation", actorUserId: f.assistant.id });
    await db.update(sessions).set({ superPowersUntil: ahead }).where(own);
    expect(refused(await askFor(f, admin))).toEqual([404, "not_found"]);
    // Their own live portal session holding them: granted; then the admin role lost, refused.
    await sessionOf(db, admin.id, { kind: "portal" });
    await db.update(sessions).set({ superPowersUntil: ahead }).where(own);
    expect((await askFor(f, admin)).statusCode).toBe(200);
    await db.update(users).set({ role: "teacher" }).where(eq(users.id, admin.id));
    expect(refused(await askFor(f, admin))).toEqual([404, "not_found"]);
  });

  it("refuses a seat kept by an account demoted to student (ADR-013 rule 5)", async () => {
    const f = await reviewable();
    await launchReview(f.lab.id, f.repo.id, f.assistant);
    await server.app.db.update(users).set({ role: "student" }).where(eq(users.id, f.assistant.id));
    expect(refused(await askFor(f, f.assistant))).toEqual([404, "not_found"]);
    await server.app.db.update(users).set({ role: "teacher" }).where(eq(users.id, f.assistant.id));
    expect((await askFor(f, f.assistant)).statusCode).toBe(200);
  });

  it("answers 404 once the holder's grant is off or the repository deleted", async () => {
    const f = await reviewable();
    const db = server.app.db;
    await launchReview(f.lab.id, f.repo.id, f.assistant);
    const [holder] = await db.select({ email: users.email }).from(users).where(eq(users.id, owner.id));
    const ownersGrant = eq(teacherGrants.email, holder!.email);
    await db.update(teacherGrants).set({ codespaceEnabled: false }).where(ownersGrant);
    try {
      expect(refused(await askFor(f, f.assistant))).toEqual([404, "not_found"]);
    } finally {
      await db.update(teacherGrants).set({ codespaceEnabled: true }).where(ownersGrant);
    }
    expect((await askFor(f, f.assistant)).statusCode).toBe(200);
    await db.update(projectRepos).set({ deletedAt: new Date() }).where(eq(projectRepos.id, f.repo.id));
    expect(refused(await askFor(f, f.assistant))).toEqual([404, "not_found"]);
  });

  it("closes on an archive and on an exam reopened; 503 when GitHub fails", async () => {
    const f = await reviewable("online_seb");
    const db = server.app.db;
    await db.update(projectRepos).set({ deadlineAppliedAt: new Date() }).where(eq(projectRepos.id, f.repo.id));
    await launchReview(f.lab.id, f.repo.id, f.assistant);
    mint.status = 500;
    expect(refused(await askFor(f, f.assistant))).toEqual([503, "github_unavailable"]);
    mint.status = null;
    await db.update(projectRepos).set({ deadlineAppliedAt: null }).where(eq(projectRepos.id, f.repo.id));
    expect(refused(await askFor(f, f.assistant))).toEqual([409, "closed"]);
    await db.update(projectRepos).set({ deadlineAppliedAt: new Date() }).where(eq(projectRepos.id, f.repo.id));
    await db.update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, f.room.classroomId));
    expect(refused(await askFor(f, f.assistant))).toEqual([409, "closed"]);
  });

  it("without the claim, still refuses the staff a student's repository; relay-heads unchanged", async () => {
    const f = await reviewable("online");
    await launchReview(f.lab.id, f.repo.id, f.assistant);
    expect(refused(await askReview(f.assistant.id, f.lab.id, f.repo.fullName!, undefined))).toEqual([404, "not_found"]);
    const heads = [{ ref: "refs/heads/main", sha: "a".repeat(40) }];
    const declared = await askReview(f.assistant.id, f.lab.id, f.repo.fullName!, f.repo.id, RELAY_HEADS_AUDIENCE, { heads });
    expect(refused(declared)).toEqual([404, "not_found"]);
  });
});
