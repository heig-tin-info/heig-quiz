/**
 * The webhook intake, its handler registry and the delivery reconciliation
 * (M2-04; ported from heig-classroom's `webhooks.db.test.ts`), on a server
 * built with Quiz's App and a webhook secret, against a fake GitHub
 * (`github/testing.ts`). The test server has no queue (`JOBS_DISABLED`), so
 * a stored delivery is handled beside the request: the tests wait for its
 * `processed_at`, never for the wall clock.
 */
import { createHmac, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../../config.js";
import {
  auditLog,
  githubOrganizations,
  pushReceipts,
  webhookDeliveries,
} from "../../db/schema.js";
import { appKey, fakeGithub, json, on } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { createClassroom, createCourse } from "../org/service.js";
import {
  PAYLOAD_RETENTION_MS,
  purgeDeliveryPayloads,
  reconcileDeliveries,
  REPLAY_AFTER_MS,
} from "./deliveries.js";
import { onEvent, onReceipt, resetGithubCaches } from "./service.js";

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

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

interface DeliverOptions {
  id?: string;
  signature?: string | null;
  headers?: Record<string, string>;
  body?: string;
}

function deliver(event: string, payload: object, opts: DeliverOptions = {}) {
  const body = opts.body ?? JSON.stringify(payload);
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  return server.app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.id ?? randomUUID(),
      ...(signature === null ? {} : { "x-hub-signature-256": signature }),
      ...opts.headers,
    },
    payload: body,
  });
}

async function delivery(id: string) {
  const [row] = await server.app.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.deliveryId, id));
  return row;
}

const processed = (id: string) =>
  vi.waitFor(async () => expect((await delivery(id))?.processedAt).not.toBeNull());

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
  gh.reset();
  pings = 0;
  pingFails = null;
});

// ---------------------------------------------------------------- the intake

describe("the signature (N-SEC-17)", () => {
  it("answers 401 to a missing, a wrong or a foreign signature, and stores nothing", async () => {
    for (const signature of [null, "sha256=00", "sha1=abc", sign("{}", "another-secret".repeat(3))]) {
      const id = randomUUID();
      const res = await deliver("test_ping", { zen: "hi" }, { id, signature });
      expect(res.statusCode, String(signature)).toBe(401);
      expect(await delivery(id)).toBeUndefined();
    }
    expect(pings).toBe(0);
  });

  it("answers 401 to a body changed after it was signed", async () => {
    const id = randomUUID();
    const res = await deliver("test_ping", {}, { id, signature: sign('{"a":1}'), body: '{"a":2}' });
    expect(res.statusCode).toBe(401);
    expect(await delivery(id)).toBeUndefined();
  });

  it("needs no session at all", async () => {
    const id = randomUUID();
    const res = await deliver("test_ping", {}, { id });
    expect(res.statusCode).toBe(200);
    await processed(id);
  });
});

