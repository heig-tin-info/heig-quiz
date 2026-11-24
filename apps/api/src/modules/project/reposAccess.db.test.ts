/**
 * An `online_seb` project's repositories opened to their students,
 * read-only, and closed again (ADR-145), on a server built with Quiz's App
 * against the fake GitHub (`./testing.ts`); without a queue the job runs in
 * the owner's request:
 *
 * - the owner's open: the refusals in their order, `403 owner_required` for
 *   an assistant, the 404 of a stranger; audited; the job invites with
 *   `pull` the seats of the repositories that hold their student's work —
 *   a staff seat's test repository included (ADR-077) —, nobody else,
 *   idempotently;
 * - the close: every grant of the project's repositories revoked, their
 *   state back to `none`, a `free` project's grant of the same student
 *   untouched;
 * - convergence: a close or a re-open landing while the job works — the
 *   last pass leaves GitHub and the states as the fact says;
 * - nothing invites while closed, nor the absent student's own resend;
 * - the deadline guard on every move that would reopen a repository;
 * - the staff's page (the primary action, the counts, "nothing to open")
 *   and the student's view — no invitation before the opening nor after the
 *   close, for every student caller: the students, the staff seat in the
 *   student view, an impersonation (ADR-034).
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { ProjectDetail, ProjectSummary, StudentProject } from "@quiz/contracts";

import { classrooms, codespaceCollections, courseStaff, enrollments, projectRepos, projects, pushReceipts } from "../../db/schema.js";
import { sessionOf } from "../../test/http.js";
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
  type Headers,
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
 * Ben (who accepted and never worked: absent), Cid (whose workspace the
 * platform collected at the deadline) and Tess, a staff seat trying it on
 * her test repository (ADR-077), frozen for good, graded and released
 * unless said otherwise. Ana also holds the classroom's `free` lab.
 */
async function sebLab(opts: { gradingMode?: "auto" | "none"; released?: boolean } = {}) {
  const db = server.app.db;
  const [ana, ben, cid, tess] = [await newStudent(), await newStudent(), await newStudent(), await newStudent()];
  const room = await connectedClassroom([ana!, ben!, cid!]);
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId: room.id,
    nom: "Test",
    prenom: "Tess",
    email: `tess-${randomUUID()}@heig.test`,
    userId: tess!.id,
    staff: true,
    claimedAt: at(-48 * HOUR),
  });
  const free = await labOf(room, "Free lab");
  expect((await accept(free.id, ana!)).statusCode).toBe(200);
  const project = await labOf(room, "Lab test");
  await db.update(projects).set({ workMode: "online_seb", devices: "seb", gradingMode: opts.gradingMode ?? "auto" }).where(eq(projects.id, project.id));
  for (const who of [ana!, ben!, cid!, tess!]) {
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
  await receipt(tess!, { commits: 1 });
  // Cid's work reached the repository through the collection of his workspace (ADR-130).
  await db.insert(codespaceCollections).values({ id: randomUUID(), repoId: repoOf(cid!).id, deadlineAt: DEADLINE, claimedAt: DEADLINE, outcome: "collected", settledAt: DEADLINE });
  // Ben's repository saw only the App's pushes, and a push of his after the deadline: no work of his.
  await receipt(ben!, { isBot: true, commits: 1 });
  await receipt(ben!, { commits: 1, receivedAt: at(-HOUR) });
  const [{ courseId }] = (await db.select({ courseId: classrooms.courseId }).from(classrooms).where(eq(classrooms.id, room.id))) as [{ courseId: string }];
  return { project, free, room, courseId, ana: ana!, ben: ben!, cid: cid!, tess: tess!, repoOf };
}
type Lab = Awaited<ReturnType<typeof sebLab>>;

const detail = async (lab: Lab) => ProjectDetail.parse((await staff("GET", `/app/api/projects/${lab.project.id}`)).json());
const write = (lab: Lab, path: "open" | "close", headers?: Headers) =>
  headers ? call("POST", `/app/api/projects/${lab.project.id}/repos/${path}`, headers) : staff("POST", `/app/api/projects/${lab.project.id}/repos/${path}`);
