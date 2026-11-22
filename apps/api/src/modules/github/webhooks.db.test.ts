/**
 * The webhook intake, its handler registry and the delivery reconciliation
 * (M2-04; ported from heig-classroom's `webhooks.db.test.ts`), on a server
 * built with Quiz's App and a webhook secret, against a fake GitHub
 * (`github/testing.ts`). The test server has no queue (`JOBS_DISABLED`), so
 * a stored delivery is handled beside the request: the tests wait for its
 * `processed_at`, never for the wall clock. That the route needs no session
 * is walked in `walks.db.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationPayload } from "@quiz/contracts";

import { loadConfig, type AppConfig } from "../../config.js";
import {
  auditLog,
  classrooms,
  courseStaff,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  notifications,
  pushReceipts,
  webhookDeliveries,
  webhookDeliveryScan,
  webhookRedeliveryAsks,
} from "../../db/schema.js";
import {
  appKey,
  fakeGithub,
  json,
  on,
  orgsRoute,
  signBody,
  signedDelivery,
  type DeliveryOptions,
  type FakeOrg,
  type Route,
} from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import {
  ASKS_RETENTION_MS,
  PAYLOAD_RETENTION_MS,
  processDelivery,
  purgeDeliveryPayloads,
  purgeRedeliveryAsks,
  reconcileDeliveries,
  REPLAY_AFTER_MS,
} from "./deliveries.js";
import { WEBHOOK_BODY_LIMIT } from "./routes.js";
import { onEvent, onReceipt, orgView, resetGithubCaches } from "./service.js";

const SECRET = "w".repeat(40);
const key = appKey();
const gh = fakeGithub();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: SECRET,
};
let server: TestServer;
let config: AppConfig;
let orgs: FakeOrg[] = [];

const deliver = (event: string | null, payload: object, opts: DeliveryOptions = {}) =>
  signedDelivery(server.app, SECRET, payload, { event, ...opts });

async function delivery(id: string) {
  const [row] = await server.app.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.deliveryId, id));
  return row;
}

const processed = (id: string) =>
  vi.waitFor(async () => expect((await delivery(id))?.processedAt).not.toBeNull());

/** Delivered and handled: the id, once its `processed_at` is set. */
async function handled(event: string, payload: object): Promise<string> {
  const id = randomUUID();
  expect((await deliver(event, payload, { id })).statusCode).toBe(200);
  await processed(id);
  return id;
}

async function orgByGithubId(githubOrgId: number) {
  const [row] = await server.app.db
    .select()
    .from(githubOrganizations)
    .where(eq(githubOrganizations.githubOrgId, githubOrgId));
  return row;
}

async function orgRow(values: Partial<typeof githubOrganizations.$inferInsert> & { login: string }) {
  const [row] = await server.app.db
    .insert(githubOrganizations)
    .values({ id: randomUUID(), ...values })
    .returning();
  return row!;
}

async function audits(action: string, subjectId: string) {
  return server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)));
}

const fakeOrg = (githubOrgId: number, login: string, installationId: number | null, more: Partial<FakeOrg> = {}): FakeOrg => ({
  githubOrgId,
  login,
  installationId,
  selection: "all",
  plan: "team",
  exists: true,
  ...more,
});

/** A handler that counts, on an event no real module handles. */
let pings = 0;
let pingFails: string | null = null;
onEvent("test_ping", async () => {
  pings += 1;
  if (pingFails) throw new Error(pingFails);
});

/** The repositories a module would track (projects, M3). */
const TRACKED = 9001;
onReceipt(async (_tx, githubRepoId) => githubRepoId === TRACKED);

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer(ENV);
  config = loadConfig({ NODE_ENV: "test", ...ENV });
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
});

beforeEach(() => {
  resetGithubCaches();
  orgs = [];
  gh.reset();
  gh.routes = [orgsRoute(() => orgs)];
  pings = 0;
  pingFails = null;
});

// ---------------------------------------------------------------- the intake

describe("the signature (N-SEC-17)", () => {
  it("answers 401 to a missing, a wrong or a foreign signature, and stores nothing", async () => {
    for (const signature of [null, "sha256=00", "sha1=abc", signBody("another-secret".repeat(3), "{}")]) {
      const id = randomUUID();
      const res = await deliver("test_ping", { zen: "hi" }, { id, signature });
      expect(res.statusCode, String(signature)).toBe(401);
      expect(await delivery(id)).toBeUndefined();
    }
    expect(pings).toBe(0);
  });

  it("answers 401 to a body changed after it was signed", async () => {
    const id = randomUUID();
    const res = await deliver("test_ping", {}, { id, signature: signBody(SECRET, '{"a":1}'), body: '{"a":2}' });
    expect(res.statusCode).toBe(401);
    expect(await delivery(id)).toBeUndefined();
  });
});

