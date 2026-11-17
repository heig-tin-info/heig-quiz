/**
 * `POST /api/assignments/:id/collections` (ADR-130 §4): the service token,
 * the order parsed by its contract before anything runs, and one collection
 * at a time per (student, assignment). The git work itself is
 * `git/collect.test.ts`'s.
 */
import cookie from "@fastify/cookie";
import type { CodespaceCollectionResult } from "@quiz/contracts";
import { requestBinding, signHs256 } from "@quiz/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../auth/config.js";
import { openDb, type DbHandle } from "../db/client.js";
import type { CollectionOrder } from "../git/collect.js";
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
  base: "a".repeat(40),
  target: null,
  keep: ["tests"],
  ref: "refs/quiz/collect/r1-1794836400",
  ...over,
});

type Collect = (o: CollectionOrder) => Promise<CodespaceCollectionResult>;

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

async function post(body: unknown, url = URL, token?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token ?? (await serviceToken("POST", url, body))}` },
    payload: body as object,
  });
}

const pushed: CodespaceCollectionResult = { outcome: "pushed", tree: "c".repeat(40), snapshotAt: "2026-11-16T13:40:21.000Z", unreadable: 1 };

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
    expect((await post(order(), URL, await serviceToken("POST", URL, order({ target: "b".repeat(40) })))).statusCode).toBe(401);
    expect((await post(order(), URL, await serviceToken("PUT", URL, order()))).statusCode).toBe(401);
    expect(collect).not.toHaveBeenCalled();
  });

  it("400 for a hostile order: refused before any snapshot, token request or git process", async () => {
    for (const bad of [
      { ref: "refs/heads/main" },
      { ref: "refs/quiz/collect/../../heads/main" },
      { base: "HEAD" },
      { target: "--upload-pack=touch /tmp/x" },
      { keep: ["../../etc/passwd"] },
      { keep: ["/etc/passwd"] },
      { keep: ["-n"] },
      { keep: [".git/config"] },
      { userId: ".." },
      { repository: "owner/name/extra" },
      { force: true },
    ]) {
      expect((await post(order(bad))).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // `collect` is the only way to a snapshot, a token or a git process.
    expect(collect).not.toHaveBeenCalled();
  });

  it("404 for an unknown assignment, 400 for a review", async () => {
    expect((await post(order(), "/api/assignments/nope/collections")).statusCode).toBe(404);
    expect((await post(order(), "/api/assignments/review-r1/collections")).statusCode).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });

  it("collects the workspace with the order as parsed and the student's last push", async () => {
    const res = await post(order());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(pushed);
    expect(collect).toHaveBeenCalledWith({ ...order(), assignment: PROJECT });
  });

  it("runs one collection at a time for a (student, assignment)", async () => {
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
      return { outcome: "unchanged", snapshotAt: pushed.snapshotAt, unreadable: 0 };
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
    expect((await post(order())).statusCode).toBe(503);
  });
});
