/**
 * The online workspace collected at the deadline (ADR-130), through the
 * deadline job, against the fake GitHub's bare repositories and a stub
 * portal that does what the real one does: a throwaway commit of the
 * workspace's tree on the base, pushed to the temporary ref Quiz named.
 * Then what the student reads of it (§7, invariant 4): the instant alone,
 * through the student view, for each of its readers, searched for in every
 * response; null for any other outcome and for an earlier deadline's.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectDetail, ProjectSummary, StudentClassroomPage, StudentHome, StudentProject, workspaceStartPath } from "@quiz/contracts";
import { GRADING_WORKFLOW_PATH, collectionRef } from "@quiz/domain";

import { loadConfig } from "../../config.js";
import { auditLog, codespaceCollections, codespaceLaunches, codespaceRelays, enrollments, projectGroups, projectRepos, pushReceipts, teacherGrants, webhookDeliveries } from "../../db/schema.js";
import { json, orgsRoute, signedDelivery, type Route } from "../../github/testing.js";
import { PROJECT_DEADLINE_QUEUE, type JobQueue } from "../../jobs.js";
import { sessionOf } from "../../test/http.js";
import { kioskSession } from "../../test/kiosk.js";
import { APP_ENV, call, newStudent, server, useProjectWorld, usersRoute, world, type Headers } from "../../test/projectWorld.js";
import { studentHome as activityHome } from "../activity/service.js";
import { CODESPACE_ENV, connectedClassroom, fakePortal, scopedMint, workModeBody } from "../codespace/testing.js";
import { pushAuthor } from "../github/service.js";
import { isEligible } from "./grading.js";
import { projectTick, runDeadlineJob } from "./jobs.js";
import type { ProjectJob } from "./lease.js";
import { repoContext } from "./repos.js";
import { lastStudentPush } from "./review.js";
import { GITHUB_COMMITTER } from "./testing.js";

const HOOK_SECRET = "w".repeat(40);
// The mock attestor and projects at stations: a station's `kiosk` session reads the student view (ADR-089).
const ENV = { GITHUB_WEBHOOK_SECRET: HOOK_SECRET, ...CODESPACE_ENV, KIOSK_ATTESTATION: "mock", KIOSK_PROJECTS: "1" };
const config = loadConfig({ NODE_ENV: "test", ...APP_ENV, ...ENV });
const APP_BOT = "quiz-test[bot]";
const NOW = "2026-11-10T08:00:00.000Z";
const DEADLINE = "2026-11-16T13:40:00.000Z";
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);

const portal = fakePortal();
const mint = scopedMint();
/** A test's hand on GitHub, before the fake answers (a failing move, a truncated tree). */
let intercept: Route | null = null;
const interceptRoute: Route = (url, req) => intercept?.(url, req);
useProjectWorld({ routes: [interceptRoute, mint.route, orgsRoute(() => []), usersRoute, world.route], env: ENV, fetch: portal.fetch, teacher: false });

let owner: { id: string; headers: Headers };
beforeAll(async () => {
  const email = `t-${randomUUID().slice(0, 8)}@heig.test`;
  owner = await server.signIn("teacher", email);
  await server.app.db.insert(teacherGrants).values({ id: randomUUID(), email, createdBy: owner.id, codespaceEnabled: true, codespaceMaxActiveSessions: 5 });
});
beforeEach(() => {
  server.clock.set(NOW);
  world.allowPushes();
  portal.collect = 404;
  intercept = null;
  portal.calls.length = 0;
});

/** A student who accepted and launched the workspace of a fresh `online` project (or of `mode`), its handout in `main`. */
async function launched(strategy: "lock" | "commit" = "lock", others: { id: string }[] = [], body: Record<string, unknown> = {}, mode = "online") {
  const student = await newStudent();
  const room = await connectedClassroom(owner, [student, ...others], { prefix: "corg", files: { "README.md": "# Lab", "main.c": "int main(){return 1;}\n", [GRADING_WORKFLOW_PATH]: "grade: v1" } });
  const created = await call("POST", `/app/api/classrooms/${room.classroomId}/projects`, owner.headers, {
    name: `Lab ${randomUUID().slice(0, 6)}`,
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
    protectedFiles: [GRADING_WORKFLOW_PATH],
    deadlineStrategy: strategy,
    ...body,
  });
  expect(created.statusCode, created.body).toBe(201);
  const project = ProjectSummary.parse(created.json());
  expect((await call("POST", `/app/api/projects/${project.id}/publish`, owner.headers)).statusCode).toBe(200);
  expect((await call("PUT", `/app/api/projects/${project.id}/workspace/mode`, owner.headers, workModeBody(mode))).statusCode).toBe(200);
  expect((await call("POST", `/app/api/student/projects/${project.id}/accept`, student.headers)).statusCode).toBe(200);
  expect((await call("POST", workspaceStartPath(project.id), student.headers)).statusCode).toBe(200);
  const [repo] = await server.app.db.select().from(projectRepos).where(and(eq(projectRepos.projectId, project.id), eq(projectRepos.userId, student.id)));
  return { student, project, repo: repo!, fullName: repo!.fullName!, base: world.git(repo!.fullName!, "rev-parse", "main").trim() };
}
type Fixture = Awaited<ReturnType<typeof launched>>;

/** The portal: the workspace's files over the base, pushed as a throwaway commit to the order's ref. */
function portalPushes(f: Fixture, files: Record<string, string | null>, also?: () => void) {
  portal.collect = (order) => {
    const scratch = `scratch-${randomUUID().slice(0, 8)}`;
    world.git(f.fullName, "branch", scratch, order["base"] as string);
    const sha = world.commit(f.fullName, scratch, files);
    world.git(f.fullName, "update-ref", order["ref"] as string, sha);
    world.git(f.fullName, "branch", "-D", scratch);
    also?.();
    return { outcome: "pushed", tree: world.git(f.fullName, "rev-parse", `${sha}^{tree}`).trim(), snapshotAt: DEADLINE, unreadable: 0 };
  };
}