const done = async (res: { statusCode: number; body: string }) => expect(res.statusCode, res.body).toBe(204);
const open = async (lab: Lab) => done(await write(lab, "open"));
const close = async (lab: Lab) => done(await write(lab, "close"));
const refusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, res.json().error];
/** The collaborators and pending invitees of `who`'s repository on GitHub. */
const onGithub = (lab: Lab, who: Student) => ({ seats: seats(lab.repoOf(who).fullName!), pending: pendingInvitations(lab.repoOf(who).fullName!) });
const NOBODY = { seats: {}, pending: [] };
const invites = (before: number) => gh.calls.slice(before).filter((c) => c.startsWith("PUT ") && c.includes("/collaborators/"));
const states = async (lab: Lab) => Object.fromEntries((await repoRows(lab.project.id)).map((r) => [r.userId, r.invitationStatus]));
/** The fact and the lease, as stored. */
const stored = async (lab: Lab) => (await server.app.db.select().from(projects).where(eq(projects.id, lab.project.id)))[0]!;
/** The job run by hand on a fresh lease, as the ticker would claim it. */
async function runJob(lab: Lab) {
  const [row] = await server.app.db.update(projects).set({ reposAccessJobAt: at(1) }).where(eq(projects.id, lab.project.id)).returning();
  await runReposAccessJob(server.app, config, { projectId: lab.project.id, lease: row!.reposAccessJobAt!.toISOString() });
}