describe("the headers and the body, once signed", () => {
  it("answers 400 to a malformed delivery id, and stores nothing", async () => {
    const res = await deliver("test_ping", {}, { id: "not-a-guid" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_headers");
  });

  it("answers 400 without an event", async () => {
    const id = randomUUID();
    const body = "{}";
    const res = await server.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": id,
        "x-hub-signature-256": sign(body),
      },
      payload: body,
    });
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
    const row = await delivery(id);
    expect(row).toMatchObject({ event: "test_ping", action: "hello", error: null });
  });

  it("stores the server's receipt time (invariant 5)", async () => {
    server.clock.set("2026-10-01T09:00:00.000Z");
    const id = randomUUID();
    await deliver("test_ping", {}, { id });
    expect((await delivery(id))?.receivedAt.toISOString()).toBe("2026-10-01T09:00:00.000Z");
  });

  it("answers in under 100 ms", async () => {
    // Warm: the first request of a server compiles its routes' schemas.
    const warm = randomUUID();
    await deliver("test_ping", {}, { id: warm });
    await processed(warm);
    const id = randomUUID();
    const start = performance.now();
    const res = await deliver("test_ping", { zen: "Keep it logically awesome." }, { id });
    const elapsed = performance.now() - start;
    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(100);
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
    expect(await receipts(TRACKED)).toMatchObject([
      {
        branch: "main",
        headSha: sha("a"),
        isBot: false,
        forced: false,
      },
    ]);
    expect((await receipts(TRACKED))[0]!.receivedAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");

    // The same head, delivered again later under another id: the first receipt stands.
    server.clock.advance(3_600_000);
    await deliver("push", push(TRACKED, sha("a")));
    const [kept] = await receipts(TRACKED);
    expect(kept!.receivedAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(await receipts(TRACKED)).toHaveLength(1);
  });

  it("marks the App's bot and a workflow's push as bot pushes", async () => {
    await deliver("push", push(TRACKED, sha("b"), { sender: { login: "quiz-test[bot]" }, forced: true }));
    await deliver("push", push(TRACKED, sha("c"), { sender: { login: "github-actions[bot]" } }));
    const rows = await receipts(TRACKED);
    expect(rows.find((r) => r.headSha === sha("b"))).toMatchObject({ isBot: true, forced: true });
    expect(rows.find((r) => r.headSha === sha("c"))).toMatchObject({ isBot: true });
  });

  it("is not written for an untracked repository, nor a deleted branch", async () => {
    await deliver("push", push(9002, sha("d")));
    await deliver("push", push(TRACKED, "0".repeat(40)));
    expect(await receipts(9002)).toEqual([]);
    expect((await receipts(TRACKED)).some((r) => r.headSha === "0".repeat(40))).toBe(false);
  });
});

// ---------------------------------------------------------------- the handlers

describe("installation events", () => {
  const installation = (action: string, id: number, account: object) => ({
    action,
    installation: { id, account, repository_selection: "all" },
  });
  const heig = { id: 5001, login: "heig-hooked", type: "Organization" };

  it("records a created installation, then forgets a deleted one", async () => {
    const created = randomUUID();
    await deliver("installation", installation("created", 701, heig), { id: created });
    await processed(created);
    const org = await orgByGithubId(5001);
    expect(org).toMatchObject({ login: "heig-hooked", installationId: 701, status: "active" });
    const [resolved] = await audits("github_org.installation_resolved", org!.id);
    expect(resolved!.payload).toMatchObject({ installationId: 701, via: "webhook" });

    const deleted = randomUUID();
    await deliver("installation", installation("deleted", 701, heig), { id: deleted });
    await processed(deleted);
    expect(await orgByGithubId(5001)).toMatchObject({ installationId: null, status: "active" });
    const [gone] = await audits("github_org.installation_deleted", org!.id);
    expect(gone!.payload).toMatchObject({ via: "webhook", action: "deleted", installationId: 701 });

    // A replay writes and audits nothing more.
    const replay = randomUUID();
    await deliver("installation", installation("deleted", 701, heig), { id: replay });
    await processed(replay);
    expect(await audits("github_org.installation_deleted", org!.id)).toHaveLength(1);
  });

  it("forgets a suspended installation and records it again when unsuspended", async () => {
    const acct = { id: 5002, login: "heig-suspended", type: "Organization" };
    for (const action of ["created", "suspend"]) {
      const id = randomUUID();
      await deliver("installation", installation(action, 702, acct), { id });
      await processed(id);
    }
    expect((await orgByGithubId(5002))?.installationId).toBeNull();
    const id = randomUUID();
    await deliver("installation", installation("unsuspend", 702, acct), { id });
    await processed(id);
    expect((await orgByGithubId(5002))?.installationId).toBe(702);
  });

  it("ignores a user's installation", async () => {
    const id = randomUUID();
    await deliver("installation", installation("created", 703, { id: 5003, login: "someone", type: "User" }), { id });
    await processed(id);
    expect(await orgByGithubId(5003)).toBeUndefined();
  });
});

describe("organization events", () => {
  it("follows a rename by id, and retires the row that held the new login", async () => {
    const org = await orgRow({ githubOrgId: 6001, login: "old-name", installationId: 801 });
    const squatter = await orgRow({ githubOrgId: 6002, login: "new-name" });
    const id = randomUUID();
    await deliver("organization", { action: "renamed", organization: { id: 6001, login: "new-name" } }, { id });
    await processed(id);
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
    const id = randomUUID();
    await deliver("organization", { action: "deleted", organization: { id: 6003, login: "doomed" } }, { id });
    await processed(id);
    expect(await orgByGithubId(6003)).toMatchObject({ status: "deleted", installationId: null });
    expect(await audits("github_org.deleted", org.id)).toHaveLength(1);
  });

  it("ignores an organization Quiz does not know", async () => {
    const id = randomUUID();
    await deliver("organization", { action: "deleted", organization: { id: 6999, login: "stranger" } }, { id });
    await processed(id);
    expect(await orgByGithubId(6999)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- failures and reconciliation

describe("a failed delivery", () => {
  it("keeps its error, tokens masked, and is replayed by the reconciliation", async () => {
    server.clock.set("2026-10-01T12:00:00.000Z");
    pingFails = "GitHub said no to ghs_secrettoken123";
    const id = randomUUID();
    await deliver("test_ping", {}, { id });
    await vi.waitFor(async () => expect((await delivery(id))?.error).toBeTruthy());
    const failed = await delivery(id);
    expect(failed!.processedAt).toBeNull();
    expect(failed!.error).toContain("gh*_***");
    expect(failed!.error).not.toContain("secrettoken");

    // Too recent: its job may still be retrying.
    pingFails = null;
    pings = 0;
    await reconcileDeliveries(server.app, config);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pings).toBe(0);

    server.clock.advance(REPLAY_AFTER_MS + 1_000);
    const summary = await reconcileDeliveries(server.app, config);
    expect(summary).toMatch(/^\d+ local deliveries replayed, 0 GitHub redeliveries requested$/);
    await processed(id);
    expect(pings).toBe(1);
    expect((await delivery(id))!.error).toBeNull();
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
    await processed(id);
    expect(await orgByGithubId(6101)).toMatchObject({ id: org.id, status: "deleted" });
  });
});

describe("the redelivery of GitHub's failures", () => {
  it("asks again for the failed attempts of the last 24 hours that Quiz never stored", async () => {
    server.clock.set("2026-10-03T12:00:00.000Z");
    const now = server.clock.now().getTime();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    const held = randomUUID();
    await deliver("test_ping", {}, { id: held });
    await processed(held);
    const attempt = (id: number, guid: string, status: number, hoursAgo: number, redelivery = false) => ({
      id,
      guid,
      status_code: status,
      redelivery,
      delivered_at: at(hoursAgo),
    });
    const lost = randomUUID();
    gh.routes = [
      on("GET", "/app/hook/deliveries", () =>
        json([
          attempt(1, lost, 502, 1),
          attempt(2, held, 500, 2), // stored since: a later attempt got through
          attempt(3, randomUUID(), 200, 1), // delivered
          attempt(4, randomUUID(), 500, 30), // too old
          attempt(5, randomUUID(), 500, 1, true), // itself a redelivery
        ]),
      ),
      on("POST", "/app/hook/deliveries/1/attempts", () => json({}, 202)),
    ];
    const summary = await reconcileDeliveries(server.app, config);
    expect(summary).toMatch(/1 GitHub redeliveries requested$/);
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
  it("leaves the JSON parsing of every other route as it was", async () => {
    const teacher = await server.signIn("teacher");
    const course = await createCourse(server.app.db, { name: "Hooks", code: "HK1" }, teacher.id);
    const room = await createClassroom(server.app.db, course!.id, { name: "HK1-A", period: "2026" });
    // A route of the same module: the body is read (an unknown organization, not a 400 nor a 415).
    const put = await server.app.inject({
      method: "PUT",
      url: `/app/api/classrooms/${room.id}/github`,
      headers: teacher.headers,
      payload: { orgId: randomUUID() },
    });
    expect(put.statusCode, put.body).toBe(404);
    // A route of another module.
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