/** One tick at `when` with a queue in place, then the deadline jobs it sent. */
async function deadlineAt(when: Date): Promise<void> {
  server.clock.set(when);
  const sent: ProjectJob[] = [];
  const queue: JobQueue = {
    createQueue: async () => {},
    send: async (name, data) => void (name === PROJECT_DEADLINE_QUEUE && sent.push(data as ProjectJob)),
    work: async () => {},
    stop: async () => {},
  };
  const app = server.app as { boss?: JobQueue };
  app.boss = queue;
  try {
    await projectTick(server.app, config);
  } finally {
    delete app.boss;
  }
  for (const job of sent) await runDeadlineJob(server.app, config, job);
}

/** A push on `main` by the student (or with `committer`), received `offsetMs` from the deadline: its commit and its receipt. */
async function pushed(f: Fixture, files: Record<string, string>, offsetMs: number, committer?: { name: string; email: string }): Promise<string> {
  const sha = world.commit(f.fullName, "main", files, committer && { committer });
  await server.app.db
    .insert(pushReceipts)
    .values({ id: randomUUID(), githubRepoId: f.repo.githubRepoId!, branch: "main", headSha: sha, receivedAt: at(DEADLINE, offsetMs), isBot: false });
  return sha;
}
/** The portal declared `sha` before relaying it (ADR-078 §6). */
const relayedHere = (f: Fixture, sha: string) =>
  server.app.db.insert(codespaceRelays).values({ githubRepoId: f.repo.githubRepoId!, sha, ref: "refs/heads/main", userId: f.student.id, declaredAt: new Date(NOW) });