describe("the owner's opening (ADR-145 §1, §3)", () => {
  it("is the primary action once released, counts the student repositories and marks the one with nothing to open", async () => {
    const lab = await sebLab();
    const page = await detail(lab);
    expect(page.primaryAction).toBe("open_repos");
    // Tess's test repository is counted nowhere (ADR-077).
    expect(page.reposAccess).toEqual({ openedAt: null, openable: 2, nothingToOpen: 1, sameSource: ["Free lab"] });
    const marks = Object.fromEntries(page.rows.map((r) => [r.student.userId, r.repo?.nothingToOpen]));
    expect(marks).toEqual({ [lab.ana.id]: false, [lab.ben.id]: true, [lab.cid.id]: false, [lab.tess.id]: false });
    // Another mode carries no opening at all.
    expect(ProjectDetail.parse((await staff("GET", `/app/api/projects/${lab.free.id}`)).json()).reposAccess).toBeNull();
  });

  it("invites with pull the seats whose repository holds their work, the staff's test repository too, nobody else, and audits it", async () => {
    const lab = await sebLab();
    const before = gh.calls.length;
    await open(lab);
    expect(invites(before)).toHaveLength(3);
    for (const who of [lab.ana, lab.cid, lab.tess]) {
      expect(onGithub(lab, who).pending).toEqual([who.login]);
      expect(seats(lab.repoOf(who).fullName!)[who.login]).toBe("pull");
    }
    expect(onGithub(lab, lab.ben)).toEqual(NOBODY);
    expect(await states(lab)).toEqual({ [lab.ana.id]: "pending", [lab.ben.id]: "none", [lab.cid.id]: "pending", [lab.tess.id]: "pending" });
    const [audit] = await auditsOf(lab.project.id, "project.repos_opened");
    expect(audit?.payload).toEqual({ openable: 2, nothingToOpen: 1 });
    expect((await stored(lab)).reposAccessJobAt).toBeNull();
    // Once opened, the rule of before: nothing (the source is not ahead), the opened instant said.
    const page = await detail(lab);
    expect(page.primaryAction).toBe("none");
    expect(page.reposAccess?.openedAt).toBe(NOW);
    // Opening what is open writes nothing, invites nobody again.
    const again = gh.calls.length;
    await open(lab);
    expect(await auditsOf(lab.project.id, "project.repos_opened")).toHaveLength(1);
    expect(invites(again)).toEqual([]);
  });

  it("is idempotent: the job run again invites nobody twice", async () => {
    const lab = await sebLab();
    await open(lab);
    const before = gh.calls.length;
    await runJob(lab);
    expect(invites(before)).toEqual([]);
    expect((await stored(lab)).reposAccessJobAt).toBeNull();
  });

  it("refuses in order: not released, a repository not frozen for good, nothing to open, another mode, an archive", async () => {
    const lab = await sebLab({ released: false });
    expect(refusal(await write(lab, "open"))).toEqual([409, "not_released"]);
    expect((await detail(lab)).primaryAction).not.toBe("open_repos");
    await server.app.db.update(projects).set({ releasedAt: at(-HOUR) }).where(eq(projects.id, lab.project.id));
    // A make-up: Ben's repository given a later deadline of its own after the release, not frozen any more.
    await server.app.db.update(projectRepos).set({ frozenAt: null, deadlineAppliedAt: null, deadlineAt: at(HOUR) }).where(eq(projectRepos.id, lab.repoOf(lab.ben).id));
    expect(refusal(await write(lab, "open"))).toEqual([409, "repos_not_frozen"]);
    expect((await detail(lab)).primaryAction).not.toBe("open_repos");
    await server.app.db.update(projectRepos).set({ frozenAt: at(-HOUR), deadlineAppliedAt: DEADLINE, deadlineAt: null }).where(eq(projectRepos.id, lab.repoOf(lab.ben).id));
    await server.app.db.delete(pushReceipts).where(eq(pushReceipts.githubRepoId, lab.repoOf(lab.ana).githubRepoId!));
    await server.app.db.delete(codespaceCollections).where(eq(codespaceCollections.repoId, lab.repoOf(lab.cid).id));
    expect(refusal(await write(lab, "open"))).toEqual([409, "nothing_to_open"]);
    expect(refusal(await staff("POST", `/app/api/projects/${lab.free.id}/repos/open`))).toEqual([409, "not_supervised"]);
    await server.app.db.update(projects).set({ archivedAt: at(-1) }).where(eq(projects.id, lab.project.id));
    expect(refusal(await write(lab, "open"))).toEqual([409, "project_archived"]);
    expect(await auditsOf(lab.project.id, "project.repos_opened")).toEqual([]);
  });

  it("opens an ungraded project once every repository is frozen for good", async () => {
    const lab = await sebLab({ gradingMode: "none", released: false });
    await server.app.db.update(projectRepos).set({ frozenAt: null }).where(eq(projectRepos.id, lab.repoOf(lab.ben).id));
    expect(refusal(await write(lab, "open"))).toEqual([409, "repos_not_frozen"]);
    await server.app.db.update(projectRepos).set({ frozenAt: at(-HOUR) }).where(eq(projectRepos.id, lab.repoOf(lab.ben).id));
    expect((await detail(lab)).primaryAction).toBe("open_repos");
    await open(lab);
    expect((await detail(lab)).reposAccess?.openable).toBe(2);
  });

  it("is the course owner's: an assistant gets 403 owner_required, a stranger the 404", async () => {
    const lab = await sebLab();
    const assistant = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: lab.courseId, userId: assistant.id, role: "assistant" });
    expect(refusal(await write(lab, "open", assistant.headers))).toEqual([403, "owner_required"]);
    expect((await write(lab, "close", assistant.headers)).statusCode).toBe(403);
    const stranger = await server.signIn("teacher");
    const missing = await call("POST", `/app/api/projects/${randomUUID()}/repos/open`, stranger.headers);
    const hidden = await write(lab, "open", stranger.headers);
    expect([hidden.statusCode, hidden.json()]).toEqual([missing.statusCode, missing.json()]);
    expect(hidden.statusCode).toBe(404);
    expect((await stored(lab)).reposOpenedAt).toBeNull();
  });
});

