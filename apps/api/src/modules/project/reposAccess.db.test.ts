/**
 * An `online_seb` project's repositories opened to their students,
 * read-only, and closed again (ADR-145), on a server built with Quiz's App
 * against the fake GitHub (`./testing.ts`); without a queue the job runs in
 * the owner's request:
 *
 * - the owner's open: the refusals in their order, `403 owner_required` for
 *   an assistant, the 404 of a stranger; audited; the job invites with
 *   `pull` the seats of the repositories that hold their student's work,
 *   nobody else, idempotently;
 * - the close: every grant of the project's repositories revoked, their
 *   state back to `none`, a `free` project's grant of the same student
 *   untouched; a close landing while an invitation is on its way takes it
 *   back;
 * - nothing invites while closed, nor the absent student's own resend;
 * - the deadline guard on every move that would reopen a repository;
 * - the staff's page (the primary action, the counts, "nothing to open")
 *   and the student's view (no invitation before the opening nor after the
 *   close), for each student caller.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { ProjectDetail, ProjectReposAccess, ProjectSummary, StudentProject } from "@quiz/contracts";

import { classrooms, courseStaff, projectRepos, projects, pushReceipts } from "../../db/schema.js";
import {
  accept,
  auditsOf,
  call,
  config,
  connectedClassroom,
  gh,
  grantsOf,
  IN_A_WEEK,
  newStudent,
  NOW,
  on,
  pendingInvitations,
  repoRows,
  seats,
  server,
  staff,
  useGroupWorld,
  type Room,
  type Student,
} from "./groupTesting.js";
import { runReposAccessJob } from "./reposAccess.js";

useGroupWorld();

const HOUR = 3_600_000;
const at = (plusMs: number) => new Date(Date.parse(NOW) + plusMs);
const DEADLINE = at(-2 * HOUR);

/** A published individual project `name` of `room`. */
async function labOf(room: Room, name: string) {
  const created = await staff("POST", `/app/api/classrooms/${room.id}/projects`, { name, sourceRepo: "starter", deadlineAt: IN_A_WEEK });
  expect(created.statusCode, created.body).toBe(201);
  const project = ProjectSummary.parse(created.json());
  const published = await staff("POST", `/app/api/projects/${project.id}/publish`);
  expect(published.statusCode, published.body).toBe(200);
  return project;
}

/**
 * A lab test sat under Safe Exam Browser by Ana (who pushed two commits),
 * Ben (who accepted and never worked: absent) and Cid (whose workspace the
 * platform collected at the deadline), frozen for good, graded and released
 * unless said otherwise. Ana also holds the classroom's `free` lab.
 */
async function sebLab(opts: { gradingMode?: "auto" | "none"; released?: boolean } = {}) {
  const db = server.app.db;
  const [ana, ben, cid] = [await newStudent(), await newStudent(), await newStudent()];
  const room = await connectedClassroom([ana!, ben!, cid!]);
  const free = await labOf(room, "Free lab");
  expect((await accept(free.id, ana!)).statusCode).toBe(200);
  const project = await labOf(room, "Lab test");
  await db.update(projects).set({ workMode: "online_seb", devices: "seb", gradingMode: opts.gradingMode ?? "auto" }).where(eq(projects.id, project.id));
  for (const who of [ana!, ben!, cid!]) {
    const res = await accept(project.id, who);
    expect(res.statusCode, res.body).toBe(200);
  }
  await db
    .update(projects)
    .set({ state: "locked", deadlineAt: DEADLINE, deadlineAppliedAt: DEADLINE, releasedAt: opts.released === false ? null : at(-HOUR) })
    .where(eq(projects.id, project.id));
  await db.update(projectRepos).set({ deadlineAppliedAt: DEADLINE, frozenAt: at(-HOUR) }).where(eq(projectRepos.projectId, project.id));
  const rows = await repoRows(project.id);
  const repoOf = (who: Student) => rows.find((r) => r.userId === who.id)!;
  const receipt = (who: Student, fields: Partial<typeof pushReceipts.$inferInsert>) =>
    db.insert(pushReceipts).values({ id: randomUUID(), githubRepoId: repoOf(who).githubRepoId!, branch: "main", headSha: randomUUID(), receivedAt: at(-3 * HOUR), ...fields });
  await receipt(ana!, { commits: 2 });
  await receipt(cid!, { collected: true, receivedAt: DEADLINE });
  // Ben's repository saw only the App's pushes, and a push of his after the deadline: no work of his.
  await receipt(ben!, { isBot: true, commits: 1 });
  await receipt(ben!, { commits: 1, receivedAt: at(-HOUR) });
  const [{ courseId }] = (await db.select({ courseId: classrooms.courseId }).from(classrooms).where(eq(classrooms.id, room.id))) as [{ courseId: string }];
  return { project, free, room, courseId, ana: ana!, ben: ben!, cid: cid!, repoOf };
}
type Lab = Awaited<ReturnType<typeof sebLab>>;