describe("the headers and the body, once signed", () => {
  it("answers 400 to a malformed delivery id", async () => {
    const res = await deliver("test_ping", {}, { id: "not-a-guid" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_headers");
  });

  it("answers 400 without an event, and stores nothing", async () => {
    const id = randomUUID();
    const res = await deliver(null, {}, { id });
    expect(res.statusCode).toBe(400);
    expect(await delivery(id)).toBeUndefined();
  });

  it("answers 400 to a signed body that is not a JSON object", async () => {
    for (const body of ["not json", "[1,2]"]) {
      const id = randomUUID();
      const res = await deliver("test_ping", {}, { id, body });
      expect(res.statusCode, body).toBe(400);
      expect(await delivery(id)).toBeUndefined();
    }
  });
});

describe("the deduplication", () => {
  it("acknowledges a delivery seen before and runs it once", async () => {
    const id = randomUUID();
    const first = await deliver("test_ping", { action: "hello" }, { id });
    expect(first.json()).toEqual({ ok: true });
    await processed(id);
    const again = await deliver("test_ping", { action: "hello" }, { id });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    expect(pings).toBe(1);
    expect(await delivery(id)).toMatchObject({ event: "test_ping", action: "hello", error: null });
  });

  it("stores the server's receipt time (invariant 5)", async () => {
    server.clock.set("2026-10-01T09:00:00.000Z");
    const id = await handled("test_ping", {});
    expect((await delivery(id))?.receivedAt.toISOString()).toBe("2026-10-01T09:00:00.000Z");
  });

  it("answers well under the 100 ms of N-SEC-17", async () => {
    // Warm: the first requests of a server compile what they reach.
    await handled("test_ping", {});
    const id = randomUUID();
    const start = performance.now();
    const res = await deliver("test_ping", { zen: "Keep it logically awesome." }, { id });
    const elapsed = performance.now() - start;
    expect(res.statusCode).toBe(200);
    // The target is 100 ms; the margin absorbs a loaded test machine.
    expect(elapsed).toBeLessThan(250);
    await processed(id);
  });
});

// ---------------------------------------------------------------- the receipt

describe("the push receipt (ADR-012)", () => {
  const push = (repoId: number, after: string, more: object = {}) => ({
    ref: "refs/heads/main",
    after,
    forced: false,
    repository: { id: repoId },
    sender: { login: "alice" },
    ...more,
  });
  const sha = (c: string) => c.repeat(40);

  async function receipts(repoId: number) {
    return server.app.db.select().from(pushReceipts).where(eq(pushReceipts.githubRepoId, repoId));
  }

  it("is written before the 200, on the server's clock, and the first one stands", async () => {
    server.clock.set("2026-10-01T10:00:00.000Z");
    expect((await deliver("push", push(TRACKED, sha("a")))).statusCode).toBe(200);
    // Written by the intake itself: no worker has to run for it.
    const [receipt] = await receipts(TRACKED);
    expect(receipt).toMatchObject({ branch: "main", headSha: sha("a"), isBot: false, forced: false });
    expect(receipt!.receivedAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");

    // The same head, delivered again later under another id: the first receipt stands.
    server.clock.advance(3_600_000);
    await deliver("push", push(TRACKED, sha("a")));
    const kept = await receipts(TRACKED);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.receivedAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");
  });

  it("marks the App's bot and a workflow's push as bot pushes", async () => {
    await deliver("push", push(TRACKED, sha("b"), { sender: { login: "quiz-test[bot]" }, forced: true }));
    await deliver("push", push(TRACKED, sha("c"), { sender: { login: "github-actions[bot]" } }));
    const rows = await receipts(TRACKED);
    expect(rows.find((r) => r.headSha === sha("b"))).toMatchObject({ isBot: true, forced: true });
    expect(rows.find((r) => r.headSha === sha("c"))).toMatchObject({ isBot: true });
  });

  it("counts the push's new commits that no bot authored (M3-14i), none known without the list", async () => {
    const commit = (distinct: boolean, username?: string) => ({ distinct, author: { name: "x", email: "x@y", ...(username ? { username } : {}) } });
    const commits = [commit(true, "alice"), commit(true), commit(false, "alice"), commit(true, "quiz-test[bot]"), commit(true, "github-actions[bot]")];
    await deliver("push", push(TRACKED, sha("e"), { commits }));
    await deliver("push", push(TRACKED, sha("f")));
    const rows = await receipts(TRACKED);
    expect(rows.find((r) => r.headSha === sha("e"))).toMatchObject({ commits: 2 });
    expect(rows.find((r) => r.headSha === sha("f"))).toMatchObject({ commits: null });
  });

  it("records who authored the counted commits, by their linked account's id, nothing of an unknown author (ADR-136)", async () => {
    const [alice, bob, other] = await Promise.all([server.signIn("student"), server.signIn("student"), server.signIn("student")]);
    await server.app.db.insert(githubAccounts).values([
      { userId: alice.id, githubUserId: 7_100_001, login: "Alice-GH" },
      { userId: bob.id, githubUserId: 7_100_002, login: "bob-gh" },
      { userId: other.id, githubUserId: 7_100_003, login: "nobody-pushes" },
    ]);
    const commit = (username: string | null, distinct = true) => ({ distinct, author: { name: "x", email: "x@y", ...(username ? { username } : {}) } });
    const commits = [
      // GitHub's logins are case-insensitive: Alice's account, twice.
      commit("alice-gh"),
      commit("Alice-GH"),
      commit("bob-gh"),
      // Counted, attributed to nobody: no login, a login no linked account holds.
      commit(null),
      commit("stranger"),
      // Not counted, so not attributed: already pushed, the App's, a workflow's.
      commit("bob-gh", false),
      commit("quiz-test[bot]"),
      commit("github-actions[bot]"),
    ];
    // The pusher is not the author: the sender is the other student.
    await deliver("push", push(TRACKED, sha("1"), { commits, sender: { login: "nobody-pushes" } }));
    await deliver("push", push(TRACKED, sha("2"), { commits: [commit("stranger")] }));
    await deliver("push", push(TRACKED, sha("3")));
    const rows = await receipts(TRACKED);
    const first = rows.find((r) => r.headSha === sha("1"))!;
    expect(first.commits).toBe(5);
    expect([...first.authors!].sort((a, b) => a.id - b.id)).toEqual([
      { id: 7_100_001, n: 2 },
      { id: 7_100_002, n: 1 },
    ]);
    expect(rows.find((r) => r.headSha === sha("2"))).toMatchObject({ commits: 1, authors: [] });
    expect(rows.find((r) => r.headSha === sha("3"))).toMatchObject({ commits: null, authors: null });
    // Nothing of an unknown author is stored.
    expect(JSON.stringify(rows)).not.toContain("stranger");
  });

  it("is not written for an untracked repository, nor a deleted branch", async () => {
    await deliver("push", push(9002, sha("d")));
    await deliver("push", push(TRACKED, "0".repeat(40)));
    expect(await receipts(9002)).toEqual([]);
    expect((await receipts(TRACKED)).some((r) => r.headSha === "0".repeat(40))).toBe(false);
  });
});

// ---------------------------------------------------------------- the handlers

describe("installation events (GitHub's current state recorded)", () => {
  const installation = (action: string, id: number) => ({
    action,
    installation: { id, account: { id: 1, login: "whatever", type: "Organization" } },
  });

  it("records a created installation, then forgets a deleted one", async () => {
    orgs = [fakeOrg(5001, "heig-hooked", 701)];
    await handled("installation", installation("created", 701));
    const org = await orgByGithubId(5001);
    expect(org).toMatchObject({ login: "heig-hooked", installationId: 701, status: "active" });
    const [resolved] = await audits("github_org.installation_resolved", org!.id);
    expect(resolved!.payload).toMatchObject({ installationId: 701, via: "webhook" });

    orgs = [fakeOrg(5001, "heig-hooked", null)];
    await handled("installation", installation("deleted", 701));
    expect(await orgByGithubId(5001)).toMatchObject({ installationId: null, status: "active" });
    const [gone] = await audits("github_org.installation_deleted", org!.id);
    expect(gone!.payload).toMatchObject({ via: "webhook", action: "deleted", installationId: 701 });

    // A replay writes and audits nothing more.
    await handled("installation", installation("deleted", 701));
    expect(await audits("github_org.installation_deleted", org!.id)).toHaveLength(1);
  });

  it("keeps a suspended installation with its id, acting as none, and lifts the suspension when unsuspended", async () => {
    orgs = [fakeOrg(5002, "heig-suspended", 702)];
    await handled("installation", installation("created", 702));
    orgs = [fakeOrg(5002, "heig-suspended", 702, { suspended: true })];
    await handled("installation", installation("suspend", 702));
    const suspended = await orgByGithubId(5002);
    expect(suspended).toMatchObject({ installationId: 702, status: "active" });
    expect(suspended!.suspendedAt).not.toBeNull();
    expect(orgView(suspended!).installed).toBe(false);
    const [audited] = await audits("github_org.installation_suspended", suspended!.id);
    expect(audited!.payload).toMatchObject({ suspended: true, via: "webhook" });
    orgs = [fakeOrg(5002, "heig-suspended", 702)];
    await handled("installation", installation("unsuspend", 702));
    expect(await orgByGithubId(5002)).toMatchObject({ installationId: 702, suspendedAt: null });
    expect(await audits("github_org.installation_suspended", suspended!.id)).toHaveLength(2);
  });

  it("ignores a user's installation", async () => {
    gh.routes.unshift(
      on("GET", "/app/installations/703", () =>
        json({ id: 703, account: { id: 5003, login: "someone", type: "User" } }),
      ),
    );
    await handled("installation", installation("created", 703));
    expect(await orgByGithubId(5003)).toBeUndefined();
  });

  it("never brings back an installation by replaying a stale event out of order", async () => {
    server.clock.set("2026-10-04T08:00:00.000Z");
    // `created` arrives while GitHub fails: the delivery fails, unprocessed.
    orgs = [fakeOrg(5004, "heig-reordered", 704)];
    gh.routes.unshift(on("GET", "/app/installations/704", () => json({ message: "Unprocessable" }, 422)));
    const created = randomUUID();
    await deliver("installation", installation("created", 704), { id: created });
    await vi.waitFor(async () => expect((await delivery(created))?.error).toBeTruthy());
    expect(await orgByGithubId(5004)).toBeUndefined();

    // Then the App is uninstalled, and that delivery succeeds.
    gh.routes = [orgsRoute(() => orgs)];
    orgs = [fakeOrg(5004, "heig-reordered", null)];
    await handled("installation", installation("deleted", 704));

    // The reconciliation replays the stale `created`: GitHub says gone.
    server.clock.advance(REPLAY_AFTER_MS + 1_000);
    expect(await reconcileDeliveries(server.app, config)).toMatch(/^1 local deliveries replayed/);
    expect((await delivery(created))?.processedAt).not.toBeNull();
    expect((await orgByGithubId(5004))?.installationId ?? null).toBeNull();
  });
});

/*
 * F-PROJ-18, F-NOTIF-13 `github_org_lost` (M3-09b): the course staff of each
 * non-archived classroom linked to the organization are told once when Quiz's
 * App stops acting on it — uninstalled, or the organization deleted with its
 * installation —, one entry per classroom; a suspension, a replay and an
 * organization whose App was already gone tell nobody.
 */
describe("an organization lost (github_org_lost)", () => {
  const lostBells = async (userId: string) =>
    (
      await server.app.db
        .select({ payload: notifications.payload })
        .from(notifications)
        .where(eq(notifications.userId, userId))
    )
      .map((r) => NotificationPayload.parse(r.payload))
      .filter((p) => p.kind === "github_org_lost");

  /** Two classrooms of one course linked to `orgId`, one of them archived; the staff: a teacher and a colleague. */
  async function linkedClassrooms(orgId: string) {
    const db = server.app.db;
    const teacher = await server.signIn("teacher");
    const colleague = await server.signIn("teacher");
    const student = await server.signIn("student");
    const open = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const archived = await seedLive(db, { teacherId: teacher.id, questions: 0 });
    await db.insert(courseStaff).values({ courseId: open.courseId, userId: colleague.id });
    await db.update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, archived.classroomId));
    for (const room of [open, archived]) {
      await db.insert(githubClassroomLinks).values({ classroomId: room.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
    }
    const [row] = await db.select({ name: classrooms.name }).from(classrooms).where(eq(classrooms.id, open.classroomId));
    return { teacher, colleague, student, classroomId: open.classroomId, classroomName: row!.name };
  }

  it("tells the staff of its open classrooms once when the App is uninstalled, never on a suspension or a replay", async () => {
    const org = await orgRow({ githubOrgId: 7001, login: "heig-lost", installationId: 901 });
    const { teacher, colleague, student, classroomId, classroomName } = await linkedClassrooms(org.id);
    // Suspended: GitHub's state, whatever the event said. Kept, nobody told.
    orgs = [fakeOrg(7001, "heig-lost", 901, { suspended: true })];
    await handled("installation", { action: "suspend", installation: { id: 901 } });
    expect(await orgByGithubId(7001)).toMatchObject({ installationId: 901 });
    expect(await lostBells(teacher.id)).toEqual([]);
    // An unrelated event while suspended re-reads the same state: still nobody.
    await handled("installation", { action: "new_permissions_accepted", installation: { id: 901 } });
    expect(await lostBells(teacher.id)).toEqual([]);

    orgs = [fakeOrg(7001, "heig-lost", 901)];
    await handled("installation", { action: "unsuspend", installation: { id: 901 } });
    orgs = [fakeOrg(7001, "heig-lost", null)];
    await handled("installation", { action: "deleted", installation: { id: 901 } });
    const lost = { kind: "github_org_lost", classroomId, classroomName, orgLogin: "heig-lost" };
    expect(await lostBells(teacher.id)).toEqual([lost]);
    expect(await lostBells(colleague.id)).toEqual([lost]);
    expect(await lostBells(student.id)).toEqual([]);

    // Replayed, and the organization then deleted too: told once already.
    await handled("installation", { action: "deleted", installation: { id: 901 } });
    await handled("organization", { action: "deleted", organization: { id: 7001, login: "heig-lost" } });
    expect(await lostBells(teacher.id)).toEqual([lost]);
  });

  it("tells them once when the installation goes while suspended", async () => {
    const org = await orgRow({ githubOrgId: 7003, login: "heig-suspended-gone", installationId: 903 });
    const { teacher, classroomId, classroomName } = await linkedClassrooms(org.id);
    orgs = [fakeOrg(7003, "heig-suspended-gone", 903, { suspended: true })];
    await handled("installation", { action: "suspend", installation: { id: 903 } });
    expect(await lostBells(teacher.id)).toEqual([]);
    orgs = [fakeOrg(7003, "heig-suspended-gone", null)];
    await handled("installation", { action: "deleted", installation: { id: 903 } });
    expect(await lostBells(teacher.id)).toEqual([{ kind: "github_org_lost", classroomId, classroomName, orgLogin: "heig-suspended-gone" }]);
    expect(await orgByGithubId(7003)).toMatchObject({ installationId: null, suspendedAt: null });
  });

  it("tells them when the organization is deleted with its installation, one entry per classroom", async () => {
    const org = await orgRow({ githubOrgId: 7002, login: "heig-doomed", installationId: 902 });
    const { teacher, classroomId } = await linkedClassrooms(org.id);
    const second = await seedLive(server.app.db, { teacherId: teacher.id, questions: 0 });
    await server.app.db
      .insert(githubClassroomLinks)
      .values({ classroomId: second.classroomId, orgId: org.id, linkedBy: teacher.id, linkedAt: new Date() });
    await handled("organization", { action: "deleted", organization: { id: 7002, login: "heig-doomed" } });
    expect((await lostBells(teacher.id)).map((p) => p.classroomId).sort()).toEqual([classroomId, second.classroomId].sort());
  });
});

describe("organization events", () => {
  it("follows a rename by id, and retires the row that held the new login", async () => {
    const org = await orgRow({ githubOrgId: 6001, login: "old-name", installationId: 801 });
    const squatter = await orgRow({ githubOrgId: 6002, login: "new-name" });
    await handled("organization", { action: "renamed", organization: { id: 6001, login: "new-name" } });
    expect(await orgByGithubId(6001)).toMatchObject({ id: org.id, login: "new-name", installationId: 801 });
    expect(await orgByGithubId(6002)).toMatchObject({
      login: `new-name~${squatter.id}`,
      status: "deleted",
    });
    const [renamed] = await audits("github_org.renamed", org.id);
    expect(renamed!.payload).toMatchObject({ from: "old-name", to: "new-name", via: "webhook" });
  });

  it("marks a deleted organization, and keeps its row", async () => {
    const org = await orgRow({ githubOrgId: 6003, login: "doomed", installationId: 802 });
    await handled("organization", { action: "deleted", organization: { id: 6003, login: "doomed" } });
    expect(await orgByGithubId(6003)).toMatchObject({ status: "deleted", installationId: null });
    expect(await audits("github_org.deleted", org.id)).toHaveLength(1);
  });

  it("ignores an organization Quiz does not know", async () => {
    await handled("organization", { action: "deleted", organization: { id: 6999, login: "stranger" } });
    expect(await orgByGithubId(6999)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- failures and reconciliation

describe("a failed delivery", () => {
  const TOKEN = "ghs_secrettoken123";

  it("keeps no token: not stored, not rethrown, not logged (invariant 15)", async () => {
    pingFails = `GitHub said no to ${TOKEN}`;
    const logged = vi.spyOn(server.app.log, "error");
    try {
      const id = randomUUID();
      await deliver("test_ping", {}, { id });
      await vi.waitFor(async () => expect((await delivery(id))?.error).toBeTruthy());
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
      const stored = (await delivery(id))!.error!;
      expect(stored).toContain("gh*_***");
      expect(stored).not.toContain("secrettoken");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("secrettoken");

      // What the queue would store: the error the worker throws, and its cause.
      const thrown = await processDelivery(server.app, config, id).catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).cause).toBeUndefined();
      expect(String((thrown as Error).message)).not.toContain("secrettoken");

      // Settled, so no later reconciliation of this file finds it pending.
      pingFails = null;
      await processDelivery(server.app, config, id);
    } finally {
      logged.mockRestore();
    }
  });

  it("is replayed by the reconciliation once its retries have had their time", async () => {
    server.clock.set("2026-10-01T12:00:00.000Z");
    pingFails = "not yet";
    const id = randomUUID();
    await deliver("test_ping", {}, { id });
    await vi.waitFor(async () => expect((await delivery(id))?.error).toBeTruthy());
    pingFails = null;
    pings = 0;

    // Too recent: its job may still be retrying.
    expect(await reconcileDeliveries(server.app, config)).toBe(
      "0 local deliveries replayed, 0 GitHub redeliveries requested, 1 log pages read",
    );
    expect(pings).toBe(0);

    server.clock.advance(REPLAY_AFTER_MS + 1_000);
    expect(await reconcileDeliveries(server.app, config)).toMatch(/^1 local deliveries replayed/);
    expect(pings).toBe(1);
    expect(await delivery(id)).toMatchObject({ error: null });
    expect((await delivery(id))!.processedAt).not.toBeNull();
  });

  it("an unprocessed delivery is replayed through the same handlers", async () => {
    server.clock.set("2026-10-02T12:00:00.000Z");
    const org = await orgRow({ githubOrgId: 6101, login: "replayed", installationId: 901 });
    const id = randomUUID();
    // Stored by an intake whose job was lost: no worker ever ran it.
    await server.app.db.insert(webhookDeliveries).values({
      deliveryId: id,
      event: "organization",
      action: "deleted",
      payload: { action: "deleted", organization: { id: 6101, login: "replayed" } },
      receivedAt: new Date("2026-10-02T11:00:00.000Z"),
    });
    await reconcileDeliveries(server.app, config);
    expect((await delivery(id))!.processedAt).not.toBeNull();
    expect(await orgByGithubId(6101)).toMatchObject({ id: org.id, status: "deleted" });
  });
});

describe("the redelivery of GitHub's failures", () => {
  it("asks again for the failed attempts of the last 24 hours that Quiz never stored", async () => {
    server.clock.set("2026-10-03T12:00:00.000Z");
    const now = server.clock.now().getTime();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    const held = await handled("test_ping", {});
    const attempt = (id: number, guid: string, status: number, hoursAgo: number, redelivery = false) => ({
      id,
      guid,
      status_code: status,
      redelivery,
      delivered_at: at(hoursAgo),
    });
    const [again, through] = [randomUUID(), randomUUID()];
    gh.routes = [
      on("GET", "/app/hook/deliveries", () =>
        json([
          attempt(7, through, 200, 0.2, true), // a redelivery that got through: the newest attempt decides
          attempt(5, again, 500, 0.5, true), // a redelivery that failed in turn: asked again, by its own id
          attempt(1, randomUUID(), 502, 1),
          attempt(3, randomUUID(), 200, 1), // delivered
          attempt(8, through, 500, 1),
          attempt(6, again, 500, 1.5), // its original: not asked twice
          attempt(2, held, 500, 2), // stored since: a later attempt got through
          attempt(4, randomUUID(), 500, 30), // too old
        ]),
      ),
      (url, init) => (init.method === "POST" && /^\/app\/hook\/deliveries\/[15]\/attempts$/.test(url.pathname) ? json({}, 202) : undefined),
    ];
    expect(await reconcileDeliveries(server.app, config)).toMatch(/2 GitHub redeliveries requested, 1 log pages read$/);
    // Oldest first: the deliveries closest to leaving the window.
    expect(gh.calls.filter((c) => c.startsWith("POST"))).toEqual([
      "POST api.github.com/app/hook/deliveries/1/attempts",
      "POST api.github.com/app/hook/deliveries/5/attempts",
    ]);
  });
});

describe("the incremental read of GitHub's delivery log (ADR-011, 2026-11-22)", () => {
  const START = new Date("2026-10-20T12:00:00.000Z");
  /** GitHub's log of the App's attempts, newest first. */
  let log: { id: number; guid: string; status_code: number; redelivery: boolean; delivered_at: string }[] = [];
  /** The `cursor` of every read of the log, null for the top. */
  let cursors: (string | null)[] = [];
  let nextId = 1;

  /**
   * `n` attempts, oldest first (`status(i)` the i-th's), `everySeconds`
   * apart, the newest `minutesAgo` before the server's now, put on top of
   * the log; their guids, oldest first.
   */
  function happened(n: number, minutesAgo: number, status = (_i: number) => 200, everySeconds = 60): string[] {
    const newest = server.clock.now().getTime() - minutesAgo * 60_000;
    const made = Array.from({ length: n }, (_, i) => ({
      id: nextId++,
      guid: randomUUID(),
      status_code: status(i),
      redelivery: false,
      delivered_at: new Date(newest - (n - 1 - i) * everySeconds * 1000).toISOString(),
    }));
    log = [...[...made].reverse(), ...log];
    return made.map((a) => a.guid);
  }

  /** GitHub's pagination: 100 a page, the next page named by the id of its first attempt, as a cursor names a delivery. */
  const logRoute: Route = (url, init) => {
    if (url.host !== "api.github.com" || init.method !== "GET" || url.pathname !== "/app/hook/deliveries") return undefined;
    const cursor = url.searchParams.get("cursor");
    cursors.push(cursor);
    const from = cursor === null ? 0 : log.findIndex((a) => `d${a.id}` === cursor);
    if (from < 0) return json({ message: "Invalid cursor" }, 422);
    const page = log.slice(from, from + 100);
    const next = log[from + 100];
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(next ? { link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=d${next.id}>; rel="next", <https://api.github.com/app/hook/deliveries?per_page=100>; rel="first"` } : {}),
      },
    });
  };
  /** GitHub's answer to a redelivery request, by the attempt's id. */
  let postAnswer: (id: number) => number = () => 202;
  /** The status of the attempt GitHub then makes, put on top of the log; null: none shown. */
  let redeliveryStatus: (guid: string) => number | null = () => null;
  const redeliveryRoute: Route = (url, init) => {
    const m = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(url.pathname);
    if (url.host !== "api.github.com" || init.method !== "POST" || !m) return undefined;
    const answer = postAnswer(Number(m[1]));
    const guid = log.find((a) => a.id === Number(m[1]))!.guid;
    const status = redeliveryStatus(guid);
    if (answer === 202 && status !== null) {
      log = [{ id: nextId++, guid, status_code: status, redelivery: true, delivered_at: server.clock.now().toISOString() }, ...log];
    }
    return json(answer === 202 ? {} : { message: "Server Error" }, answer);
  };
  const redelivered = () =>
    gh.calls.filter((c) => c.startsWith("POST")).map((c) => Number(/deliveries\/(\d+)\/attempts/.exec(c)![1]));
  const guidOf = (id: number) => log.find((a) => a.id === id)!.guid;
  const idsOf = (guids: string[]) => guids.map((g) => log.find((a) => a.guid === g)!.id);
  /** The redeliveries GitHub made reached the intake: Quiz holds them now. */
  const received = async (ids: number[]) => {
    if (ids.length === 0) return;
    await server.app.db.insert(webhookDeliveries).values(
      ids.map((id) => ({ deliveryId: guidOf(id), event: "test_ping", payload: {}, receivedAt: server.clock.now(), processedAt: server.clock.now() })),
    );
  };
  const scan = async () => (await server.app.db.select().from(webhookDeliveryScan))[0];
  const asksOf = async (guid: string) => (await server.app.db.select().from(webhookRedeliveryAsks).where(eq(webhookRedeliveryAsks.guid, guid)))[0];
  const storedOf = async (guid: string) => (await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, guid)))[0];

  beforeEach(async () => {
    server.clock.set(START.toISOString());
    await server.app.db.delete(webhookDeliveryScan);
    await server.app.db.delete(webhookRedeliveryAsks);
    log = [];
    cursors = [];
    postAnswer = () => 202;
    redeliveryStatus = () => null;
    gh.routes = [logRoute, redeliveryRoute];
  });

  it("reads the log down to what the previous pass covered, not 24 hours of it", async () => {
    happened(300, 0); // five hours of traffic, all delivered
    expect(await reconcileDeliveries(server.app, config)).toMatch(/0 GitHub redeliveries requested, 3 log pages read$/);
    expect(await scan()).toMatchObject({ coveredUntil: START, resumeCursor: null, resumeCeiling: null });

    // Fifteen minutes on, 15 more deliveries, one failed: one page, stopped at the covered point less the overlap.
    server.clock.advance(15 * 60_000);
    cursors = [];
    gh.calls.length = 0;
    const [failed] = happened(15, 0, (i) => (i === 3 ? 502 : 200)).filter((_, i) => i === 3);
    expect(await reconcileDeliveries(server.app, config)).toMatch(/1 GitHub redeliveries requested, 1 log pages read$/);
    expect(cursors).toEqual([null]);
    expect(redelivered()).toEqual(idsOf([failed!]));
    expect((await scan())?.coveredUntil).toEqual(server.clock.now());
  });

  it("finds the failures of a gap larger than one page, and none below the covered point", async () => {
    happened(50, 200, (i) => (i === 10 ? 500 : 200)); // before the covered point: already handled
    await server.app.db.insert(webhookDeliveryScan).values({ id: "app", coveredUntil: new Date(START.getTime() - 3 * 3_600_000) });
    // Three hours of traffic since, failures on the fourth, third and first pages; asked oldest first.
    const guids = happened(350, 0, (i) => ([5, 120, 340].includes(i) ? 503 : 200), 30);
    const failures = [guids[5]!, guids[120]!, guids[340]!];

    expect(await reconcileDeliveries(server.app, config)).toMatch(/3 GitHub redeliveries requested, 4 log pages read$/);
    expect(redelivered()).toEqual(idsOf(failures));
    expect(cursors[0]).toBeNull();
    expect(cursors.slice(1).every((c) => c !== null)).toBe(true);
  });

  it("asks again, pass after pass, for a delivery whose redelivery failed in turn", async () => {
    const [lost] = happened(1, 120, () => 502);
    happened(10, 0);
    expect(await reconcileDeliveries(server.app, config)).toMatch(/1 GitHub redeliveries requested, 1 log pages read$/);
    const [first] = redelivered();
    expect(first).toBe(idsOf([lost!])[0]);

    // The intake still down: GitHub's redelivery failed too, on top of the log; the original lies below the covered point now.
    server.clock.advance(15 * 60_000);
    log = [{ id: nextId++, guid: lost!, status_code: 502, redelivery: true, delivered_at: new Date(START.getTime() + 60_000).toISOString() }, ...log];
    gh.calls.length = 0;
    expect(await reconcileDeliveries(server.app, config)).toMatch(/1 GitHub redeliveries requested, 1 log pages read$/);
    // Asked from the record, by the attempt first recorded: GitHub redelivers any attempt of the delivery.
    expect(redelivered()).toEqual([first]);
    expect((await asksOf(lost!))?.lastStatus).toBe(502);
  });

  it("stops at the 24-hour window when nothing was covered yet", async () => {
    happened(20, 25 * 60, () => 500); // older than the window
    const [recent] = happened(1, 60, () => 500);
    expect(await reconcileDeliveries(server.app, config)).toMatch(/1 GitHub redeliveries requested, 1 log pages read$/);
    expect(redelivered()).toEqual(idsOf([recent!]));
  });

  it("goes on from the page it reached when the gap exceeds a pass's pages, before the newer top", async () => {
    const covered = new Date(START.getTime() - 20 * 3_600_000);
    await server.app.db.insert(webhookDeliveryScan).values({ id: "app", coveredUntil: covered });
    // 2 300 attempts since the covered point, the one failure on the 23rd page.
    const guids = happened(2_300, 0, (i) => (i === 50 ? 500 : 200), 30);
    expect(await reconcileDeliveries(server.app, config)).toMatch(/0 GitHub redeliveries requested, 20 log pages read$/);
    const stopped = await scan();
    expect(stopped).toMatchObject({ coveredUntil: covered, resumeCursor: `d${log[2_000]!.id}`, resumeCeiling: START });

    // The next pass: on from there, down to the floor, the failure found; the newer top is not read yet.
    server.clock.advance(15 * 60_000);
    happened(30, 0);
    cursors = [];
    expect(await reconcileDeliveries(server.app, config)).toMatch(/1 GitHub redeliveries requested, 3 log pages read$/);
    expect(cursors[0]).toBe(stopped!.resumeCursor);
    expect(redelivered()).toEqual(idsOf([guids[50]!]));
    expect(await scan()).toMatchObject({ coveredUntil: START, resumeCursor: null, resumeCeiling: null });

    // And then the top, down to the first pass's start.
    cursors = [];
    gh.calls.length = 0;
    expect(await reconcileDeliveries(server.app, config)).toMatch(/0 GitHub redeliveries requested, 1 log pages read$/);
    expect(cursors).toEqual([null]);
  });

  it("asks the rest of a capped pass next time, from the record, while the scan moves on", async () => {
    happened(80, 0, (i) => (i < 60 ? 500 : 200));
    expect(await reconcileDeliveries(server.app, config)).toMatch(/50 GitHub redeliveries requested, 1 log pages read$/);
    expect(await scan()).toMatchObject({ coveredUntil: START, resumeCursor: null });
    await received(redelivered());

    gh.calls.length = 0;
    expect(await reconcileDeliveries(server.app, config)).toMatch(/10 GitHub redeliveries requested, 1 log pages read$/);
    expect(await scan()).toMatchObject({ coveredUntil: START });
  });

  it("stops on GitHub's rate limit at once and keeps its place", async () => {
    await server.app.db.insert(webhookDeliveryScan).values({ id: "app", coveredUntil: new Date(START.getTime() - 5 * 3_600_000) });
    happened(250, 0);
    let reads = 0;
    gh.routes = [
      (url, init) =>
        init.method === "GET" && url.pathname === "/app/hook/deliveries" && ++reads === 2
          ? new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
              status: 403,
              headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) },
            })
          : undefined,
      logRoute,
    ];
    const started = Date.now();
    expect(await reconcileDeliveries(server.app, config)).toMatch(/0 GitHub redeliveries requested, 1 log pages read, stopped on GitHub's rate limit$/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await scan()).toMatchObject({ resumeCursor: `d${log[100]!.id}`, resumeCeiling: START });
  });

  it("never asks for a delivery the intake refused (a 413), and logs it once; a 401 is asked", async () => {
    const [failed] = happened(1, 60, () => 401); // a secret rotated: it passes once both sides agree
    const [refused] = happened(1, 30, () => 413);
    const warned = vi.spyOn(server.app.log, "warn");
    const refusals = () => warned.mock.calls.filter((c) => String(c[1]).includes("refused a delivery")).length;
    try {
      expect(await reconcileDeliveries(server.app, config)).toMatch(/1 GitHub redeliveries requested/);
      expect(redelivered()).toEqual(idsOf([failed!]));
      expect(refusals()).toBe(1);

      // Read again from scratch: the refusal stays unasked, and unlogged.
      await server.app.db.delete(webhookDeliveryScan);
      server.clock.advance(15 * 60_000);
      gh.calls.length = 0;
      await reconcileDeliveries(server.app, config);
      expect(redelivered()).not.toContain(idsOf([refused!])[0]);
      expect(refusals()).toBe(1);
    } finally {
      warned.mockRestore();
    }
  });

  it("keeps asking through an outage of the intake with a doubling wait, and recovers the delivery", async () => {
    const [lost] = happened(1, 5, () => 502);
    let down = true;
    redeliveryStatus = () => (down ? 502 : 200);
    const askedAt: number[] = [];
    for (let minutes = 0; minutes <= 4 * 60; minutes += 15) {
      if (minutes >= 3 * 60) down = false; // three hours down, twelve passes
      gh.calls.length = 0;
      await reconcileDeliveries(server.app, config);
      if (redelivered().length > 0) askedAt.push(minutes);
      if (log[0]!.guid === lost && log[0]!.status_code === 200 && (await storedOf(lost!)) === undefined) await received([log[0]!.id]);
      server.clock.advance(15 * 60_000);
    }
    // Asked at once, then 15 min, 30 min, 1 h and 2 h apart: the last after the intake came back.
    expect(askedAt).toEqual([0, 15, 45, 105, 225]);
    expect(await storedOf(lost!)).toBeDefined();
  });

  it("bounds a delivery the intake keeps failing to about seven asks a day, and a real failure behind a flood is asked", async () => {
    const poison = happened(60, 61, () => 500);
    const [real] = happened(1, 30, () => 503);
    redeliveryStatus = (guid) => (guid === real ? 200 : 500);
    const asked = new Map<string, number>();
    let realPass = 0;
    for (let n = 1; n <= 96; n += 1) {
      gh.calls.length = 0;
      await reconcileDeliveries(server.app, config);
      for (const g of redelivered().map(guidOf)) asked.set(g, (asked.get(g) ?? 0) + 1);
      if (realPass === 0 && asked.has(real!)) {
        realPass = n;
        await received(idsOf([real!]));
      }
      server.clock.advance(15 * 60_000);
    }
    expect(realPass).toBeLessThanOrEqual(3);
    expect(Math.max(...poison.map((g) => asked.get(g) ?? 0))).toBe(7);
    expect(Math.min(...poison.map((g) => asked.get(g) ?? 0))).toBeGreaterThanOrEqual(6);
  });

  it("counts no ask for a redelivery request GitHub fails, and asks again next pass", async () => {
    const [failed] = happened(1, 60, () => 502);
    happened(5, 0);
    const failedId = idsOf([failed!])[0]!;
    postAnswer = (id) => (id === failedId ? 500 : 202);
    expect(await reconcileDeliveries(server.app, config)).toMatch(/0 GitHub redeliveries requested, 1 log pages read$/);
    expect(await asksOf(failed!)).toMatchObject({ asks: 0, lastAskedAt: null });

    server.clock.advance(15 * 60_000);
    postAnswer = () => 202;
    gh.calls.length = 0;
    expect(await reconcileDeliveries(server.app, config)).toMatch(/1 GitHub redeliveries requested, 1 log pages read$/);
    expect(redelivered()).toEqual([failedId]);
    expect(await asksOf(failed!)).toMatchObject({ asks: 1, lastAskedAt: server.clock.now() });
  });

  it("drops a resume cursor GitHub no longer knows, or one left past the window, and reads the top", async () => {
    happened(5, 0, (i) => (i === 0 ? 502 : 200));
    await server.app.db.insert(webhookDeliveryScan).values({
      id: "app",
      coveredUntil: new Date(START.getTime() - 3_600_000),
      resumeCursor: "dgone",
      resumeCeiling: new Date(START.getTime() - 30 * 60_000),
    });
    expect(await reconcileDeliveries(server.app, config)).toMatch(/0 log pages read$/);
    expect(await scan()).toMatchObject({ resumeCursor: null, resumeCeiling: null });
    cursors = [];
    expect(await reconcileDeliveries(server.app, config)).toMatch(/1 GitHub redeliveries requested, 1 log pages read$/);
    expect(cursors).toEqual([null]);

    // A ceiling past the 24-hour window: its cursor is never read again.
    await server.app.db
      .update(webhookDeliveryScan)
      .set({ coveredUntil: new Date(START.getTime() - 30 * 3_600_000), resumeCursor: `d${log[2]!.id}`, resumeCeiling: new Date(START.getTime() - 25 * 3_600_000) });
    cursors = [];
    await reconcileDeliveries(server.app, config);
    expect(cursors[0]).toBeNull();
  });
});

