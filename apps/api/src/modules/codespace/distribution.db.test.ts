/**
 * An owner's review session of a project's distribution repository
 * (ADR-147), and the project's image in every review (§6), over the real
 * application with Quiz's App against the fake GitHub, the portal a stub.
 * The test clock is the wall clock: the review window and the Super Powers
 * are read on the database's (`now()`).
 *
 * - `POST /app/api/projects/:id/workspace/distribution` (§4): an owner, an
 *   administrator with Super Powers; an assistant's `403 owner_required`, a
 *   stranger's 404; in a draft, a scheduled, a published, an `online_seb`
 *   project; refused archived, ungranted, with no distribution; a review
 *   token with a null repository id, the distribution and its handed-out
 *   branch, the project's image; recorded, audited without the token, never a
 *   launch, a frozen mode nor a sync; `ProjectWorkspace.distributionReview`.
 * - `POST /app/codespace/git-token` with `reviewDistribution` (§5): read
 *   only, on the distribution's stored id, within the window, while the
 *   ownership holds; never with both review claims.
 * - A repository's review carries the project's image too (§6).
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
  REVIEW_AUDIENCE,
  REVIEW_GRANT_MINUTES,
  ReviewLaunchTokenClaims,
  WorkspaceReview,
  workspaceDistributionPath,
  workspaceReviewPath,
} from "@quiz/contracts";
import { signHs256, verifyHs256 } from "@quiz/domain";

import {
  auditLog,
  classrooms,
  codespaceDistributionReviews,
  codespaceLaunches,
  codespaceProjects,
  courseStaff,
  courseWorkspaceImages,
  projectRepos,
  projects,
  users,
} from "../../db/schema.js";
import { orgsRoute } from "../../github/testing.js";
import { call, newStudent, server, useProjectWorld, usersRoute, world, type Headers } from "../../test/projectWorld.js";
import {
  CODESPACE_ENV,
  PORTAL,
  PORTAL_SECRET as SECRET,
  captureLog,
  connectedClassroom,
  digestRef,
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

const mint = scopedMint();
const { minted } = mint;
const portal = fakePortal();
let logLines: string[] = [];

const grantedTeacher = (enabled: boolean | null) => grantedWith(enabled, 5);
const connected = (students: { id: string }[], teacher: Person = owner) => connectedClassroom(teacher, students, { prefix: "dorg" });
const seat = (room: Room, userId: string, role: "owner" | "assistant") =>
  server.app.db.insert(courseStaff).values({ courseId: room.courseId, userId, role });

type State = "draft" | "scheduled" | "published";

/** A project of `room` in `state` and `mode`, its distribution built at creation. */
async function project(room: Room, state: State = "draft", mode: "free" | "online" | "online_seb" = "free", by: Person = owner) {
  const scheduled = state === "scheduled";
  const created = await call("POST", `/app/api/classrooms/${room.classroomId}/projects`, by.headers, {
    name: `Dist ${randomUUID().slice(0, 6)}`,
    sourceRepo: "starter",
    deadlineAt: new Date(Date.now() + 7 * DAY).toISOString(),
    ...(scheduled && { publishMode: "scheduled", startAt: new Date(Date.now() + 2 * DAY).toISOString() }),
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  if (mode !== "free") {
    expect((await call("PUT", `/app/api/projects/${summary.id}/workspace/mode`, by.headers, workModeBody(mode))).statusCode).toBe(200);
  }
  if (state !== "draft") {
    const res = await call("POST", `/app/api/projects/${summary.id}/${scheduled ? "schedule" : "publish"}`, by.headers);
    expect(res.statusCode, res.body).toBe(200);
  }
  const [row] = await server.app.db.select().from(projects).where(eq(projects.id, summary.id));
  expect(row!.state).toBe(state);
  expect(row!.distributionFullName).not.toBeNull();
  return row!;
}

/** A classroom of the owner's with an assistant on its course. */
async function course() {
  const room = await connected([await newStudent()]);
  const assistant = await grantedTeacher(null);
  await seat(room, assistant.id, "assistant");
  return { room, assistant };
}

const open = (projectId: string, headers: Headers = {}) => call("POST", workspaceDistributionPath(projectId), headers);
const refused = (res: { statusCode: number; json: () => { error: string } }) => [res.statusCode, res.json().error];

/** The review token a launch answers, as the portal verifies it. */
async function claimsOf(res: { statusCode: number; body: string; headers: Record<string, unknown>; json: () => unknown }) {
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
const launch = async (projectId: string, who: Person) => claimsOf(await open(projectId, who.headers));

const audits = (projectId: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.distribution_review_launched"), eq(auditLog.subjectId, projectId)));

/** The portal's token request for the distribution's review. */
async function ask(userId: string, projectId: string, repository: string, extra: object = { reviewDistribution: true }) {
  const iat = Math.floor(server.clock.now().getTime() / 1000);
  const token = await signHs256(
    { iss: PORTAL_ISSUER, aud: GIT_TOKEN_AUDIENCE, iat, exp: iat + 60, jti: randomUUID(), projectId, userId, repository, ...extra },
    SECRET,
  );
  return server.app.inject({ method: "POST", url: GIT_TOKEN_PATH, headers: { authorization: `Bearer ${token}` } });
}

/** A ready course image picked by the project: its digest reference. */
async function pickImage(room: Room, projectId: string): Promise<string> {
  const id = randomUUID();
  const digest = digestRef(`heig/${id.slice(0, 8)}`, "d");
  const now = new Date();
  await server.app.db.insert(courseWorkspaceImages).values({
    id,
    courseId: room.courseId,
    name: `img-${id.slice(0, 6)}`,
    reference: digest,
    digestReference: digest,
    state: "ready",
    requestedAt: now,
    createdBy: owner.id,
    createdAt: now,
    updatedAt: now,
  });
  await server.app.db
    .insert(codespaceProjects)
    .values({ projectId, imageId: id })
    .onConflictDoUpdate({ target: codespaceProjects.projectId, set: { imageId: id } });
  return digest;
}

useProjectWorld({ routes: [mint.route, orgsRoute(() => []), usersRoute, world.route], env: CODESPACE_ENV, fetch: portal.fetch, teacher: false });

beforeAll(async () => {
  logLines = captureLog(server.app);
  owner = await grantedTeacher(true);
});

beforeEach(() => {
  server.clock.set(new Date().toISOString());
  world.allowPushes();
  mint.status = null;
});

describe("POST /app/api/projects/:id/workspace/distribution (ADR-147 §4)", () => {
  it("opens a draft's distribution for an owner: a review token on it, recorded, audited, never a launch nor a sync", async () => {
    const { room } = await course();
    const lab = await project(room, "draft", "online");
    portal.calls.length = 0;
    const before = await server.app.db.select().from(codespaceProjects).where(eq(codespaceProjects.projectId, lab.id));

    const { token, claims } = await launch(lab.id, owner);
    expect(claims).toMatchObject({
      sub: owner.id,
      projectId: lab.id,
      projectRepoId: null,
      repo: { fullName: lab.distributionFullName, defaultBranch: lab.branches[0] },
      holder: { id: owner.id },
      maxActiveSessions: 5,
      image: null,
    });
    const [record] = await server.app.db
      .select({ ahead: sql<number>`extract(epoch from ${codespaceDistributionReviews.grantUntil} - now())` })
      .from(codespaceDistributionReviews)
      .where(and(eq(codespaceDistributionReviews.userId, owner.id), eq(codespaceDistributionReviews.projectId, lab.id)));
    expect(Number(record!.ahead)).toBeGreaterThan(REVIEW_GRANT_MINUTES * 60 - 30);
    expect(Number(record!.ahead)).toBeLessThanOrEqual(REVIEW_GRANT_MINUTES * 60);
    const [audited] = await audits(lab.id);
    expect(audited!.payload).toEqual({ repository: lab.distributionFullName, jti: claims.jti, reach: "seats", image: null });

    // No launch record, no frozen mode, no sync, the project still a draft.
    expect(await server.app.db.select().from(codespaceLaunches).where(eq(codespaceLaunches.projectId, lab.id))).toEqual([]);
    expect(await server.app.db.select().from(codespaceProjects).where(eq(codespaceProjects.projectId, lab.id))).toEqual(before);
    expect(portal.calls).toEqual([]);
    expect((await server.app.db.select({ state: projects.state }).from(projects).where(eq(projects.id, lab.id)))[0]!.state).toBe("draft");
    expect((await call("PUT", `/app/api/projects/${lab.id}/workspace/mode`, owner.headers, { mode: "free" })).statusCode).toBe(200);
    const all = JSON.stringify(await server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, lab.id)));
    expect(all).not.toContain(token.split(".")[2]!);
    expect(logLines.join("\n")).not.toContain(token.split(".")[2]!);
  });

  it.each<[State, "free" | "online" | "online_seb"]>([
    ["scheduled", "online"],
    ["published", "free"],
    ["published", "online_seb"],
  ])("opens a %s %s project too", async (state, mode) => {
    const { room } = await course();
    const lab = await project(room, state, mode);
    const { claims } = await launch(lab.id, owner);
    expect(claims.projectRepoId).toBeNull();
  });

  it("refuses an assistant 403 owner_required and anyone off the staff 404, before anything is recorded", async () => {
    const { room, assistant } = await course();
    const lab = await project(room);
    const stranger = await grantedTeacher(true);
    const student = await newStudent();
    const admin = await server.signIn("admin");
    expect((await open(lab.id)).statusCode).toBe(401);
    expect(refused(await open(lab.id, { cookie: owner.headers.cookie! }))).toEqual([403, "csrf"]);
    expect(refused(await open(lab.id, assistant.headers))).toEqual([403, "owner_required"]);
    for (const who of [stranger, student, admin]) expect(refused(await open(lab.id, who.headers))).toEqual([404, "not_found"]);
    expect((await open(randomUUID(), owner.headers)).statusCode).toBe(404);
    expect(await audits(lab.id)).toEqual([]);
    expect(await server.app.db.select().from(codespaceDistributionReviews).where(eq(codespaceDistributionReviews.projectId, lab.id))).toEqual([]);
    // The page's flag says the same.
    const asOwner = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, owner.headers)).json());
    const asAssistant = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, assistant.headers)).json());
    expect([asOwner.distributionReview, asAssistant.distributionReview, asAssistant.review]).toEqual([true, false, true]);
  });

  it("lets an administrator with Super Powers in, as an owner", async () => {
    const { room } = await course();
    const lab = await project(room);
    const admin = await server.signInWithSuperPowers();
    const { claims } = await launch(lab.id, admin);
    expect((await audits(lab.id))[0]!.payload).toMatchObject({ jti: claims.jti, reach: "all" });
  });

  it("answers 409 with distributionReviewRefusal's code, and opens once the cause is gone", async () => {
    const { room } = await course();
    const lab = await project(room);
    const db = server.app.db;
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, lab.id));
    expect(refused(await open(lab.id, owner.headers))).toEqual([409, "review_archived"]);
    await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, lab.id));
    await db.update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, room.classroomId));
    expect(refused(await open(lab.id, owner.headers))).toEqual([409, "review_archived"]);
    await db.update(classrooms).set({ archivedAt: null }).where(eq(classrooms.id, room.classroomId));
    await db.update(projects).set({ distributionRepoId: null }).where(eq(projects.id, lab.id));
    expect(refused(await open(lab.id, owner.headers))).toEqual([409, "review_distribution_missing"]);
    await db.update(projects).set({ distributionRepoId: lab.distributionRepoId }).where(eq(projects.id, lab.id));
    expect(await audits(lab.id)).toEqual([]);
    await launch(lab.id, owner);
  });

  it("is refused review_not_granted, and absent from the page, without the holder's grant", async () => {
    const ungranted = await grantedTeacher(false);
    const room = await connected([await newStudent()], ungranted);
    const lab = await project(room, "draft", "free", ungranted);
    expect(refused(await open(lab.id, ungranted.headers))).toEqual([409, "review_not_granted"]);
    const ws = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, ungranted.headers)).json());
    expect(ws.distributionReview).toBe(false);
  });
});