const rowsOf = async (f: Fixture) => server.app.db.select().from(codespaceCollections).where(eq(codespaceCollections.repoId, f.repo.id));
const repoRow = async (f: Fixture) => (await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, f.repo.id)))[0]!;
const refExists = (f: Fixture, ref: string) => {
  try {
    world.git(f.fullName, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};
const collectionOrders = () => portal.calls.filter((c) => c.method === "POST" && c.path.endsWith("/collections"));

describe("the deadline job collects an online workspace (ADR-130)", () => {
  it("collects, signs on the base, counts it on time, then locks; the temporary ref is gone", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "int main(){return 0;}\n" });
    await deadlineAt(at(DEADLINE, 20_000));

    const [row] = await rowsOf(f);
    expect(row).toMatchObject({ outcome: "collected", branch: "main", reason: null, unreadable: 0 });
    const head = world.git(f.fullName, "rev-parse", "main").trim();
    expect(row!.sha).toBe(head);
    expect(world.git(f.fullName, "rev-parse", `${head}^`).trim()).toBe(f.base);
    expect(world.read(f.fullName, "main", "main.c")).toBe("int main(){return 0;}\n");
    // No identity given: GitHub signs it for the App (#917).
    expect(world.apiCommits.at(-1)?.body).not.toHaveProperty("author");
    const [receipt] = await server.app.db.select().from(pushReceipts).where(eq(pushReceipts.headSha, head));
    expect(receipt).toMatchObject({ collected: true, isBot: false, branch: "main" });
    expect(receipt!.receivedAt.toISOString()).toBe(DEADLINE);
    expect((await lastStudentPush(server.app.db, f.repo.githubRepoId!, ["main"], new Date(DEADLINE)))?.sha).toBe(head);
    expect((await repoRow(f)).lockedAt).not.toBeNull();
    expect(refExists(f, collectionRef(f.repo.id, new Date(DEADLINE)))).toBe(false);
    // The order carried the protected files as stored; the portal adds the workflows itself.
    expect(collectionOrders()[0]?.body).toMatchObject({ base: f.base, target: null, keep: [GRADING_WORKFLOW_PATH], userId: f.student.id });
    const audits = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "project_repo.workspace_collected"), eq(auditLog.subjectId, f.repo.id)));
    expect(audits).toHaveLength(1);
    const [enforced] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "project.deadline_enforced"), eq(auditLog.subjectId, f.project.id)));
    expect(enforced?.payload).toMatchObject({ collected: 1, locked: 1 });

    // The staff's row says so.
    const detail = ProjectDetail.parse((await call("GET", `/app/api/projects/${f.project.id}`, owner.headers)).json());
    const shown = detail.rows.map((r) => r.repo).find((r) => r?.id === f.repo.id);
    expect(shown?.collection).toMatchObject({ outcome: "collected", deadlineAt: DEADLINE, sha: head });
  });

  it("reads the collection's push as the student's work, eligible, and never lets the intake set `collected`", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "collected\n" });
    await deadlineAt(at(DEADLINE, 20_000));
    const head = world.git(f.fullName, "rev-parse", "main").trim();
    expect(await pushAuthor(server.app.db, config, { senderLogin: APP_BOT, githubRepoId: f.repo.githubRepoId!, after: head })).toBe("collection");
    const ctx = (await repoContext(server.app.db, f.repo.githubRepoId!))!;
    expect(await isEligible(server.app.db, ctx, { headBranch: "main", headSha: head, event: "push", path: GRADING_WORKFLOW_PATH })).toBe(true);

    // The webhook of that push, and an App push of another head: neither moves nor sets a receipt's `collected`.
    const other = world.commit(f.fullName, "main", { "notes.md": "x" });
    for (const after of [head, other]) {
      const id = randomUUID();
      const res = await signedDelivery(
        server.app,
        HOOK_SECRET,
        { ref: "refs/heads/main", before: f.base, after, forced: false, repository: { id: f.repo.githubRepoId, full_name: f.fullName }, sender: { login: APP_BOT }, commits: [] },
        { event: "push", id },
      );
      expect(res.statusCode).toBe(200);
      await vi.waitFor(async () => {
        const [d] = await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
        expect(d?.processedAt).not.toBeNull();
      });
    }
    const receipts = await server.app.db.select().from(pushReceipts).where(eq(pushReceipts.githubRepoId, f.repo.githubRepoId!));
    expect(receipts.find((r) => r.headSha === head)).toMatchObject({ collected: true, receivedAt: new Date(DEADLINE) });
    expect(receipts.find((r) => r.headSha === other)).toMatchObject({ collected: false, isBot: true });
  });

  it("keeps a student's own late push late, and the collection the target even at the same instant", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "at the deadline\n" });
    await deadlineAt(at(DEADLINE, 20_000));
    const head = world.git(f.fullName, "rev-parse", "main").trim();
    const db = server.app.db;
    await db.insert(pushReceipts).values([
      { id: randomUUID(), githubRepoId: f.repo.githubRepoId!, branch: "main", headSha: "a".repeat(40), receivedAt: new Date(DEADLINE), isBot: false },
      { id: randomUUID(), githubRepoId: f.repo.githubRepoId!, branch: "main", headSha: "b".repeat(40), receivedAt: at(DEADLINE, 5_000), isBot: false },
    ]);
    expect((await lastStudentPush(db, f.repo.githubRepoId!, ["main"], new Date(DEADLINE)))?.sha).toBe(head);
  });

  it("records an unchanged workspace, makes no commit, and locks", async () => {
    const f = await launched();
    portal.collect = () => ({ outcome: "unchanged", snapshotAt: DEADLINE, unreadable: 3 });
    const commits = world.apiCommits.length;
    await deadlineAt(at(DEADLINE, 20_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "unchanged", reason: null, unreadable: 3 }]);
    expect(world.apiCommits.length).toBe(commits);
    expect(world.git(f.fullName, "rev-parse", "main").trim()).toBe(f.base);
    expect((await repoRow(f)).lockedAt).not.toBeNull();
  });

  it("records each failure, the portal's timeout and an unreachable portal, and locks regardless", async () => {
    for (const [answer, reason] of [
      [() => ({ outcome: "failed", reason: "timeout" }), "timeout"],
      [() => ({ outcome: "failed", reason: "push_rejected" }), "push_rejected"],
      [503, "portal_unavailable"],
      [() => ({ outcome: "nonsense" }), "portal_unavailable"],
    ] as const) {
      server.clock.set(NOW);
      const f = await launched();
      portal.collect = answer as typeof portal.collect;
      await deadlineAt(at(DEADLINE, 20_000));
      expect(await rowsOf(f), reason).toMatchObject([{ outcome: "failed", reason }]);
      expect((await repoRow(f)).lockedAt, reason).not.toBeNull();
      expect(refExists(f, collectionRef(f.repo.id, new Date(DEADLINE)))).toBe(false);
    }
  });

  it("deletes the temporary ref after a failed order too, a push the portal's budget cut having landed", async () => {
    const f = await launched();
    const ref = collectionRef(f.repo.id, new Date(DEADLINE));
    portal.collect = (order) => {
      world.git(f.fullName, "update-ref", order["ref"] as string, f.base);
      return { outcome: "failed", reason: "timeout" };
    };
    await deadlineAt(at(DEADLINE, 20_000));
    expect(refExists(f, ref)).toBe(false);
  });

  it("orders nothing past 120 s after the deadline: too_late, then the lock", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "late\n" });
    await deadlineAt(at(DEADLINE, 121_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "too_late" }]);
    expect(collectionOrders()).toEqual([]);
    expect((await repoRow(f)).lockedAt).not.toBeNull();
  });

  it("refuses to sign a tree whose kept entries are not the base's", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "ok\n", [GRADING_WORKFLOW_PATH]: "grade: tampered" });
    const commits = world.apiCommits.length;
    await deadlineAt(at(DEADLINE, 20_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "failed", reason: "check_refused" }]);
    expect(world.apiCommits.length).toBe(commits);
    expect(world.git(f.fullName, "rev-parse", "main").trim()).toBe(f.base);
  });

  it("signs the same tree on the new head when a late push moved it (the 422), the late push staying late", async () => {
    const f = await launched();
    let late = "";
    portalPushes(f, { "main.c": "workspace\n" }, () => {
      late = world.commit(f.fullName, "main", { "late.txt": "pushed late\n" });
    });
    await deadlineAt(at(DEADLINE, 20_000));
    const head = world.git(f.fullName, "rev-parse", "main").trim();
    expect(await rowsOf(f)).toMatchObject([{ outcome: "collected", sha: head }]);
    expect(world.git(f.fullName, "rev-parse", `${head}^`).trim()).toBe(late);
    // Only the commit that reached the branch keeps a collected receipt.
    const collected = await server.app.db.select().from(pushReceipts).where(and(eq(pushReceipts.githubRepoId, f.repo.githubRepoId!), eq(pushReceipts.collected, true)));
    expect(collected.map((r) => r.headSha)).toEqual([head]);
  });

  it("is ordered once per deadline, and again after an extension at the new one", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "first\n" });
    await deadlineAt(at(DEADLINE, 20_000));
    // Unlocked by the staff, the repository is open again: its collection stays the one recorded.
    expect((await call("POST", `/app/api/projects/${f.project.id}/repos/${f.repo.id}/unlock`, owner.headers)).statusCode).toBeLessThan(300);
    await deadlineAt(at(DEADLINE, 40_000));
    expect(collectionOrders()).toHaveLength(1);

    const later = at(DEADLINE, 3_600_000).toISOString();
    expect((await call("PUT", `/app/api/projects/${f.project.id}/repos/${f.repo.id}/deadline`, owner.headers, { deadlineAt: later })).statusCode).toBe(200);
    portalPushes(f, { "main.c": "second\n" });
    await deadlineAt(at(later, 20_000));
    const rows = await rowsOf(f);
    expect(rows.map((r) => [r.deadlineAt.toISOString(), r.outcome]).sort()).toEqual([
      [DEADLINE, "collected"],
      [later, "collected"],
    ]);
    expect(world.read(f.fullName, "main", "main.c")).toBe("second\n");
  });

  it("collects under the `commit` strategy too, before the deadline commit", async () => {
    const f = await launched("commit");
    portalPushes(f, { "main.c": "commit strategy\n" });
    await deadlineAt(at(DEADLINE, 20_000));
    const [row] = await rowsOf(f);
    expect(row?.outcome).toBe("collected");
    const head = world.git(f.fullName, "rev-parse", "main").trim();
    expect(world.git(f.fullName, "rev-parse", `${head}^`).trim()).toBe(row!.sha);
  });
});

