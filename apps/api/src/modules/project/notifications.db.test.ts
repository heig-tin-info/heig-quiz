/**
 * The notifications of projects (F-NOTIF-13, D18, ADR-030; merge task
 * M3-09b) on a server built with Quiz's App, against the fake GitHub
 * (`github/testing.ts`) and the local bare repositories (`./testing.ts`),
 * the clock moved by hand. No queue: the bell rows are what is asserted,
 * each kind sent once at its trigger, to its audience and nobody else — a
 * student never receives another student's notification, a staff seat never
 * a student's kind.
 *
 * - `project_published`: the classroom's claimed student seats, once, by
 *   hand and by the ticker's scheduled publication;
 * - `project_repo_invited`: the student whose Accept provisioned the
 *   repository, never on an idempotent repeat;
 * - `project_provision_failed`: the staff, the row's first failure only,
 *   with its reason, folded per project; never an invitation refused;
 * - `project_deadline_reminder`: claimed and sent in one tick, 24 h before
 *   the student's EFFECTIVE deadline — per repository for an own deadline —,
 *   nothing under a 24 h window, never after the deadline, a late scan
 *   catches up, re-armed only by a move more than a day ahead;
 * - `project_deadline_applied`: the staff, folded per project, only when a
 *   pass locked or committed something;
 * - `project_grade_final`: the students whose repositories the release
 *   covered, on the first release only.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationPayload, ProjectSummary, type NotificationKind } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import {
  courseStaff,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  notifications,
  projectGroupMembers,
  projectGroups,
  projectRepos,
  projects,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { PROJECT_DEADLINE_QUEUE, type JobQueue } from "../../jobs.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { projectTick, runDeadlineJob } from "./jobs.js";
import type { ProjectJob } from "./lease.js";
import { repoWorld } from "./testing.js";

const key = appKey();
const gh = fakeGithub();
const world = repoWorld();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
};
const config = loadConfig({ NODE_ENV: "test", ...ENV });
const NOW = "2026-10-02T08:00:00.000Z";
const DEADLINE = "2026-10-09T22:00:00.000Z";
const HOUR = 3_600_000;
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);

type Headers = Record<string, string>;
interface Who {
  id: string;
  headers: Headers;
}
/** A student with a linked GitHub account. */
interface Student extends Who {
  login: string;
}
let server: TestServer;
let teacher: Who;
let nextOrg = 42_000;
let nextAccount = 45_000;

const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