const detail = async (lab: Lab) => ProjectDetail.parse((await staff("GET", `/app/api/projects/${lab.project.id}`)).json());
const open = (lab: Lab, headers?: Record<string, string>) =>
  headers ? call("POST", `/app/api/projects/${lab.project.id}/repos/open`, headers) : staff("POST", `/app/api/projects/${lab.project.id}/repos/open`);
const close = (lab: Lab) => staff("POST", `/app/api/projects/${lab.project.id}/repos/close`);
const opened = async (lab: Lab) => {
  const res = await open(lab);
  expect(res.statusCode, res.body).toBe(200);
  return ProjectReposAccess.parse(res.json());
};
const refusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, res.json().error];
/** The collaborators and pending invitees of `who`'s repository on GitHub. */
const onGithub = (lab: Lab, who: Student) => ({ seats: seats(lab.repoOf(who).fullName!), pending: pendingInvitations(lab.repoOf(who).fullName!) });
const invites = (before: number) => gh.calls.slice(before).filter((c) => c.startsWith("PUT ") && c.includes("/collaborators/"));

describe("the owner's opening (ADR-145 §1, §3)", () => {
  it("is the primary action once released, counts the repositories and marks the one with nothing to open", async () => {
    const lab = await sebLab();
    const page = await detail(lab);
    expect(page.primaryAction).toBe("open_repos");
    expect(page.reposAccess).toEqual({ openedAt: null, openable: 2, nothingToOpen: 1, sameSource: ["Free lab"] });
    const marks = Object.fromEntries(page.rows.map((r) => [r.student.userId, r.repo?.nothingToOpen]));
    expect(marks).toEqual({ [lab.ana.id]: false, [lab.ben.id]: true, [lab.cid.id]: false });
    // Another mode carries no opening at all.
    expect(ProjectDetail.parse((await staff("GET", `/app/api/projects/${lab.free.id}`)).json()).reposAccess).toBeNull();
  });

  it("invites with pull the students whose repository holds their work, nobody else, and audits it", async () => {
    const lab = await sebLab();
    const before = gh.calls.length;
    const view = await opened(lab);
    expect(view.openedAt).toBe(NOW);
    expect(invites(before)).toHaveLength(2);
    expect(onGithub(lab, lab.ana).pending).toEqual([lab.ana.login]);
    expect(onGithub(lab, lab.cid).pending).toEqual([lab.cid.login]);
    expect(onGithub(lab, lab.ben)).toEqual({ seats: {}, pending: [] });
    for (const who of [lab.ana, lab.cid]) expect(seats(lab.repoOf(who).fullName!)[who.login]).toBe("pull");
    const states = Object.fromEntries((await repoRows(lab.project.id)).map((r) => [r.userId, r.invitationStatus]));
    expect(states).toEqual({ [lab.ana.id]: "pending", [lab.ben.id]: "none", [lab.cid.id]: "pending" });
    const [audit] = await auditsOf(lab.project.id, "project.repos_opened");
    expect(audit?.payload).toEqual({ openable: 2, nothingToOpen: 1 });
    // Once opened, the rule of before: nothing (the source is not ahead), the opened instant said.
    const page = await detail(lab);
    expect(page.primaryAction).toBe("none");
    expect(page.reposAccess?.openedAt).toBe(NOW);
    expect(refusal(await open(lab))).toEqual([409, "repos_already_open"]);
  });

  it("is idempotent: the job run again invites nobody twice", async () => {
    const lab = await sebLab();
    await opened(lab);
    const before = gh.calls.length;
    const [row] = await server.app.db.update(projects).set({ reposAccessJobAt: at(1) }).where(eq(projects.id, lab.project.id)).returning();
    await runReposAccessJob(server.app, config, { projectId: lab.project.id, lease: row!.reposAccessJobAt!.toISOString() });
    expect(invites(before)).toEqual([]);
    expect((await server.app.db.select().from(projects).where(eq(projects.id, lab.project.id)))[0]!.reposAccessJobAt).toBeNull();
  });

  it("refuses in order: not released, nothing to open, another mode, an archive", async () => {
    const lab = await sebLab({ released: false });
    expect(refusal(await open(lab))).toEqual([409, "not_released"]);
    expect((await detail(lab)).primaryAction).not.toBe("open_repos");
    await server.app.db.update(projects).set({ releasedAt: at(-HOUR) }).where(eq(projects.id, lab.project.id));
    await server.app.db.delete(pushReceipts).where(eq(pushReceipts.githubRepoId, lab.repoOf(lab.ana).githubRepoId!));
    await server.app.db.delete(pushReceipts).where(eq(pushReceipts.githubRepoId, lab.repoOf(lab.cid).githubRepoId!));
    expect(refusal(await open(lab))).toEqual([409, "nothing_to_open"]);
    expect(refusal(await staff("POST", `/app/api/projects/${lab.free.id}/repos/open`))).toEqual([409, "not_supervised"]);
    await server.app.db.update(projects).set({ archivedAt: at(-1) }).where(eq(projects.id, lab.project.id));
    expect(refusal(await open(lab))).toEqual([409, "project_archived"]);
    expect(await auditsOf(lab.project.id, "project.repos_opened")).toEqual([]);
  });

  it("opens an ungraded project once every repository is frozen for good", async () => {
    const lab = await sebLab({ gradingMode: "none", released: false });
    await server.app.db.update(projectRepos).set({ frozenAt: null }).where(eq(projectRepos.id, lab.repoOf(lab.ben).id));
    expect(refusal(await open(lab))).toEqual([409, "repos_not_frozen"]);
    await server.app.db.update(projectRepos).set({ frozenAt: at(-HOUR) }).where(eq(projectRepos.id, lab.repoOf(lab.ben).id));
    expect((await detail(lab)).primaryAction).toBe("open_repos");
    expect((await opened(lab)).openable).toBe(2);
  });

  it("is the course owner's: an assistant gets 403 owner_required, a stranger the 404", async () => {
    const lab = await sebLab();
    const assistant = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: lab.courseId, userId: assistant.id, role: "assistant" });
    expect(refusal(await open(lab, assistant.headers))).toEqual([403, "owner_required"]);
    expect((await call("POST", `/app/api/projects/${lab.project.id}/repos/close`, assistant.headers)).statusCode).toBe(403);
    const stranger = await server.signIn("teacher");
    const missing = await call("POST", `/app/api/projects/${randomUUID()}/repos/open`, stranger.headers);
    const hidden = await open(lab, stranger.headers);
    expect([hidden.statusCode, hidden.json()]).toEqual([missing.statusCode, missing.json()]);
    expect(hidden.statusCode).toBe(404);
    expect((await server.app.db.select().from(projects).where(eq(projects.id, lab.project.id)))[0]!.reposOpenedAt).toBeNull();
  });
});

