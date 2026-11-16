/**
 * `POST /api/assignments/:id/collections` (ADR-130 §4): the service token,
 * the order's checks, one collection at a time per (student, assignment),
 * and the portal's record. The git work itself is `git/collect.test.ts`'s.
 */
import cookie from "@fastify/cookie";
import type { CodespaceCollectionResult } from "@quiz/contracts";
import { requestBinding, signHs256 } from "@quiz/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../auth/config.js";
import { openDb, type DbHandle } from "../db/client.js";
import { collections, sessions, users } from "../db/schema.js";
import { CollectionRefused, type CollectionOrder } from "../git/collect.js";
import { createSebVerifier } from "../seb/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { createSittingSockets } from "../sessions/sittings.js";
import { upsertAssignment } from "../sessions/store.js";

import { classroomRoutes } from "./routes.js";

const SECRET = "test-launch-secret-0123456789012345";
const PROJECT = "0b8e2f0a-6c1e-4c55-9a43-2f1e0c9d8a11";
const USER = "6f1c2a8e-1b2c-4d5e-8f90-123456789abc";
const URL = `/api/assignments/${PROJECT}/collections`;
const now = () => Math.floor(Date.now() / 1000);

let jti = 0;
async function serviceToken(method: string, url: string, body?: unknown): Promise<string> {
  jti += 1;
  return signHs256(
    {
      iss: "heig-quiz",
      aud: "heig-codespace-api",
      iat: now(),
      exp: now() + 120,
      jti: `collect-${jti}`,
      ...(await requestBinding(method, url, body === undefined ? undefined : JSON.stringify(body))),
    },
    SECRET,
  );
}

const order = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  repository: "heig-tin-info/lab3-alice",
  branch: "main",
  base: "a".repeat(40),
  target: null,
  keep: [".github/workflows"],
  ref: "refs/quiz/collect/r1-1794836400",
  ...over,
});

type Collect = (o: CollectionOrder, lastPushAt: Date | null) => Promise<CodespaceCollectionResult>;

let handle: DbHandle;
let app: FastifyInstance;

async function harness(collect?: Collect): Promise<void> {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    PUBLIC_URL: "http://portal.test",
    PLATFORM_URL: "http://quiz.test",
    CODESPACE_LAUNCH_SECRET: SECRET,
    SEB_VERIFIER: "simulated",
    DATABASE_PATH: ":memory:",
  } as NodeJS.ProcessEnv);
  handle = openDb(":memory:");
  const at = new Date();
  upsertAssignment(handle.db, { id: PROJECT, title: "Lab 3", image: "img", createdAt: at });
  upsertAssignment(handle.db, { id: "review-r1", title: "Review", image: "img", createdAt: at, reviewOf: { projectId: PROJECT, projectRepoId: "r1" } });
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(classroomRoutes, {
    config,
    db: handle.db,
    manager: {} as SessionManager,
    verifier: createSebVerifier({ mode: "simulated", nodeEnv: "test", url: { publicOrigin: "http://portal.test" } }),
    sittingSockets: createSittingSockets(),
    ...(collect ? { collect } : {}),
  });
  await app.ready();
}

function openSession(fullName = "heig-tin-info/lab3-alice"): void {
  const at = new Date();
  handle.db.insert(users).values({ id: "u1", oidcSub: `classroom:${USER}`, login: USER, email: "a@heig-vd.ch", createdAt: at }).run();
  handle.db
    .insert(sessions)
    .values({
      id: "s1",
      userId: "u1",
      student: USER,
      assignmentId: PROJECT,
      volumeDir: "/srv/v",
      state: "closed",
      createdAt: at,
      lastSeen: at,
      cookieToken: "c",
      targetRepo: { fullName, defaultBranch: "main" },
    })
    .run();
}

async function post(body: unknown, url = URL, token?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token ?? (await serviceToken("POST", url, body))}` },
    payload: body as object,
  });
}

const pushed: CodespaceCollectionResult = {
  outcome: "pushed",
  tree: "c".repeat(40),
  commit: "d".repeat(40),
  snapshotAt: "2026-11-16T13:40:21.000Z",
  unreadable: 1,
};

afterEach(async () => {
  await app.close();
  handle.close();
});

describe("POST /api/assignments/:id/collections", () => {
  let collect: ReturnType<typeof vi.fn<Collect>>;
  beforeEach(async () => {
    collect = vi.fn<Collect>(async () => pushed);
    await harness(collect);
  });

  it("401 without a service token, or with one bound to another request", async () => {
    expect((await app.inject({ method: "POST", url: URL, payload: order() })).statusCode).toBe(401);
    expect((await post(order(), URL, await serviceToken("POST", URL, order({ branch: "other" })))).statusCode).toBe(401);
    expect((await post(order(), URL, await serviceToken("PUT", URL, order()))).statusCode).toBe(401);
    expect(collect).not.toHaveBeenCalled();
  });

  it("400 for a hostile order, before anything runs", async () => {
    openSession();
    for (const bad of [{ ref: "refs/heads/main" }, { keep: ["../x"] }, { base: "HEAD" }, { branch: "--force" }, { force: true }]) {
      expect((await post(order(bad))).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(collect).not.toHaveBeenCalled();
    expect(handle.db.select().from(collections).all()).toEqual([]);
  });

  it("404 for an unknown assignment, 400 for a review, 409 for another repository than the session's", async () => {
    openSession("heig-tin-info/lab3-bob");
    expect((await post(order(), "/api/assignments/nope/collections")).statusCode).toBe(404);
    expect((await post(order(), "/api/assignments/review-r1/collections")).statusCode).toBe(400);
    expect((await post(order())).statusCode).toBe(409);
    expect(collect).not.toHaveBeenCalled();
  });

  it("collects the session's workspace and records the order with its outcome", async () => {
    openSession();
    const res = await post(order());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(pushed);
    expect(collect).toHaveBeenCalledWith({ ...order(), assignment: PROJECT }, null);
    const [row] = handle.db.select().from(collections).all();
    expect(row).toMatchObject({ student: USER, assignment: PROJECT, outcome: "pushed", tree: pushed.tree, commit: "d".repeat(40), base: "a".repeat(40) });
  });

  it("answers no_snapshot for a student who never opened a session, without touching a volume", async () => {
    const res = await post(order());
    expect(res.json()).toEqual({ outcome: "no_snapshot" });
    expect(collect).not.toHaveBeenCalled();
    expect(handle.db.select().from(collections).all()).toHaveLength(1);
  });

  it("400 when the portal's own check refuses a value", async () => {
    openSession();
    collect.mockRejectedValueOnce(new CollectionRefused("keep"));
    expect((await post(order())).statusCode).toBe(400);
  });

  it("runs one collection at a time for a (student, assignment)", async () => {
    openSession();
    const events: string[] = [];
    let release: () => void = () => undefined;
    collect.mockImplementationOnce(async () => {
      events.push("first started");
      await new Promise<void>((resolve) => (release = resolve));
      events.push("first ended");
      return pushed;
    });
    collect.mockImplementationOnce(async () => {
      events.push("second started");
      return { outcome: "unchanged", tree: "c".repeat(40), snapshotAt: pushed.snapshotAt, unreadable: 0 };
    });
    const first = post(order());
    const second = post(order({ ref: "refs/quiz/collect/r1-1794836401" }));
    await vi.waitFor(() => expect(events).toEqual(["first started"]));
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["first started"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first started", "first ended", "second started"]);
  });
});

describe("without a forge", () => {
  it("503: nothing can be carried to GitHub", async () => {
    await harness();
    openSession();
    expect((await post(order())).statusCode).toBe(503);
  });
});