const collectedReceipts = async (f: Fixture) =>
  server.app.db.select().from(pushReceipts).where(and(eq(pushReceipts.githubRepoId, f.repo.githubRepoId!), eq(pushReceipts.collected, true)));
const isPatchOfMain = (url: URL, req: RequestInit) => req.method === "PATCH" && decodeURIComponent(url.pathname).endsWith("/git/refs/heads/main");

describe("what the collection refuses, and what a crash leaves", () => {
  it("settles an order a crash interrupted: no collected receipt for a commit off the branch, never ordered again, and the lock", async () => {
    const f = await launched();
    const orphan = "c".repeat(40);
    await server.app.db.insert(codespaceCollections).values({ id: randomUUID(), repoId: f.repo.id, deadlineAt: new Date(DEADLINE), claimedAt: at(DEADLINE, -6 * 60_000), branch: "main", sha: orphan });
    await server.app.db.insert(pushReceipts).values({ id: randomUUID(), githubRepoId: f.repo.githubRepoId!, branch: "main", headSha: orphan, receivedAt: new Date(DEADLINE), isBot: false, collected: true });
    world.git(f.fullName, "update-ref", collectionRef(f.repo.id, new Date(DEADLINE)), f.base);
    portalPushes(f, { "main.c": "never ordered\n" });
    await deadlineAt(at(DEADLINE, 20_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "failed", reason: "interrupted" }]);
    expect(await collectedReceipts(f)).toEqual([]);
    expect(collectionOrders()).toEqual([]);
    expect(refExists(f, collectionRef(f.repo.id, new Date(DEADLINE)))).toBe(false);
    expect((await repoRow(f)).lockedAt).not.toBeNull();
  });

  it("keeps the collection when GitHub moved the branch but failed to say so", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "moved\n" });
    intercept = (url, req) => {
      if (!isPatchOfMain(url, req)) return undefined;
      intercept = null;
      // GitHub moves the branch, then the answer is lost.
      world.route(url, req);
      return json({ message: "Server Error" }, 502);
    };
    await deadlineAt(at(DEADLINE, 20_000));
    const head = world.git(f.fullName, "rev-parse", "main").trim();
    expect(await rowsOf(f)).toMatchObject([{ outcome: "collected", sha: head }]);
    expect((await collectedReceipts(f)).map((r) => r.headSha)).toEqual([head]);
  });

  it("ends failed after three refused moves, no receipt left", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "refused\n" });
    let refused = 0;
    intercept = (url, req) => (isPatchOfMain(url, req) ? (refused++, json({ message: "Update is not a fast forward" }, 422)) : undefined);
    await deadlineAt(at(DEADLINE, 20_000));
    expect(refused).toBe(3);
    expect(await rowsOf(f)).toMatchObject([{ outcome: "failed", reason: "github_failed", sha: null }]);
    expect(await collectedReceipts(f)).toEqual([]);
    expect(world.git(f.fullName, "rev-parse", "main").trim()).toBe(f.base);
  });

  it("refuses, with nothing signed, a commit on another parent, another tree, a missing ref and a truncated listing", async () => {
    const cases: [string, (f: Fixture) => void][] = [
      ["another parent", (f) => {
        portalPushes(f, { "main.c": "x\n" });
        const inner = portal.collect as (o: Record<string, unknown>) => Record<string, unknown>;
        portal.collect = (order) => {
          const answer = inner(order);
          // An identity of its own: a CI runner has none configured, and git refuses a commit without one.
          const ident = ["-c", "user.name=portal", "-c", "user.email=portal@codespace.local"];
          const onTop = world.git(f.fullName, ...ident, "commit-tree", answer["tree"] as string, "-p", order["ref"] as string, "-m", "x").trim();
          world.git(f.fullName, "update-ref", order["ref"] as string, onTop);
          return answer;
        };
      }],
      ["another tree", (f) => {
        portalPushes(f, { "main.c": "x\n" });
        const inner = portal.collect as (o: Record<string, unknown>) => Record<string, unknown>;
        portal.collect = (order) => ({ ...inner(order), tree: world.git(f.fullName, "rev-parse", `${f.base}^{tree}`).trim() });
      }],
      ["a missing ref", () => {
        portal.collect = () => ({ outcome: "pushed", tree: "d".repeat(40), snapshotAt: DEADLINE, unreadable: 0 });
      }],
      ["a truncated listing", (f) => {
        portalPushes(f, { "main.c": "x\n" });
        intercept = (url, req) =>
          req.method === "GET" && url.pathname.includes("/git/trees/") ? json({ sha: "x", tree: [], truncated: true }) : undefined;
      }],
    ];
    for (const [name, arrange] of cases) {
      server.clock.set(NOW);
      intercept = null;
      const f = await launched();
      arrange(f);
      const signed = world.apiCommits.length;
      await deadlineAt(at(DEADLINE, 20_000));
      expect(await rowsOf(f), name).toMatchObject([{ outcome: "failed", reason: "check_refused" }]);
      expect(world.apiCommits.length, name).toBe(signed);
    }
  });

  it("never reverts a protected file the staff changed after the base: refused, nothing signed", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "workspace\n" }, () => {
      world.commit(f.fullName, "main", { [GRADING_WORKFLOW_PATH]: "grade: v2" });
    });
    const signed = world.apiCommits.length;
    await deadlineAt(at(DEADLINE, 20_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "failed", reason: "check_refused" }]);
    expect(world.apiCommits.length).toBe(signed);
    expect(world.read(f.fullName, "main", GRADING_WORKFLOW_PATH)).toBe("grade: v2");
  });

  it("at the students' choice, lets the last writer win: a push from a machine is not collected over (ADR-149 §2)", async () => {
    const db = server.app.db;
    // An older push through the relay changes nothing: the last one, from a machine, decides.
    const local = await launched("lock", [], {}, "hybrid");
    await relayedHere(local, await pushed(local, { "main.c": "workspace\n" }, -7_200_000));
    const localSha = await pushed(local, { "main.c": "machine\n" }, -60_000);

    const relayed = await launched("lock", [], {}, "hybrid");
    await relayedHere(relayed, await pushed(relayed, { "main.c": "workspace\n" }, -60_000));

    // The teacher's sync merged on GitHub's web interface: no machine wrote it.
    const merged = await launched("lock", [], {}, "hybrid");
    await relayedHere(merged, await pushed(merged, { "main.c": "workspace\n" }, -7_200_000));
    await pushed(merged, { "README.md": "# Lab, fixed" }, -60_000, GITHUB_COMMITTER);

    // The last push an earlier deadline's collection made: the workspace's.
    const recollected = await launched("lock", [], {}, "hybrid");
    const earlier = await pushed(recollected, { "main.c": "collected\n" }, -86_400_000);
    await db.update(pushReceipts).set({ collected: true }).where(and(eq(pushReceipts.githubRepoId, recollected.repo.githubRepoId!), eq(pushReceipts.headSha, earlier)));

    const silent = await launched("lock", [], {}, "hybrid");
    portal.collect = () => ({ outcome: "unchanged", snapshotAt: DEADLINE, unreadable: 0 });
    await deadlineAt(at(DEADLINE, 20_000));

    expect(await rowsOf(local)).toMatchObject([{ outcome: "last_push_local", reason: null, sha: null }]);
    for (const f of [relayed, merged, recollected, silent]) expect(await rowsOf(f)).toMatchObject([{ outcome: "unchanged" }]);
    // Ordered for all but the local one; the skip is audited with the push it stood on.
    expect(collectionOrders().map((c) => (c.body as { repository: string }).repository).sort()).toEqual(
      [relayed, merged, recollected, silent].map((f) => f.fullName).sort(),
    );
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "project_repo.workspace_collected"), eq(auditLog.subjectId, local.repo.id)));
    expect(audit!.payload).toMatchObject({ outcome: "last_push_local", branch: "main", sha: localSha });
    // The job locked them all as before.
    for (const f of [local, relayed, merged, recollected, silent]) expect((await repoRow(f)).lockedAt).not.toBeNull();
  });

  it("at the students' choice, never collects over a head a machine moved after the deadline, before the order or under it (ADR-149 §2)", async () => {
    // Relayed by the deadline, then a push from a machine whose receipt is not in yet when the order would leave.
    const before = await launched("lock", [], {}, "hybrid");
    await relayedHere(before, await pushed(before, { "main.c": "workspace\n" }, -60_000));
    const late = world.commit(before.fullName, "main", { "main.c": "machine, late\n" });
    // No push by the deadline, then one received after it: the head is no handout.
    const first = await launched("lock", [], {}, "hybrid");
    await pushed(first, { "main.c": "machine, late\n" }, 5_000);
    // Moved while the portal works: the commit meets it after a 422, and signs nothing.
    const under = await launched("lock", [], {}, "hybrid");
    await relayedHere(under, await pushed(under, { "main.c": "workspace\n" }, -60_000));
    portalPushes(under, { "main.c": "collected\n" }, () => {
      world.commit(under.fullName, "main", { "main.c": "machine, during\n" });
    });
    const pushes = portal.collect as (order: Record<string, unknown>) => Record<string, unknown>;
    portal.collect = (order) => (order["repository"] === under.fullName ? pushes(order) : { outcome: "unchanged", snapshotAt: DEADLINE, unreadable: 0 });
    const signed = world.apiCommits.length;
    await deadlineAt(at(DEADLINE, 20_000));

    for (const f of [before, first, under]) expect(await rowsOf(f)).toMatchObject([{ outcome: "last_push_local" }]);
    expect(collectionOrders().map((c) => (c.body as { repository: string }).repository)).toEqual([under.fullName]);
    expect(world.apiCommits.length).toBe(signed);
    expect(world.git(before.fullName, "rev-parse", "main").trim()).toBe(late);
    expect(world.read(under.fullName, "main", "main.c")).toBe("machine, during\n");
  });

  it("at the students' choice, settles a push from a machine as such even past the order's window (ADR-149 §2)", async () => {
    const f = await launched("lock", [], {}, "hybrid");
    await pushed(f, { "main.c": "machine\n" }, -60_000);
    await deadlineAt(at(DEADLINE, 200_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "last_push_local" }]);
    expect(collectionOrders()).toEqual([]);
  });

  it("collects nothing when the last push went to a branch not handed out", async () => {
    const f = await launched();
    await server.app.db.insert(pushReceipts).values({ id: randomUUID(), githubRepoId: f.repo.githubRepoId!, branch: "feature", headSha: "e".repeat(40), receivedAt: at(DEADLINE, -60_000), isBot: false });
    portalPushes(f, { "main.c": "x\n" });
    await deadlineAt(at(DEADLINE, 20_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "branch_not_handed_out" }]);
    expect(collectionOrders()).toEqual([]);
  });

  it("collects none of: a group's repository, a never-launched one, one locked before, a free project's, an archived one", async () => {
    const db = server.app.db;
    const group = await launched();
    const [g] = await db.insert(projectGroups).values({ id: randomUUID(), projectId: group.project.id, name: "G", slug: "g", position: 0 }).returning();
    await db.update(projectRepos).set({ groupId: g!.id }).where(eq(projectRepos.id, group.repo.id));
    const locked = await launched();
    await db.update(projectRepos).set({ lockedAt: at(DEADLINE, -3_600_000), staffLock: true }).where(eq(projectRepos.id, locked.repo.id));
    const archived = await launched();
    await db.update(projectRepos).set({ archivedAt: at(DEADLINE, -3_600_000) }).where(eq(projectRepos.id, archived.repo.id));
    const launchedNot = await launched();
    await db.delete(codespaceLaunches).where(eq(codespaceLaunches.projectId, launchedNot.project.id));
    const free = await launched();
    await db.execute(sql`UPDATE projects SET work_mode = 'free' WHERE id = ${free.project.id}`);
    portal.collect = () => ({ outcome: "unchanged", snapshotAt: DEADLINE, unreadable: 0 });
    await deadlineAt(at(DEADLINE, 20_000));
    for (const f of [group, locked, archived, launchedNot, free]) expect(await rowsOf(f)).toEqual([]);
    expect(collectionOrders()).toEqual([]);
  });

  it("collects more than sixteen repositories in one job", async () => {
    const extra = await Promise.all(Array.from({ length: 16 }, () => newStudent()));
    const student = await launched("lock", extra);
    const db = server.app.db;
    for (const s of extra) {
      expect((await call("POST", `/app/api/student/projects/${student.project.id}/accept`, s.headers)).statusCode).toBe(200);
      await db.insert(codespaceLaunches).values({ projectId: student.project.id, userId: s.id, firstLaunchAt: new Date(NOW), lastLaunchAt: new Date(NOW) });
    }
    portal.collect = () => ({ outcome: "unchanged", snapshotAt: DEADLINE, unreadable: 0 });
    await deadlineAt(at(DEADLINE, 20_000));
    expect(collectionOrders()).toHaveLength(17);
    const rows = await db.select().from(codespaceCollections).innerJoin(projectRepos, eq(projectRepos.id, codespaceCollections.repoId)).where(eq(projectRepos.projectId, student.project.id));
    expect(rows.every((r) => r.codespace_collections.outcome === "unchanged")).toBe(true);
  }, 300_000);
});