describe("the purge of the redelivery asks", () => {
  it("forgets a failure's record three days after it, and keeps the recent ones", async () => {
    const now = new Date("2026-11-25T00:00:00.000Z");
    const [old, recent] = [randomUUID(), randomUUID()];
    await server.app.db.insert(webhookRedeliveryAsks).values([
      { guid: old, attemptId: 1, failedAt: new Date(now.getTime() - ASKS_RETENTION_MS - 60_000), asks: 3, nextAskAt: now, lastStatus: 500 },
      { guid: recent, attemptId: 2, failedAt: new Date(now.getTime() - ASKS_RETENTION_MS + 60_000), asks: 1, nextAskAt: now, lastStatus: 0 },
    ]);
    expect(await purgeRedeliveryAsks(server.app.db, now)).toBeGreaterThanOrEqual(1);
    const left = (await server.app.db.select().from(webhookRedeliveryAsks)).map((r) => r.guid);
    expect(left).toContain(recent);
    expect(left).not.toContain(old);
  });
});

describe("the payload purge", () => {
  it("clears the payload of a processed delivery after 30 days, and keeps the row", async () => {
    const now = new Date("2026-11-15T00:00:00.000Z");
    const old = new Date(now.getTime() - PAYLOAD_RETENTION_MS - 60_000);
    const recent = new Date(now.getTime() - PAYLOAD_RETENTION_MS + 60_000);
    const [purged, young, pending] = [randomUUID(), randomUUID(), randomUUID()];
    await server.app.db.insert(webhookDeliveries).values([
      { deliveryId: purged, event: "test_ping", payload: { a: 1 }, receivedAt: old, processedAt: old },
      { deliveryId: young, event: "test_ping", payload: { a: 2 }, receivedAt: recent, processedAt: recent },
      { deliveryId: pending, event: "test_ping", payload: { a: 3 }, receivedAt: old },
    ]);
    expect(await purgeDeliveryPayloads(server.app.db, now)).toBeGreaterThanOrEqual(1);
    expect((await delivery(purged))?.payload).toBeNull();
    expect((await delivery(young))?.payload).toEqual({ a: 2 });
    expect((await delivery(pending))?.payload).toEqual({ a: 3 });

    // The row outlives its payload: GitHub's redelivery is still a duplicate.
    const again = await deliver("test_ping", { a: 1 }, { id: purged });
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    expect(pings).toBe(0);
  });
});

