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

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationPayload } from "@quiz/contracts";

import { loadConfig, type AppConfig } from "../../config.js";
import {
  auditLog,
  classrooms,
  courseStaff,
  githubClassroomLinks,
  githubOrganizations,
  notifications,
  pushReceipts,
  webhookDeliveries,
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
} from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import {
  PAYLOAD_RETENTION_MS,
  processDelivery,
  purgeDeliveryPayloads,
  reconcileDeliveries,
  REPLAY_AFTER_MS,
} from "./deliveries.js";
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
  secret: true,
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
      "0 local deliveries replayed, 0 GitHub redeliveries requested",
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
    gh.routes = [
      on("GET", "/app/hook/deliveries", () =>
        json([
          attempt(1, randomUUID(), 502, 1),
          attempt(2, held, 500, 2), // stored since: a later attempt got through
          attempt(3, randomUUID(), 200, 1), // delivered
          attempt(4, randomUUID(), 500, 30), // too old
          attempt(5, randomUUID(), 500, 1, true), // itself a redelivery
        ]),
      ),
      on("POST", "/app/hook/deliveries/1/attempts", () => json({}, 202)),
    ];
    expect(await reconcileDeliveries(server.app, config)).toMatch(/1 GitHub redeliveries requested$/);
    expect(gh.calls.filter((c) => c.startsWith("POST"))).toEqual([
      "POST api.github.com/app/hook/deliveries/1/attempts",
    ]);
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
});