// ---------------------------------------------------------------- what the student reads (ADR-130 §7, invariant 4)

const studentView = async (f: Fixture, headers: Headers, who = "student") => {
  const res = await call("GET", `/app/api/student/projects/${f.project.id}`, headers);
  expect(res.statusCode, `${who} ${res.body}`).toBe(200);
  return { body: res.body, view: StudentProject.parse(res.json()) };
};

/** The one trace a student response may hold of a collection: the flag, under its one key. */
const noOtherTrace = (body: string, who: string) => {
  for (const secret of ['"collection"', '"outcome"', '"reason"', '"unreadable"', '"snapshotAt"', '"settledAt"', "2026-11-16T13:40:03"]) {
    expect(body, `${who} ${secret}`).not.toContain(secret);
  }
  // The ref, the commit's message, an outcome's name: none survives without the word.
  expect(body.replaceAll('"collected"', ""), who).not.toMatch(/collect/i);
};

/** The owner's own STAFF seat in `f`'s classroom (ADR-077), with a test repository collected at the deadline. */
async function ownerTestSeat(f: Fixture): Promise<string> {
  const db = server.app.db;
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId: f.project.classroomId,
    nom: "Test",
    prenom: "Owner",
    email: `o-${randomUUID().slice(0, 6)}@heig.test`,
    userId: owner.id,
    claimedAt: at(NOW),
    staff: true,
  });
  const repoId = randomUUID();
  const fullName = `${f.fullName.split("/")[0]}/lab-owner-test`;
  await db.insert(projectRepos).values({
    id: repoId,
    projectId: f.project.id,
    userId: owner.id,
    githubRepoId: 900_000_000 + Math.floor(Math.random() * 1e6),
    fullName,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: at(NOW),
    invitationStatus: "accepted",
  });
  await db.insert(codespaceCollections).values({ id: randomUUID(), repoId, deadlineAt: new Date(DEADLINE), claimedAt: at(DEADLINE, 5_000), settledAt: at(DEADLINE, 9_000), outcome: "collected", branch: "main", sha: "0".repeat(40), unreadable: 3 });
  return fullName;
}