describe("closing the access (ADR-145 §6)", () => {
  it("revokes every grant of the project's repositories, back to none, never the free project's", async () => {
    const lab = await sebLab();
    await opened(lab);
    const freeRepo = (await repoRows(lab.free.id))[0]!;
    const res = await close(lab);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectReposAccess.parse(res.json()).openedAt).toBeNull();
    for (const who of [lab.ana, lab.ben, lab.cid]) expect(onGithub(lab, who)).toEqual({ seats: {}, pending: [] });
    for (const row of await repoRows(lab.project.id)) {
      expect(row.invitationStatus).toBe("none");
      expect((await grantsOf(row.id)).every((g) => g.revokedAt !== null)).toBe(true);
    }
    // The other project of the same student keeps its access.
    expect(seats(freeRepo.fullName!)[lab.ana.login]).toBe("push");
    expect((await grantsOf(freeRepo.id)).every((g) => g.revokedAt === null)).toBe(true);
    const [audit] = await auditsOf(lab.project.id, "project.repos_closed");
    expect(audit?.payload).toEqual({ openedAt: NOW });
    // Opened again: the open is the primary action again, and it invites again.
    expect((await detail(lab)).primaryAction).toBe("open_repos");
    await opened(lab);
    expect(onGithub(lab, lab.ana).pending).toEqual([lab.ana.login]);
  });

  it("is allowed on an archived project, and writes nothing on a project not open", async () => {
    const lab = await sebLab();
    expect((await close(lab)).statusCode).toBe(200);
    expect(await auditsOf(lab.project.id, "project.repos_closed")).toEqual([]);
    await opened(lab);
    await server.app.db.update(projects).set({ archivedAt: at(1) }).where(eq(projects.id, lab.project.id));
    expect((await close(lab)).statusCode).toBe(200);
    expect(onGithub(lab, lab.ana)).toEqual({ seats: {}, pending: [] });
  });

  it("takes back an invitation that lands after the close", async () => {
    const lab = await sebLab();
    const anaRepo = lab.repoOf(lab.ana).fullName!;
    let closed = 0;
    on({
      match: (url, method) => method === "PUT" && url.pathname === `/repos/${anaRepo}/collaborators/${lab.ana.login}`,
      run: async () => {
        closed = (await close(lab)).statusCode;
      },
    });
    await opened(lab);
    expect(closed).toBe(200);
    expect(onGithub(lab, lab.ana)).toEqual({ seats: {}, pending: [] });
    expect(onGithub(lab, lab.cid)).toEqual({ seats: {}, pending: [] });
    expect((await repoRows(lab.project.id)).map((r) => r.invitationStatus)).toEqual(["none", "none", "none"]);
  });
});