describe("closing the access (ADR-145 §6)", () => {
  it("revokes every grant of the project's repositories, back to none, never the free project's", async () => {
    const lab = await sebLab();
    await open(lab);
    const freeRepo = (await repoRows(lab.free.id))[0]!;
    await close(lab);
    expect((await stored(lab)).reposOpenedAt).toBeNull();
    for (const who of [lab.ana, lab.ben, lab.cid, lab.tess]) expect(onGithub(lab, who)).toEqual(NOBODY);
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
    await open(lab);
    expect(onGithub(lab, lab.ana).pending).toEqual([lab.ana.login]);
  });

  it("never touches a project that is not open: no lease, no job, its grants kept", async () => {
    const lab = await sebLab();
    const freeRepo = (await repoRows(lab.free.id))[0]!;
    const sebGrants = async () => (await Promise.all((await repoRows(lab.project.id)).map((r) => grantsOf(r.id)))).flat();
    const live = (await sebGrants()).filter((g) => g.revokedAt === null).length;
    expect(live).toBeGreaterThan(0);
    const before = gh.calls.length;
    // The `free` lab: Ana keeps her push.
    await done(await staff("POST", `/app/api/projects/${lab.free.id}/repos/close`));
    expect(seats(freeRepo.fullName!)[lab.ana.login]).toBe("push");
    expect((await grantsOf(freeRepo.id)).every((g) => g.revokedAt === null)).toBe(true);
    expect((await server.app.db.select().from(projects).where(eq(projects.id, lab.free.id)))[0]!.reposAccessJobAt).toBeNull();
    // The SEB lab never opened: the grants its Accepts recorded stay as they are.
    await close(lab);
    expect((await sebGrants()).filter((g) => g.revokedAt === null)).toHaveLength(live);
    expect((await stored(lab)).reposAccessJobAt).toBeNull();
    expect(gh.calls.slice(before).filter((c) => c.startsWith("DELETE "))).toEqual([]);
    // A lease a ticker claims on another mode's project: the job gives it back, touching nothing.
    const [row] = await server.app.db.update(projects).set({ reposAccessJobAt: at(1) }).where(eq(projects.id, lab.free.id)).returning();
    await runReposAccessJob(server.app, config, { projectId: lab.free.id, lease: row!.reposAccessJobAt!.toISOString() });
    expect(seats(freeRepo.fullName!)[lab.ana.login]).toBe("push");
    expect((await server.app.db.select().from(projects).where(eq(projects.id, lab.free.id)))[0]!.reposAccessJobAt).toBeNull();
  });

  it("is allowed on an archived project, and writes nothing on a project not open", async () => {
    const lab = await sebLab();
    await close(lab);
    expect(await auditsOf(lab.project.id, "project.repos_closed")).toEqual([]);
    await open(lab);
    await server.app.db.update(projects).set({ archivedAt: at(1) }).where(eq(projects.id, lab.project.id));
    await close(lab);
    expect(onGithub(lab, lab.ana)).toEqual(NOBODY);
  });

  it("writes the lease with the fact: a crashed job leaves it to the ticker, never a close lost", async () => {
    const lab = await sebLab();
    await open(lab);
    // A job of the open still holds a fresh lease (a crash, say): the close writes the fact, leaves the lease, sends nothing.
    await server.app.db.update(projects).set({ reposAccessJobAt: at(0) }).where(eq(projects.id, lab.project.id));
    await close(lab);
    expect((await stored(lab)).reposOpenedAt).toBeNull();
    expect(onGithub(lab, lab.ana).pending).toEqual([lab.ana.login]);
    // The ticker's claim, the lease expired: the revocations follow.
    await runJob(lab);
    for (const who of [lab.ana, lab.cid, lab.tess]) expect(onGithub(lab, who)).toEqual(NOBODY);
    expect(Object.values(await states(lab))).toEqual(["none", "none", "none", "none"]);
  });
});