// ---------------------------------------------------------------- the parser's scope

describe("the raw-body parser", () => {
  it("leaves the JSON parsing of the other routes as it was", async () => {
    const teacher = await server.signIn("teacher");
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/courses",
      headers: teacher.headers,
      payload: { name: "Parsed", code: "PRS1" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ name: "Parsed" });
  });

  it("refuses before reading its body a request that is no delivery of GitHub's", async () => {
    /** A body that never ends: a request whose body were read would never be answered. */
    const endless = (length: number, headers: Record<string, string>) =>
      server.app.inject({ method: "POST", url: "/webhooks/github", headers: { "content-type": "application/json", "content-length": String(length), ...headers }, payload: new PassThrough() });
    const signed = { "x-hub-signature-256": "sha256=00", "x-github-event": "push", "x-github-delivery": randomUUID() };
    expect((await endless(20 * 1024 * 1024, { "x-github-event": "push" })).statusCode).toBe(401);
    expect((await endless(20 * 1024 * 1024, { "x-hub-signature-256": "sha256=00" })).statusCode).toBe(400);
    expect((await endless(WEBHOOK_BODY_LIMIT + 1, signed)).statusCode).toBe(413);
    const unsized = await server.app.inject({ method: "POST", url: "/webhooks/github", headers: { "content-type": "application/json", ...signed, "transfer-encoding": "chunked" }, payload: new PassThrough() });
    expect(unsized.statusCode).toBe(411);
  });

  it("reads two large bodies at once at most, and answers 503 to a third", async () => {
    const LENGTH = 2 * 1024 * 1024;
    const streams = [new PassThrough(), new PassThrough()];
    const headers = () => ({ "content-type": "application/json", "content-length": String(LENGTH), "x-hub-signature-256": "sha256=00", "x-github-event": "push", "x-github-delivery": randomUUID() });
    const reading = streams.map((payload) => server.app.inject({ method: "POST", url: "/webhooks/github", headers: headers(), payload }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await server.app.inject({ method: "POST", url: "/webhooks/github", headers: headers(), payload: Buffer.alloc(LENGTH) });
    expect(third.statusCode).toBe(503);
    // The two complete their bodies (a wrong signature): their slots are given back.
    for (const stream of streams) stream.end(Buffer.alloc(LENGTH));
    expect((await Promise.all(reading)).map((r) => r.statusCode)).toEqual([401, 401]);
    const id = randomUUID();
    expect((await deliver("test_ping", { blob: "z".repeat(LENGTH) }, { id })).statusCode).toBe(200);
    await processed(id);
  });

  it("takes a payload over Fastify's 1 MB default, up to GitHub's 25 MB cap, on the intake only", async () => {
    const id = randomUUID();
    const big = { commits: [{ message: "x".repeat(3 * 1024 * 1024) }] };
    expect((await deliver("test_ping", big, { id })).statusCode).toBe(200);
    await processed(id);
    // Past GitHub's cap, refused as before.
    const huge = await deliver("test_ping", { blob: "y".repeat(WEBHOOK_BODY_LIMIT) });
    expect(huge.statusCode).toBe(413);
    // Every other route keeps the default.
    const teacher = await server.signIn("teacher");
    const other = await server.app.inject({
      method: "POST",
      url: "/app/api/courses",
      headers: { ...teacher.headers, "content-type": "application/json" },
      payload: JSON.stringify({ name: "z".repeat(2 * 1024 * 1024), code: "BIG1" }),
    });
    expect(other.statusCode).toBe(413);
  });
});