describe("nothing invites a student who should not be (ADR-145 §4, §7)", () => {
  const resend = (lab: Lab, who: Student) => call("POST", `/app/api/student/projects/${lab.project.id}/invite`, who.headers);

  it("the absent student's own resend invites nobody, opened or not", async () => {
    const lab = await sebLab();
    await opened(lab);
    const before = gh.calls.length;
    expect(refusal(await resend(lab, lab.ben))).toEqual([409, "invitation_not_pending"]);
    // Even with a pending state on the row, the rule refuses him.
    await server.app.db.update(projectRepos).set({ invitationStatus: "pending" }).where(eq(projectRepos.id, lab.repoOf(lab.ben).id));
    expect(refusal(await resend(lab, lab.ben))).toEqual([409, "not_invitable"]);
    expect(invites(before)).toEqual([]);
  });

  it("nothing invites while closed: no Accept, no resend, no job", async () => {
    const lab = await sebLab();
    const before = gh.calls.length;
    expect((await accept(lab.project.id, lab.ana)).statusCode).toBe(200);
    await server.app.db.update(projectRepos).set({ invitationStatus: "pending" }).where(eq(projectRepos.id, lab.repoOf(lab.ana).id));
    expect(refusal(await resend(lab, lab.ana))).toEqual([409, "not_invitable"]);
    await server.app.db.update(projectRepos).set({ invitationStatus: "none" }).where(eq(projectRepos.id, lab.repoOf(lab.ana).id));
    const [row] = await server.app.db.update(projects).set({ reposAccessJobAt: at(1) }).where(eq(projects.id, lab.project.id)).returning();
    await runReposAccessJob(server.app, config, { projectId: lab.project.id, lease: row!.reposAccessJobAt!.toISOString() });
    expect(invites(before)).toEqual([]);
  });

  it("an opened student's own resend re-invites them with pull", async () => {
    const lab = await sebLab();
    await opened(lab);
    server.clock.set(at(2 * 60_000));
    const res = await resend(lab, lab.ana);
    expect(res.statusCode, res.body).toBe(200);
    expect(seats(lab.repoOf(lab.ana).fullName!)[lab.ana.login]).toBe("pull");
  });
});