describe("the project's image in a review (ADR-147 §6)", () => {
  it("names the project's digest in an online project's reviews, the default in a free one", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const lab = await project(room, "published", "online");
    const digest = await pickImage(room, lab.id);
    expect((await launch(lab.id, owner)).claims.image).toBe(digest);
    expect((await audits(lab.id))[0]!.payload).toMatchObject({ image: digest });

    expect((await call("POST", `/app/api/student/projects/${lab.id}/accept`, student.headers)).statusCode).toBe(200);
    const [repo] = await server.app.db.select().from(projectRepos).where(eq(projectRepos.projectId, lab.id));
    expect((await claimsOf(await call("POST", workspaceReviewPath(lab.id, repo!.id), owner.headers))).claims.image).toBe(digest);

    const free = await project(room, "draft", "free");
    await pickImage(room, free.id);
    expect((await launch(free.id, owner)).claims.image).toBeNull();
  });
});

describe("POST /app/codespace/git-token for the distribution (ADR-147 §5)", () => {
  it("mints contents:read on the distribution's stored id, audited without the token", async () => {
    const { room } = await course();
    const lab = await project(room, "scheduled", "online");
    await launch(lab.id, owner);
    minted.length = 0;
    logLines.length = 0;
    const res = await ask(owner.id, lab.id, lab.distributionFullName!.toUpperCase());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const grant = GitTokenGrant.parse(res.json());
    expect(grant).toMatchObject({ permission: "read", repository: { fullName: lab.distributionFullName, githubRepoId: lab.distributionRepoId } });
    expect(grant.useUntil).toBe(grant.expiresAt);
    expect(minted.at(-1)!.body).toMatchObject({ repository_ids: [lab.distributionRepoId], permissions: { contents: "read" } });
    const [issued] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "codespace.git_token_issued"), eq(auditLog.subjectId, lab.id)));
    expect(issued!.payload).toMatchObject({ userId: owner.id, permission: "read", reviewDistribution: true, repository: lab.distributionFullName });
    expect(JSON.stringify(await server.app.db.select().from(auditLog))).not.toContain(grant.token);
    expect(logLines.join("\n")).not.toContain(grant.token);
  });

  it("refuses without a record, on another name, after the window, and with both review claims", async () => {
    const { room, assistant } = await course();
    const lab = await project(room);
    const name = lab.distributionFullName!;
    expect(refused(await ask(owner.id, lab.id, name))).toEqual([404, "not_found"]);
    await launch(lab.id, owner);
    expect(refused(await ask(owner.id, lab.id, "dorg/someone-else"))).toEqual([404, "not_found"]);
    expect(refused(await ask(assistant.id, lab.id, name))).toEqual([404, "not_found"]);
    expect(refused(await ask(owner.id, lab.id, name, { reviewDistribution: true, reviewRepoId: randomUUID() }))).toEqual([401, "unauthorized"]);
    // Without the claim, the launch rule: an owner never launched it.
    expect(refused(await ask(owner.id, lab.id, name, {}))).toEqual([404, "not_found"]);
    expect((await ask(owner.id, lab.id, name)).statusCode).toBe(200);
    await server.app.db
      .update(codespaceDistributionReviews)
      .set({ grantUntil: sql`now() - interval '1 second'` })
      .where(eq(codespaceDistributionReviews.projectId, lab.id));
    minted.length = 0;
    expect(refused(await ask(owner.id, lab.id, name))).toEqual([404, "not_found"]);
    expect(minted).toEqual([]);
  });

  it("refuses once the owner is an assistant, demoted to student, or the holder ungranted; closes on an archive", async () => {
    const { room } = await course();
    const lab = await project(room);
    const name = lab.distributionFullName!;
    const db = server.app.db;
    const second = await grantedTeacher(null);
    await seat(room, second.id, "owner");
    await launch(lab.id, second);
    expect((await ask(second.id, lab.id, name)).statusCode).toBe(200);
    const seatOf = and(eq(courseStaff.courseId, room.courseId), eq(courseStaff.userId, second.id));
    await db.update(courseStaff).set({ role: "assistant" }).where(seatOf);
    expect(refused(await ask(second.id, lab.id, name))).toEqual([404, "not_found"]);
    await db.update(courseStaff).set({ role: "owner" }).where(seatOf);
    await db.update(users).set({ role: "student" }).where(eq(users.id, second.id));
    expect(refused(await ask(second.id, lab.id, name))).toEqual([404, "not_found"]);
    await db.update(users).set({ role: "teacher" }).where(eq(users.id, second.id));
    expect((await ask(second.id, lab.id, name)).statusCode).toBe(200);
    await db.update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, room.classroomId));
    expect(refused(await ask(second.id, lab.id, name))).toEqual([409, "closed"]);
    await db.update(classrooms).set({ archivedAt: null }).where(eq(classrooms.id, room.classroomId));
    await db.update(projects).set({ distributionRepoId: null }).where(eq(projects.id, lab.id));
    expect(refused(await ask(second.id, lab.id, name))).toEqual([404, "not_found"]);
  });
});