describe("what the student reads of a collection (ADR-130 §7, invariant 4)", () => {
  it("says it was collected, through the student view only, to each of its readers, and nothing else of it", async () => {
    const f = await launched();
    // The student's own push by the deadline: two commits, the count the collection must not change.
    await server.app.db.insert(pushReceipts).values({ id: randomUUID(), githubRepoId: f.repo.githubRepoId!, branch: "main", headSha: "1".repeat(40), receivedAt: at(DEADLINE, -60_000), isBot: false, commits: 2 });
    portalPushes(f, { "main.c": "collected\n" });
    const pushes = portal.collect as (order: Record<string, unknown>) => Record<string, unknown>;
    // Seven files the portal could not read, and its own snapshot time: the staff's facts.
    portal.collect = (order) => ({ ...pushes(order), unreadable: 7, snapshotAt: "2026-11-16T13:40:03.000Z" });
    await deadlineAt(at(DEADLINE, 20_000));
    const [row] = await rowsOf(f);
    expect(row).toMatchObject({ outcome: "collected", unreadable: 7 });
    server.clock.set(at(DEADLINE, 3_600_000));
    // The invitation accepted: the card says the state of the work (M3-14i).
    await server.app.db.update(projectRepos).set({ invitationStatus: "accepted" }).where(eq(projectRepos.id, f.repo.id));

    const admin = await server.signIn("admin");
    // Each confined session opened right before its read: a project's new one supersedes the last (ADR-089).
    const readers: [string, () => Promise<Headers>][] = [
      ["student", async () => f.student.headers],
      ["impersonation", () => sessionOf(server.app.db, f.student.id, { kind: "impersonation", actorUserId: admin.id })],
      ["seb", () => sessionOf(server.app.db, f.student.id, { kind: "seb", projectId: f.project.id, sebConfigKey: "c".repeat(64) })],
      ["kiosk", async () => (await kioskSession(server.app, f.student.id, f.project.id)).headers],
    ];
    for (const [who, open] of readers) {
      const headers = await open();
      const { body, view } = await studentView(f, headers, who);
      noOtherTrace(body, who);
      expect(view.repo?.collected, who).toBe(true);
      // The collection commit is the platform's, not a push of the student's: the count stays theirs.
      expect(view.repo?.commits, who).toBe(2);
      // The cards: the home and the classroom page, for the readers the portal serves.
      const home = await call("GET", "/app/api/student/home", headers);
      const page = await call("GET", `/app/api/student/classrooms/${f.project.classroomId}`, headers);
      if (who === "seb" || who === "kiosk") {
        // A confined session reads neither (ADR-027): it is no session there at all.
        expect([home.statusCode, page.statusCode], who).toEqual([401, 401]);
        continue;
      }
      for (const res of [home, page]) {
        expect(res.statusCode, `${who} ${res.body}`).toBe(200);
        noOtherTrace(res.body, who);
      }
      const card = StudentHome.parse(home.json()).past.find((c) => c.id === f.project.id);
      expect(card?.kind === "project" ? card.work?.collected : undefined, who).toBe(true);
      const roomCard = StudentClassroomPage.parse(page.json()).activities.past.find((c) => c.id === f.project.id);
      expect(roomCard?.kind === "project" ? roomCard.work?.collected : undefined, who).toBe(true);
    }
    // Should a confined session ever reach the home's service, it lists no project at all (`StudentScope.confined`).
    const caller = { id: f.student.id, role: "student" as const, reach: "seats" as const };
    for (const kind of ["seb", "kiosk"] as const) {
      const confinedHome = await activityHome(server.app.db, caller, { kind, actorUserId: null, projectId: f.project.id, evaluationId: null }, server.clock.now(), { codespace: true });
      expect([...confinedHome.open, ...confinedHome.upcoming, ...confinedHome.past], kind).toEqual([]);
    }

    // A teacher in the student view on a staff seat (ADR-077): their own test repository, its flag, nothing of the student's.
    const testRepo = await ownerTestSeat(f);
    const asTeacher = await studentView(f, owner.headers, "teacher");
    expect(asTeacher.view).toMatchObject({ seat: "staff", repo: { fullName: testRepo, collected: true } });
    noOtherTrace(asTeacher.body, "teacher");
    expect(asTeacher.body).not.toContain(f.fullName);

    // The staff count the student's own commits too, never the platform's.
    const detail = ProjectDetail.parse((await call("GET", `/app/api/projects/${f.project.id}`, owner.headers)).json());
    expect(detail.rows.map((r) => r.repo).find((r) => r?.id === f.repo.id)).toMatchObject({ commits: 2, collection: { outcome: "collected", unreadable: 7 } });
  });

  it("says nothing of a collection that handed nothing in, nor of its reason, branch or sha", async () => {
    const f = await launched();
    const admin = await server.signIn("admin");
    const impersonation = await sessionOf(server.app.db, f.student.id, { kind: "impersonation", actorUserId: admin.id });
    server.clock.set(at(DEADLINE, 3_600_000));
    for (const [outcome, reason] of [
      ["failed", "timeout"],
      ["failed", "check_refused"],
      ["unchanged", null],
      ["too_late", null],
      ["no_snapshot", null],
      [null, null], // claimed, never settled
    ] as const) {
      // One row per (repository, deadline): each pass replaces it.
      await server.app.db.delete(codespaceCollections).where(eq(codespaceCollections.repoId, f.repo.id));
      await server.app.db.insert(codespaceCollections).values({
        id: randomUUID(),
        repoId: f.repo.id,
        deadlineAt: new Date(DEADLINE),
        claimedAt: at(DEADLINE, 5_000),
        settledAt: outcome === null ? null : at(DEADLINE, 9_000),
        outcome,
        reason,
        branch: "hidden-branch-x",
        sha: "fa11ed00".repeat(5),
        unreadable: 5,
      });
      for (const headers of [f.student.headers, impersonation]) {
        const { body, view } = await studentView(f, headers);
        expect(view.repo?.collected, String(outcome)).toBe(false);
        for (const secret of ["hidden-branch-x", "fa11ed00".repeat(5), "timeout", "too_late", "unchanged"]) expect(body, `${outcome} ${secret}`).not.toContain(secret);
        noOtherTrace(body, String(outcome));
      }
    }
  });

  it("forgets an earlier deadline's collection once the repository's deadline was extended, and says the new one's", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "first\n" });
    await deadlineAt(at(DEADLINE, 20_000));
    expect((await studentView(f, f.student.headers)).view.repo?.collected).toBe(true);

    const later = at(DEADLINE, 3_600_000).toISOString();
    expect((await call("PUT", `/app/api/projects/${f.project.id}/repos/${f.repo.id}/deadline`, owner.headers, { deadlineAt: later })).statusCode).toBe(200);
    expect((await studentView(f, f.student.headers)).view.repo?.collected).toBe(false);

    portalPushes(f, { "main.c": "second\n" });
    await deadlineAt(at(later, 20_000));
    expect((await studentView(f, f.student.headers)).view.repo?.collected).toBe(true);
  });
});