async function newStudent(login?: string): Promise<Student> {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const name = login ?? `nt${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login: name });
  accounts.set(githubUserId, name);
  return { ...signed, login: name };
}

const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const accept = (projectId: string, who: Who) => call("POST", `/app/api/student/projects/${projectId}/accept`, who.headers);

interface World {
  id: string;
  classroomId: string;
  students: Student[];
  /** A colleague on the course's staff, told of the staff kinds too. */
  colleague: Who;
}

/**
 * A project of a connected classroom with `students` claimed students (and a
 * staff colleague), published by hand unless `publish: false`; the students
 * have accepted unless `accept: false`.
 */
async function project(opts: { students?: number; body?: Record<string, unknown>; publish?: boolean; accept?: boolean } = {}): Promise<World> {
  const db = server.app.db;
  const students = await Promise.all(Array.from({ length: opts.students ?? 1 }, () => newStudent()));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const colleague = await server.signIn("teacher");
  await db.insert(courseStaff).values({ courseId: seeded.courseId, userId: colleague.id });
  const n = nextOrg++;
  const login = `norg-${n}`;
  world.orgIds[login] = n;
  world.source(login, "starter", { main: { "README.md": "# Lab", "src/main.c": "int main(){}" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const created = await call("POST", `/app/api/classrooms/${seeded.classroomId}/projects`, teacher.headers, {
    name: "Lab 1",
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
    ...opts.body,
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  const w: World = { id: summary.id, classroomId: seeded.classroomId, students, colleague };
  if (opts.publish === false) return w;
  expect((await call("POST", `/app/api/projects/${summary.id}/publish`, teacher.headers)).statusCode).toBe(200);
  if (opts.accept !== false) {
    for (const s of students) {
      const res = await accept(summary.id, s);
      expect(res.statusCode, res.body).toBe(200);
    }
  }
  return w;
}

/**
 * The bells of `userId` of `kind`, newest first, their payloads parsed —
 * about `projectId` only when given: the teacher is on every project here.
 */
async function bells(userId: string, kind: NotificationKind, projectId?: string) {
  const rows = await server.app.db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt));
  return rows
    .map((r) => NotificationPayload.parse(r.payload))
    .filter((p) => p.kind === kind && (projectId === undefined || ("projectId" in p && p.projectId === projectId)));
}
const projectRow = async (id: string) => (await server.app.db.select().from(projects).where(eq(projects.id, id)))[0]!;
const repoOf = async (projectId: string, userId: string) =>
  (await server.app.db.select().from(projectRepos).where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.userId, userId))))[0]!;

/** One pass of the ticker; with `queue`, the deadline jobs it sent. */
const sent: ProjectJob[] = [];
async function tick(withQueue = false): Promise<void> {
  const queue: JobQueue = {
    createQueue: async () => {},
    send: async (name, data) => void (name === PROJECT_DEADLINE_QUEUE && sent.push(data as ProjectJob)),
    work: async () => {},
    stop: async () => {},
  };
  const app = server.app as { boss?: JobQueue };
  if (withQueue) app.boss = queue;
  try {
    await projectTick(server.app, config);
  } finally {
    delete app.boss;
  }
}
async function runJobs(projectId: string): Promise<void> {
  const mine = sent.filter((j) => j.projectId === projectId);
  for (const job of mine) {
    sent.splice(sent.indexOf(job), 1);
    await runDeadlineJob(server.app, config, job);
  }
}

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  sent.length = 0;
  world.allowPushes();
  world.freePlan = false;
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- project_published

describe("project_published", () => {
  it("tells the classroom's claimed student seats once, by hand, and nobody else", async () => {
    const w = await project({ students: 2, accept: false });
    const other = await project({ publish: false });
    for (const s of w.students) {
      expect(await bells(s.id, "project_published")).toEqual([{ kind: "project_published", projectId: w.id, projectTitle: "Lab 1" }]);
    }
    // Another classroom's student, the staff: nothing.
    expect(await bells(other.students[0]!.id, "project_published")).toEqual([]);
    expect(await bells(teacher.id, "project_published", w.id)).toEqual([]);
    expect(await bells(w.colleague.id, "project_published", w.id)).toEqual([]);
    // Published once: a second publish is refused and tells nobody again.
    expect((await call("POST", `/app/api/projects/${w.id}/publish`, teacher.headers)).statusCode).toBe(409);
    expect(await bells(w.students[0]!.id, "project_published")).toHaveLength(1);
  });

  it("tells a student without a linked GitHub account to link it, the others as before", async () => {
    const w = await project({ students: 2, publish: false });
    const [linked, unlinked] = w.students;
    await server.app.db.delete(githubAccounts).where(eq(githubAccounts.userId, unlinked!.id));
    expect((await call("POST", `/app/api/projects/${w.id}/publish`, teacher.headers)).statusCode).toBe(200);
    expect(await bells(linked!.id, "project_published")).toEqual([{ kind: "project_published", projectId: w.id, projectTitle: "Lab 1" }]);
    // The boolean and nothing else: no login, no repository (N-SEC-20).
    expect(await bells(unlinked!.id, "project_published")).toEqual([
      { kind: "project_published", projectId: w.id, projectTitle: "Lab 1", githubLinked: false },
    ]);
  });

  it("tells them at the ticker's scheduled publication too", async () => {
    const w = await project({ publish: false, body: { publishMode: "scheduled", startAt: "2026-10-03T08:00:00Z", deadlineAt: DEADLINE } });
    await tick();
    expect(await bells(w.students[0]!.id, "project_published")).toEqual([]);
    server.clock.set("2026-10-03T08:00:00Z");
    await tick();
    expect((await projectRow(w.id)).state).toBe("published");
    expect(await bells(w.students[0]!.id, "project_published")).toHaveLength(1);
    await tick();
    expect(await bells(w.students[0]!.id, "project_published")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- project_repo_invited, project_provision_failed

describe("project_repo_invited", () => {
  it("tells the student whose Accept made the repository, once, never on the idempotent repeat", async () => {
    const w = await project({ students: 2 });
    const [a, b] = w.students;
    expect(await bells(a!.id, "project_repo_invited")).toEqual([{ kind: "project_repo_invited", projectId: w.id, projectTitle: "Lab 1" }]);
    expect(await bells(b!.id, "project_repo_invited")).toHaveLength(1);
    expect((await accept(w.id, a!)).statusCode).toBe(200);
    expect(await bells(a!.id, "project_repo_invited")).toHaveLength(1);
    expect(await bells(teacher.id, "project_repo_invited", w.id)).toEqual([]);
  });
});

describe("project_provision_failed", () => {
  it("tells the staff of the row's first failure with its reason, folded per project, never a student", async () => {
    const w = await project({ students: 2, accept: false });
    const [a, b] = w.students;
    world.refusePushes = true;
    expect((await accept(w.id, a!)).statusCode).toBe(502);
    const first = { kind: "project_provision_failed", projectId: w.id, projectTitle: "Lab 1", count: 1, reason: "github_error" };
    expect(await bells(teacher.id, "project_provision_failed", w.id)).toEqual([first]);
    expect(await bells(w.colleague.id, "project_provision_failed", w.id)).toEqual([first]);
    // The retry fails again: the row's first failure was told, not this one.
    expect((await accept(w.id, a!)).statusCode).toBe(502);
    expect(await bells(teacher.id, "project_provision_failed", w.id)).toEqual([first]);
    // Another student's first failure folds into the same unread entry.
    expect((await accept(w.id, b!)).statusCode).toBe(502);
    expect(await bells(teacher.id, "project_provision_failed", w.id)).toEqual([{ ...first, count: 2 }]);
    world.allowPushes();
    expect(await bells(a!.id, "project_provision_failed")).toEqual([]);
    expect(await bells(a!.id, "project_repo_invited")).toEqual([]);
  });

  it("names a repository name taken, which only the staff can resolve", async () => {
    // `lab-1` + the login `squashed`: the project's own distribution repository.
    const squashed = await newStudent("squashed");
    const w = await project({ students: 0, accept: false });
    await server.app.db
      .insert(enrollments)
      .values({ id: randomUUID(), classroomId: w.classroomId, nom: "S", prenom: "Q", email: "sq@heig.test", userId: squashed.id, claimedAt: new Date(), staff: false });
    const res = await accept(w.id, squashed);
    expect([res.statusCode, res.json().error]).toEqual([409, "repo_name_taken"]);
    expect(await bells(teacher.id, "project_provision_failed", w.id)).toEqual([
      { kind: "project_provision_failed", projectId: w.id, projectTitle: "Lab 1", count: 1, reason: "repo_name_taken" },
    ]);
  });

  it("tells nobody of an invitation GitHub refused: the student relinks", async () => {
    const w = await project({ accept: false });
    world.uninvitable.add(w.students[0]!.login);
    try {
      expect((await accept(w.id, w.students[0]!)).json().error).toBe("github_account_stale");
    } finally {
      world.uninvitable.delete(w.students[0]!.login);
    }
    expect(await bells(teacher.id, "project_provision_failed", w.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------- project_deadline_reminder

describe("project_deadline_reminder", () => {
  const reminder = (projectId: string) => ({ kind: "project_deadline_reminder", projectId, projectTitle: "Lab 1" });

  it("claims and tells every claimed student seat once, 24 h before the project's deadline, repository or not", async () => {
    const w = await project({ students: 2, accept: false });
    expect((await accept(w.id, w.students[0]!)).statusCode).toBe(200);
    server.clock.set(at(DEADLINE, -25 * HOUR));
    await tick();
    expect((await projectRow(w.id)).reminderSentAt).toBeNull();
    for (const s of w.students) expect(await bells(s.id, "project_deadline_reminder")).toEqual([]);

    server.clock.set(at(DEADLINE, -23 * HOUR));
    await tick();
    expect((await projectRow(w.id)).reminderSentAt).toEqual(at(DEADLINE, -23 * HOUR));
    for (const s of w.students) expect(await bells(s.id, "project_deadline_reminder")).toEqual([reminder(w.id)]);
    expect(await bells(teacher.id, "project_deadline_reminder", w.id)).toEqual([]);

    // Once: the next tick finds the claim taken.
    server.clock.advance(20_000);
    await tick();
    for (const s of w.students) expect(await bells(s.id, "project_deadline_reminder")).toHaveLength(1);
  });

  it("catches up late, but never after the deadline", async () => {
    const missed = await project();
    server.clock.set(at(DEADLINE, HOUR));
    await tick();
    expect(await bells(missed.students[0]!.id, "project_deadline_reminder")).toEqual([]);
    expect((await projectRow(missed.id)).reminderSentAt).toBeNull();

    server.clock.set(NOW);
    const late = await project();
    server.clock.set(at(DEADLINE, -HOUR));
    await tick();
    expect(await bells(late.students[0]!.id, "project_deadline_reminder")).toHaveLength(1);
  });

  it("sends nothing for a window under a day, project or own deadline alike: the start lies within it", async () => {
    const w = await project({ body: { deadlineAt: at(NOW, 20 * HOUR).toISOString() } });
    expect((await projectRow(w.id)).reminderSentAt).toBeNull();
    // An own deadline later than the project's, still within a day of the start.
    const repo = await repoOf(w.id, w.students[0]!.id);
    const own = await call("PUT", `/app/api/projects/${w.id}/repos/${repo.id}/deadline`, teacher.headers, { deadlineAt: at(NOW, 23 * HOUR).toISOString() });
    expect(own.statusCode, own.body).toBe(200);
    server.clock.set(at(NOW, HOUR));
    await tick();
    expect(await bells(w.students[0]!.id, "project_deadline_reminder")).toEqual([]);
    expect((await repoOf(w.id, w.students[0]!.id)).reminderSentAt).toBeNull();
  });

  it("reminds a student with their own deadline of THAT one, per repository, and leaves them out of the project's", async () => {
    const w = await project({ students: 2 });
    const [own, other] = w.students;
    const ownRepo = await repoOf(w.id, own!.id);
    const OWN_DEADLINE = "2026-10-12T22:00:00.000Z";
    const set = await call("PUT", `/app/api/projects/${w.id}/repos/${ownRepo.id}/deadline`, teacher.headers, { deadlineAt: OWN_DEADLINE });
    expect(set.statusCode, set.body).toBe(200);
    expect((await repoOf(w.id, own!.id)).reminderSentAt).toBeNull();

    server.clock.set(at(DEADLINE, -23 * HOUR));
    await tick();
    expect(await bells(other!.id, "project_deadline_reminder")).toEqual([reminder(w.id)]);
    expect(await bells(own!.id, "project_deadline_reminder")).toEqual([]);

    server.clock.set(at(OWN_DEADLINE, -23 * HOUR));
    await tick();
    expect(await bells(own!.id, "project_deadline_reminder")).toEqual([reminder(w.id)]);
    expect((await repoOf(w.id, own!.id)).reminderSentAt).toEqual(at(OWN_DEADLINE, -23 * HOUR));
    expect(await bells(other!.id, "project_deadline_reminder")).toHaveLength(1);
    await tick();
    expect(await bells(own!.id, "project_deadline_reminder")).toHaveLength(1);
  });

  it("reminds of an own deadline given within a day when the project has been open longer, and skips a repository the staff locked by hand", async () => {
    const w = await project({ students: 2 });
    const [soon, locked] = w.students;
    server.clock.set(at(DEADLINE, -30 * HOUR));
    const soonRepo = await repoOf(w.id, soon!.id);
    // Given ten hours ahead, on a project open for a week: the student's window is the project's.
    const res = await call("PUT", `/app/api/projects/${w.id}/repos/${soonRepo.id}/deadline`, teacher.headers, { deadlineAt: at(DEADLINE, -20 * HOUR).toISOString() });
    expect(res.statusCode, res.body).toBe(200);
    expect((await repoOf(w.id, soon!.id)).reminderSentAt).toBeNull();
    expect((await call("POST", `/app/api/projects/${w.id}/repos/${(await repoOf(w.id, locked!.id)).id}/lock`, teacher.headers)).statusCode).toBe(200);

    await tick();
    expect(await bells(soon!.id, "project_deadline_reminder")).toEqual([reminder(w.id)]);
    expect((await repoOf(w.id, soon!.id)).reminderSentAt).toEqual(at(DEADLINE, -30 * HOUR));
    server.clock.set(at(DEADLINE, -23 * HOUR));
    await tick();
    expect(await bells(soon!.id, "project_deadline_reminder")).toHaveLength(1);
    expect(await bells(locked!.id, "project_deadline_reminder")).toEqual([]);
  });

  it("leaves a member of a GROUP repository with its own deadline out of the project's claim, but not a holder of a live individual repository (ADR-048)", async () => {
    const w = await project({ students: 3, accept: false });
    const [member, other, holder] = w.students;
    // The holder: in the group too, but reads their own live repository — their deadline is the project's.
    expect((await accept(w.id, holder!)).statusCode).toBe(200);
    const db = server.app.db;
    const seatOf = async (userId: string) =>
      (await db.select({ id: enrollments.id }).from(enrollments).where(and(eq(enrollments.classroomId, w.classroomId), eq(enrollments.userId, userId))))[0]!;
    const groupId = randomUUID();
    await db.insert(projectGroups).values({ id: groupId, projectId: w.id, name: "G1", slug: "g1", position: 1 });
    for (const who of [member!, holder!]) {
      await db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: w.id, groupId, enrollmentId: (await seatOf(who.id)).id });
    }
    // The group's repository, accepted by somebody else, with its own later deadline.
    await db.insert(projectRepos).values({
      id: randomUUID(),
      projectId: w.id,
      userId: teacher.id,
      groupId,
      githubRepoId: 999_001,
      fullName: "norg/lab-1-g1",
      provisionStatus: "ok",
      acceptedAt: new Date(NOW),
      deadlineAt: at("2026-10-12T22:00:00.000Z"),
    });
    server.clock.set(at(DEADLINE, -23 * HOUR));
    await tick();
    expect(await bells(other!.id, "project_deadline_reminder")).toEqual([reminder(w.id)]);
    expect(await bells(holder!.id, "project_deadline_reminder")).toEqual([reminder(w.id)]);
    expect(await bells(member!.id, "project_deadline_reminder")).toEqual([]);
  });

  it("is re-armed by a deadline moved more than a day ahead, and never re-sent otherwise", async () => {
    const w = await project();
    const [s] = w.students;
    server.clock.set(at(DEADLINE, -23 * HOUR));
    await tick();
    expect(await bells(s!.id, "project_deadline_reminder")).toHaveLength(1);

    // Moved to 20 hours ahead: the claim stays, nothing more is sent.
    const nearer = await call("PATCH", `/app/api/projects/${w.id}`, teacher.headers, { deadlineAt: at(DEADLINE, -3 * HOUR).toISOString() });
    expect(nearer.statusCode, nearer.body).toBe(200);
    expect((await projectRow(w.id)).reminderSentAt).not.toBeNull();
    await tick();
    expect(await bells(s!.id, "project_deadline_reminder")).toHaveLength(1);

    // Moved three days ahead: re-armed, and sent again the day before.
    const LATER = "2026-10-12T22:00:00.000Z";
    expect((await call("PATCH", `/app/api/projects/${w.id}`, teacher.headers, { deadlineAt: LATER })).statusCode).toBe(200);
    expect((await projectRow(w.id)).reminderSentAt).toBeNull();
    await tick();
    expect(await bells(s!.id, "project_deadline_reminder")).toHaveLength(1);
    server.clock.set(at(LATER, -23 * HOUR));
    await tick();
    expect(await bells(s!.id, "project_deadline_reminder")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- project_deadline_applied

describe("project_deadline_applied", () => {
  it("tells the staff once per pass that locked something, folded per project, with the count", async () => {
    const w = await project({ students: 2 });
    server.clock.set(at(DEADLINE, 1000));
    await tick(true);
    // The tick only claims: nothing is told before the job settled GitHub.
    expect(await bells(teacher.id, "project_deadline_applied", w.id)).toEqual([]);
    await runJobs(w.id);
    const applied = { kind: "project_deadline_applied", projectId: w.id, projectTitle: "Lab 1", count: 2 };
    expect(await bells(teacher.id, "project_deadline_applied", w.id)).toEqual([applied]);
    expect(await bells(w.colleague.id, "project_deadline_applied", w.id)).toEqual([applied]);
    for (const s of w.students) expect(await bells(s.id, "project_deadline_applied")).toEqual([]);

    // Settled: a pass with nothing to do tells nobody.
    server.clock.advance(20_000);
    await tick(true);
    await runJobs(w.id);
    expect(await bells(teacher.id, "project_deadline_applied", w.id)).toEqual([applied]);

    // An unlock is not the deadline applied; a lock again folds into the same unread entry.
    const repo = await repoOf(w.id, w.students[0]!.id);
    expect((await call("POST", `/app/api/projects/${w.id}/repos/${repo.id}/unlock`, teacher.headers)).statusCode).toBe(200);
    expect(await bells(teacher.id, "project_deadline_applied", w.id)).toEqual([applied]);
    expect((await call("POST", `/app/api/projects/${w.id}/repos/${repo.id}/lock`, teacher.headers)).statusCode).toBe(200);
    expect(await bells(teacher.id, "project_deadline_applied", w.id)).toEqual([{ ...applied, count: 3 }]);
  });
});

// ---------------------------------------------------------------- project_grade_final

describe("project_grade_final", () => {
  it("tells the students whose repositories the release covered, on the first release only", async () => {
    const w = await project({ students: 2 });
    const idle = await newStudent();
    await server.app.db
      .insert(enrollments)
      .values({ id: randomUUID(), classroomId: w.classroomId, nom: "I", prenom: "D", email: "idle@heig.test", userId: idle.id, claimedAt: new Date(), staff: false });
    // Past the deadline and the grace: applied, then frozen for good.
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    server.clock.set(at(DEADLINE, 2 * HOUR));
    await tick();
    const first = await call("POST", `/app/api/projects/${w.id}/release`, teacher.headers);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ first: true });
    const final = { kind: "project_grade_final", projectId: w.id, projectTitle: "Lab 1" };
    for (const s of w.students) expect(await bells(s.id, "project_grade_final")).toEqual([final]);
    // A seat with no repository, the staff: nothing.
    expect(await bells(idle.id, "project_grade_final")).toEqual([]);
    expect(await bells(teacher.id, "project_grade_final", w.id)).toEqual([]);

    const again = await call("POST", `/app/api/projects/${w.id}/release`, teacher.headers);
    expect(again.json()).toMatchObject({ first: false });
    for (const s of w.students) expect(await bells(s.id, "project_grade_final")).toHaveLength(1);
  });
});