describe("convergence whatever lands while the job works (ADR-145)", () => {
  it("a close landing while an invitation is on its way: nothing open at the end, every state none", async () => {
    const lab = await sebLab();
    const anaRepo = lab.repoOf(lab.ana).fullName!;
    let closed = 0;
    on({
      match: (url, method) => method === "PUT" && url.pathname === `/repos/${anaRepo}/collaborators/${lab.ana.login}`,
      run: async () => {
        closed = (await write(lab, "close")).statusCode;
      },
    });
    await open(lab);
    expect(closed).toBe(204);
    for (const who of [lab.ana, lab.ben, lab.cid, lab.tess]) expect(onGithub(lab, who)).toEqual(NOBODY);
    expect(Object.values(await states(lab))).toEqual(["none", "none", "none", "none"]);
    expect((await stored(lab)).reposAccessJobAt).toBeNull();
  });

  it("a re-open landing while a close is revoking: everyone with work invited at the end, as the fact says", async () => {
    const lab = await sebLab();
    await open(lab);
    const anaRepo = lab.repoOf(lab.ana).fullName!;
    let reopened = 0;
    on({
      match: (url, method) => method === "DELETE" && url.pathname === `/repos/${anaRepo}/collaborators/${lab.ana.login}`,
      run: async () => {
        reopened = (await write(lab, "open")).statusCode;
      },
    });
    await close(lab);
    expect(reopened).toBe(204);
    expect((await stored(lab)).reposOpenedAt).not.toBeNull();
    for (const who of [lab.ana, lab.cid, lab.tess]) expect(onGithub(lab, who).pending).toEqual([who.login]);
    expect(onGithub(lab, lab.ben)).toEqual(NOBODY);
    expect(await states(lab)).toEqual({ [lab.ana.id]: "pending", [lab.ben.id]: "none", [lab.cid.id]: "pending", [lab.tess.id]: "pending" });
    for (const who of [lab.ana, lab.cid, lab.tess]) {
      expect((await grantsOf(lab.repoOf(who).id)).some((g) => g.revokedAt === null && g.revokingAt === null)).toBe(true);
    }
    expect((await stored(lab)).reposAccessJobAt).toBeNull();
  });

  /** Everything the close took away, and the lease given back. */
  const closedForGood = async (lab: Lab) => {
    for (const who of [lab.ana, lab.ben, lab.cid, lab.tess]) expect(onGithub(lab, who)).toEqual(NOBODY);
    expect(Object.values(await states(lab))).toEqual(["none", "none", "none", "none"]);
    for (const row of await repoRows(lab.project.id)) expect((await grantsOf(row.id)).every((g) => g.revokedAt !== null)).toBe(true);
    expect((await stored(lab)).reposAccessJobAt).toBeNull();
  };
  /** The close job's revocation of Ana, `during` it — before GitHub hears of it. */
  const duringAnasRevocation = (lab: Lab, during: () => Promise<void>) =>
    on({
      match: (url, method) => method === "DELETE" && url.pathname === `/repos/${lab.repoOf(lab.ana).fullName!}/collaborators/${lab.ana.login}`,
      run: during,
    });

  it("a re-open then a close again while a close is revoking: a new revision, every access gone at the end", async () => {
    const lab = await sebLab();
    await open(lab);
    duringAnasRevocation(lab, async () => {
      await open(lab);
      await close(lab);
    });
    await close(lab);
    expect((await stored(lab)).reposOpenedAt).toBeNull();
    expect((await stored(lab)).reposAccessRev).toBe(4);
    await closedForGood(lab);
  });

  it("a grant re-recorded in an open window, by a resend, is revoked by the next pass", async () => {
    const lab = await sebLab();
    await open(lab);
    let resent = 0;
    duringAnasRevocation(lab, async () => {
      await open(lab);
      resent = (await staff("POST", `/app/api/projects/${lab.project.id}/repos/${lab.repoOf(lab.ana).id}/invite`)).statusCode;
      await close(lab);
    });
    await close(lab);
    expect(resent).toBe(200);
    await closedForGood(lab);
  });
});