describe("the deadline guard (ADR-145 §8)", () => {
  const later = new Date(Date.parse(NOW) + 3 * 24 * HOUR).toISOString();

  it("refuses every move that would reopen a repository while open, and lets it through once closed", async () => {
    const lab = await sebLab();
    await opened(lab);
    const patch = () => staff("PATCH", `/app/api/projects/${lab.project.id}`, { deadlineAt: later });
    expect(refusal(await patch())).toEqual([409, "repos_open"]);
    const own = await staff("PUT", `/app/api/projects/${lab.project.id}/repos/${lab.repoOf(lab.ana).id}/deadline`, { deadlineAt: later });
    expect(refusal(own)).toEqual([409, "repos_open"]);
    const [row] = await server.app.db.select().from(projects).where(eq(projects.id, lab.project.id));
    expect(row!.deadlineAt.toISOString()).toBe(DEADLINE.toISOString());
    const [repo] = await server.app.db.select().from(projectRepos).where(and(eq(projectRepos.id, lab.repoOf(lab.ana).id)));
    expect(repo!.frozenAt).not.toBeNull();
    expect(repo!.deadlineAt).toBeNull();
    await close(lab);
    const res = await patch();
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("the student's view (ADR-145, N-SEC-20)", () => {
  const view = async (lab: Lab, who: Student) => {
    const res = await call("GET", `/app/api/student/projects/${lab.project.id}`, who.headers);
    expect(res.statusCode, res.body).toBe(200);
    return { body: res.body, project: StudentProject.parse(res.json()) };
  };
  /** The lab test's card on the student's classroom page, as served. */
  const card = async (lab: Lab, who: Student) => {
    const res = await call("GET", `/app/api/student/classrooms/${lab.room.id}`, who.headers);
    expect(res.statusCode, res.body).toBe(200);
    const groups = (res.json() as { activities: Record<string, { id: string }[]> }).activities;
    return JSON.stringify(Object.values(groups).flat().find((c) => c.id === lab.project.id));
  };

  it("carries no invitation before the opening nor after the close, the opened student's once open", async () => {
    const lab = await sebLab();
    for (const who of [lab.ana, lab.ben, lab.cid]) {
      const { project, body } = await view(lab, who);
      expect(project.repo?.invitation).toBeNull();
      expect(body).not.toMatch(/"invitation":"(pending|accepted)"/);
      expect(await card(lab, who)).toContain('"invitation":null');
    }
    await opened(lab);
    expect((await view(lab, lab.ana)).project.repo?.invitation).toBe("pending");
    expect(await card(lab, lab.ana)).toContain('"invitation":"pending"');
    expect((await view(lab, lab.cid)).project.repo?.invitation).toBe("pending");
    expect((await view(lab, lab.ben)).project.repo?.invitation).toBeNull();
    await close(lab);
    for (const who of [lab.ana, lab.ben, lab.cid]) {
      const { project, body } = await view(lab, who);
      expect(project.repo?.invitation).toBeNull();
      expect(await card(lab, who)).toContain('"invitation":null');
      expect(body).not.toMatch(/"invitation":"(pending|accepted)"/);
    }
  });
});