/** A collection claimed and never settled, with its commit and its receipt, as a crash leaves it. */
async function unsettled(f: Fixture, sha: string, claimedAt: Date) {
  const id = randomUUID();
  await server.app.db.insert(codespaceCollections).values({ id, repoId: f.repo.id, deadlineAt: new Date(DEADLINE), claimedAt, branch: "main", sha });
  await server.app.db.insert(pushReceipts).values({ id: randomUUID(), githubRepoId: f.repo.githubRepoId!, branch: "main", headSha: sha, receivedAt: new Date(DEADLINE), isBot: false, collected: true });
  return id;
}

describe("crashes and concurrent runs (ADR-130 §5, §6)", () => {
  it("freezes nothing while a collection is unsettled, a live one left alone; once settled, the freeze reads the right target", async () => {
    const f = await launched("lock", [], { graceMinutes: 0 });
    const orphan = "c".repeat(40);
    await unsettled(f, orphan, at(DEADLINE, 10_000));
    await deadlineAt(at(DEADLINE, 20_000));
    expect((await repoRow(f)).frozenAt).toBeNull();
    expect(await rowsOf(f)).toMatchObject([{ outcome: null }]);

    await deadlineAt(at(DEADLINE, 6 * 60_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "failed", reason: "interrupted" }]);
    await deadlineAt(at(DEADLINE, 7 * 60_000));
    expect((await repoRow(f)).frozenAt).not.toBeNull();
    expect(await lastStudentPush(server.app.db, f.repo.githubRepoId!, ["main"], new Date(DEADLINE))).toBeNull();
  });

  it("lets no stale run overwrite a settled row: no audit, the landed commit keeps its receipt", async () => {
    const f = await launched();
    portalPushes(f, { "main.c": "landed\n" });
    const inner = portal.collect as (o: Record<string, unknown>) => unknown;
    // Another run settles the row while this one waits for the portal.
    portal.collect = async (order) => {
      const answer = inner(order);
      await server.app.db.execute(sql`UPDATE codespace_collections SET outcome = 'failed', reason = 'interrupted', settled_at = now() WHERE repo_id = ${f.repo.id}`);
      return answer;
    };
    await deadlineAt(at(DEADLINE, 20_000));
    const head = world.git(f.fullName, "rev-parse", "main").trim();
    expect(head).not.toBe(f.base);
    expect(await rowsOf(f)).toMatchObject([{ outcome: "failed", reason: "interrupted" }]);
    const audits = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "project_repo.workspace_collected"), eq(auditLog.subjectId, f.repo.id)));
    expect(audits).toEqual([]);
    expect((await collectedReceipts(f)).map((r) => r.headSha)).toEqual([head]);
  });

  it("leaves a row unsettled when GitHub cannot be read, and settles it collected by ancestry, a push on top", async () => {
    const f = await launched();
    const landed = world.commit(f.fullName, "main", { "main.c": "collected before the crash\n" });
    world.commit(f.fullName, "main", { "late.txt": "a push on top\n" });
    await unsettled(f, landed, at(DEADLINE, -6 * 60_000));
    portal.collect = () => ({ outcome: "unchanged", snapshotAt: DEADLINE, unreadable: 0 });
    intercept = (url) => (url.pathname.includes("/compare/") ? json({ message: "Server Error" }, 500) : undefined);
    await deadlineAt(at(DEADLINE, 20_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: null }]);
    expect(await collectedReceipts(f)).toHaveLength(1);

    intercept = null;
    await deadlineAt(at(DEADLINE, 40_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "collected", sha: landed }]);
    expect((await collectedReceipts(f)).map((r) => r.headSha)).toEqual([landed]);
  });

  it("settles a repository without a name on GitHub as interrupted, without reading GitHub", async () => {
    const other = await newStudent();
    const f = await launched("lock", [other]);
    expect((await call("POST", `/app/api/student/projects/${f.project.id}/accept`, other.headers)).statusCode).toBe(200);
    await server.app.db.insert(codespaceLaunches).values({ projectId: f.project.id, userId: other.id, firstLaunchAt: new Date(NOW), lastLaunchAt: new Date(NOW) });
    await unsettled(f, "c".repeat(40), at(DEADLINE, -6 * 60_000));
    await server.app.db.update(projectRepos).set({ fullName: null }).where(eq(projectRepos.id, f.repo.id));
    portal.collect = () => ({ outcome: "unchanged", snapshotAt: DEADLINE, unreadable: 0 });
    await deadlineAt(at(DEADLINE, 20_000));
    expect(await rowsOf(f)).toMatchObject([{ outcome: "failed", reason: "interrupted" }]);
    expect(await collectedReceipts(f)).toEqual([]);
  });
});