describe("nothing invites a student who should not be (ADR-145 §4, §7)", () => {
  const resend = (lab: Lab, who: Student) => call("POST", `/app/api/student/projects/${lab.project.id}/invite`, who.headers);

  it("the absent student's own resend invites nobody, opened or not", async () => {
    const lab = await sebLab();
    await open(lab);
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
    await runJob(lab);
    expect(invites(before)).toEqual([]);
  });

  it("nothing invites once the classroom is archived, opened or not", async () => {
    const lab = await sebLab();
    await open(lab);
    await server.app.db.update(classrooms).set({ archivedAt: at(1) }).where(eq(classrooms.id, lab.room.id));
    server.clock.set(at(2 * 60_000));
    // The student reaches the archived classroom's project no more (a 404); the staff's resend is refused.
    expect((await resend(lab, lab.ana)).statusCode).toBe(404);
    const before = gh.calls.length;
    expect(refusal(await staff("POST", `/app/api/projects/${lab.project.id}/repos/${lab.repoOf(lab.ana).id}/invite`))).toEqual([409, "not_invitable"]);
    expect(invites(before)).toEqual([]);
  });

  it("an opened student's own resend re-invites them with pull", async () => {
    const lab = await sebLab();
    await open(lab);
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
    await open(lab);
    const patch = () => staff("PATCH", `/app/api/projects/${lab.project.id}`, { deadlineAt: later });
    expect(refusal(await patch())).toEqual([409, "repos_open"]);
    const own = await staff("PUT", `/app/api/projects/${lab.project.id}/repos/${lab.repoOf(lab.ana).id}/deadline`, { deadlineAt: later });
    expect(refusal(own)).toEqual([409, "repos_open"]);
    expect((await stored(lab)).deadlineAt.toISOString()).toBe(DEADLINE.toISOString());
    const [repo] = await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, lab.repoOf(lab.ana).id));
    expect(repo!.frozenAt).not.toBeNull();
    expect(repo!.deadlineAt).toBeNull();
    await close(lab);
    const res = await patch();
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("the student's view (ADR-145, N-SEC-20)", () => {
  /** The lab test's page and its card on the classroom page, as served to `headers`. */
  const served = async (lab: Lab, headers: Headers) => {
    const page = await call("GET", `/app/api/student/projects/${lab.project.id}`, headers);
    expect(page.statusCode, page.body).toBe(200);
    const room = await call("GET", `/app/api/student/classrooms/${lab.room.id}`, headers);
    expect(room.statusCode, room.body).toBe(200);
    const groups = (room.json() as { activities: Record<string, { id: string }[]> }).activities;
    return { project: StudentProject.parse(page.json()), body: page.body, card: JSON.stringify(Object.values(groups).flat().find((c) => c.id === lab.project.id)) };
  };
  const callers = async (lab: Lab) => {
    const admin = await server.signIn("admin");
    const impersonation = await sessionOf(server.app.db, lab.ana.id, { kind: "impersonation", actorUserId: admin.id });
    return { ana: lab.ana.headers, ben: lab.ben.headers, cid: lab.cid.headers, tess: lab.tess.headers, impersonation };
  };
  const noInvitation = async (lab: Lab, who: Record<string, Headers>) => {
    for (const [name, headers] of Object.entries(who)) {
      const { project, body, card } = await served(lab, headers);
      expect(project.repo?.invitation ?? null, name).toBeNull();
      expect(body, name).not.toMatch(/"invitation":"(pending|accepted)"/);
      expect(card, name).not.toMatch(/"invitation":"(pending|accepted)"/);
    }
  };

  it("carries no invitation before the opening nor after the close, for every student caller; the opened one's once open", async () => {
    const lab = await sebLab();
    const who = await callers(lab);
    await noInvitation(lab, who);
    await open(lab);
    for (const name of ["ana", "cid", "tess", "impersonation"] as const) {
      const { project, card } = await served(lab, who[name]);
      expect(project.repo?.invitation, name).toBe("pending");
      expect(card, name).toContain('"invitation":"pending"');
    }
    expect((await served(lab, who.ben)).project.repo?.invitation).toBeNull();
    await close(lab);
    await noInvitation(lab, who);
  });
});
