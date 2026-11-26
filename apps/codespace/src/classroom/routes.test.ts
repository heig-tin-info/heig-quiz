/**
 * Platform → portal boundary: the assignment PUT and the `/launch` route.
 *
 * Everything is in memory — `:memory:` SQLite database, fake session manager,
 * SEB verifier in `simulated` mode. What is checked here is the logic of the
 * boundary: the authentication of the two tokens, the idempotence of the
 * upsert, the SEB configuration regenerated on the platform's URL, and the seven
 * refusal reasons of `/launch`. Podman and Forgejo are exercised by
 * an end-to-end run (heig-classroom's `scripts/e2e.ts`, not imported: M6-04).
 */
import cookie from "@fastify/cookie";
import { CodespaceSessionSummary } from "@quiz/contracts";
import { HS256_SKEW_SECONDS, requestBinding, signHs256 } from "@quiz/domain";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../auth/config.js";
import { openDb, type Db, type DbHandle } from "../db/client.js";
import { closedSittings, sessions, users, type AssignmentRow, type SessionRow, type UserRow } from "../db/schema.js";
import { CONFIG_KEY_HEADER, REQUEST_HASH_HEADER, expectedHash } from "@quiz/seb";

import { createPushEventStore } from "../git/index.js";
import { portalLogger } from "../logging.js";
import { EXAM_COOKIE, createSebVerifier, verifyExamCookie } from "../seb/index.js";
import type { SessionManager, StartOptions, StartResult } from "../sessions/manager.js";
import { createSittingSockets } from "../sessions/sittings.js";
import { findAssignment } from "../sessions/store.js";
import { ImageNotAdmittedError } from "../images/admission.js";

import { JTI_RETENTION_AFTER_EXP_MS, classroomRoutes, consumeJti } from "./routes.js";

const SECRET = "test-launch-secret-0123456789012345";
const CLASSROOM = "http://classroom.test";
const PORTAL = "http://portal.test";
/** A French browser: the refusals below assert the French wording (no header reads English, ADR-140 §4). */
const FR = { "accept-language": "fr-CH,fr;q=0.9" };

function testConfig(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    PUBLIC_URL: PORTAL,
    PLATFORM_URL: CLASSROOM,
    CODESPACE_LAUNCH_SECRET: SECRET,
    SEB_VERIFIER: "simulated",
    DATABASE_PATH: ":memory:",
    ...over,
  } as NodeJS.ProcessEnv);
}

// --- tokens -----------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

let jtiCounter = 0;

/**
 * A service token as the platform signs one (audit L25): two minutes, a
 * fresh `jti`, bound to the request it rides on — its method, its URL and
 * the bytes of its JSON body, which `inject` serializes with
 * `JSON.stringify` as the platform does.
 */
async function serviceToken(
  method: string,
  url: string,
  body?: unknown,
  over: Record<string, unknown> = {},
): Promise<string> {
  jtiCounter += 1;
  return signHs256(
    {
      iss: "heig-quiz",
      aud: "heig-codespace-api",
      iat: now(),
      exp: now() + 120,
      jti: `svc-${jtiCounter}`,
      ...(await requestBinding(method, url, body === undefined ? undefined : JSON.stringify(body))),
      ...over,
    },
    SECRET,
  );
}

function launchToken(over: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
  jtiCounter += 1;
  return signHs256(
    {
      iss: "heig-classroom",
      aud: "heig-codespace",
      iat: now(),
      exp: now() + 300,
      jti: `jti-${jtiCounter}`,
      sub: "u-sacha",
      email: "sacha@heig-vd.ch",
      displayName: "Sacha Student",
      githubLogin: "sacha-gh",
      assignmentId: "a-lab",
      repo: { fullName: "codespace/tp-sacha", defaultBranch: "main" },
      ...over,
    },
    secret,
  );
}

// --- PUT body ---------------------------------------------------------------

function syncBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a-lab",
    slug: "tp-pointeurs",
    name: "TP 3 — pointeurs",
    classroomId: "c-info2",
    classroomName: "Info 2 TIN-B",
    mode: "online",
    image: null,
    sourceRepo: { fullName: "codespace/tp-modele", defaultBranch: "main" },
    browserExamKeys: [],
    teacher: { id: "t-tania", email: "tania@heig-vd.ch" },
    quota: { maxActiveSessions: 2 },
    startAt: "2020-01-01T00:00:00.000Z",
    deadlineAt: null,
    ...over,
  };
}

// --- fake session manager ---------------------------------------------------

interface Harness {
  app: FastifyInstance;
  db: Db;
  handle: DbHandle;
  config: AppConfig;
  starts: Array<{ login: string; assignmentId: string; opts: StartOptions }>;
  /** Sessions the routes closed, in order. */
  closes: string[];
  /** Assignments whose update the routes asked the running workspaces to fetch (ADR-132 §11). */
  refreshes: string[];
}

/** Runs inside the fake `start`, before its row is written: what lands while the real one awaits. */
let duringStart: (() => void) | null = null;
/** What the fake `start` throws instead of opening (a refusal of the real manager). */
let startFails: Error | null = null;

function fakeManager(db: Db, starts: Harness["starts"], closes: string[] = [], refreshes: string[] = []): SessionManager {
  return {
    async refreshUpdates(assignmentId: string): Promise<number> {
      refreshes.push(assignmentId);
      return 0;
    },
    async close(sessionId: string): Promise<void> {
      closes.push(sessionId);
      // A real close stops a container: it yields, and another request may run meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 20));
      db.update(sessions).set({ state: "closed" }).where(eq(sessions.id, sessionId)).run();
    },
    async start(
      user: UserRow,
      assignment: AssignmentRow,
      opts: StartOptions = {},
    ): Promise<StartResult> {
      starts.push({ login: user.login, assignmentId: assignment.id, opts });
      if (startFails) throw startFails;
      duringStart?.();
      const id = `sess-${user.login}-${assignment.id}`;
      const at = new Date();
      const row = {
        id,
        userId: user.id,
        student: user.login,
        assignmentId: assignment.id,
        volumeDir: `/tmp/${id}`,
        state: "running" as const,
        createdAt: at,
        lastSeen: at,
        cookieToken: "cookie-token",
        sebVerified: opts.sebVerified ?? false,
        teacherId: opts.teacherId ?? null,
        launchJti: opts.launchJti ?? null,
        targetRepo: opts.targetRepo ?? null,
        openedBySitting: opts.openedBySitting ?? null,
      };
      const [session] = db
        .insert(sessions)
        .values(row)
        .onConflictDoUpdate({ target: sessions.id, set: row })
        .returning()
        .all();
      return {
        session: session as SessionRow,
        launched: true,
        healthyInMs: 1,
        cookieToken: "cookie-token",
      };
    },
  } as unknown as SessionManager;
}

async function harness(over: Record<string, string> = {}, logLines?: string[]): Promise<Harness> {
  const config = testConfig(over);
  const handle = openDb(":memory:");
  const starts: Harness["starts"] = [];
  const closes: string[] = [];
  const refreshes: string[] = [];
  const app = Fastify({
    logger: logLines ? portalLogger("trace", { write: (line: string) => void logLines.push(line) }) : false,
  });
  await app.register(cookie);
  await app.register(classroomRoutes, {
    config,
    db: handle.db,
    manager: fakeManager(handle.db, starts, closes, refreshes),
    verifier: createSebVerifier({ mode: config.SEB_VERIFIER, nodeEnv: config.NODE_ENV, url: { publicOrigin: PORTAL } }),
    repoUrl: (repo) => `http://forge.test/${repo.owner}/${repo.name}.git`,
    sittingSockets: createSittingSockets(),
  });
  await app.ready();
  return { app, db: handle.db, handle, config, starts, closes, refreshes };
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  duringStart = null;
  startFails = null;
  await h.app.close();
  h.handle.close();
});

/**
 * `PUT /api/assignments/:id` with `auth`: a token as it is, none (`null`), or
 * the claims to override in a fresh token bound to this very request.
 */
async function put(
  body: unknown,
  auth: string | null | Record<string, unknown> = {},
  id = "a-lab",
): Promise<{ statusCode: number; json: () => unknown }> {
  const url = `/api/assignments/${id}`;
  const token = auth === null || typeof auth === "string" ? auth : await serviceToken("PUT", url, body, auth);
  return h.app.inject({
    method: "PUT",
    url,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    payload: body as object,
  });
}

/** `GET /api/assignments/:id/sessions` with a fresh bound token, or the one given. */
async function sessionsOf(id = "a-lab", token?: string): Promise<{ statusCode: number; json: () => unknown }> {
  const url = `/api/assignments/${id}/sessions`;
  return h.app.inject({ url, headers: { authorization: `Bearer ${token ?? (await serviceToken("GET", url))}` } });
}

// --- PUT /api/assignments/:id -----------------------------------------------

describe("PUT /api/assignments/:id", () => {
  it("401 without a service token", async () => {
    expect((await put(syncBody(), null)).statusCode).toBe(401);
  });

  it("401 with a signature made with another secret", async () => {
    const forged = await signHs256(
      { iss: "heig-quiz", aud: "heig-codespace-api", iat: now(), exp: now() + 120, jti: "forged", ...(await requestBinding("PUT", "/api/assignments/a-lab", JSON.stringify(syncBody()))) },
      "another-secret-of-thirty-two-chars",
    );
    expect((await put(syncBody(), forged)).statusCode).toBe(401);
  });

  it("401 with the right signature but the wrong audience", async () => {
    // A *launch* token must not open the service API.
    expect((await put(syncBody(), { aud: "heig-codespace" })).statusCode).toBe(401);
  });

  it("401 with an unexpected issuer", async () => {
    expect((await put(syncBody(), { iss: "heig-codespace" })).statusCode).toBe(401);
  });

  it("accepts Quiz's service tokens, not heig-classroom's", async () => {
    expect((await put(syncBody(), { iss: "heig-classroom" })).statusCode).toBe(401);
    expect((await put(syncBody())).statusCode).toBe(200);
  });

  it("401 on a replayed token: its jti serves once (audit L25)", async () => {
    const token = await serviceToken("PUT", "/api/assignments/a-lab", syncBody());
    expect((await put(syncBody(), token)).statusCode).toBe(200);
    expect((await put(syncBody(), token)).statusCode).toBe(401);
  });

  it("401 on a token bound to another route, method or body (audit L25)", async () => {
    // Signed for another assignment's PUT: refused on this one.
    expect((await put(syncBody(), await serviceToken("PUT", "/api/assignments/a-other", syncBody()))).statusCode).toBe(401);
    // Signed for the GET of the sessions: refused on the PUT.
    expect((await put(syncBody(), await serviceToken("GET", "/api/assignments/a-lab"))).statusCode).toBe(401);
    // The body was changed in transit: refused.
    const token = await serviceToken("PUT", "/api/assignments/a-lab", syncBody({ quota: { maxActiveSessions: 2 } }));
    expect((await put(syncBody({ quota: { maxActiveSessions: 200 } }), token)).statusCode).toBe(401);
    // An unbound token, as Quiz signed one before: refused.
    const unbound = await signHs256({ iss: "heig-quiz", aud: "heig-codespace-api", iat: now(), exp: now() + 120, jti: "unbound" }, SECRET);
    expect((await put(syncBody(), unbound)).statusCode).toBe(401);
    // Nothing reached the database.
    expect(findAssignment(h.db, "a-lab")).toBeUndefined();
    // The same body sent as another content type is not hashed: refused (415).
    const raw = await h.app.inject({
      method: "PUT",
      url: "/api/assignments/a-lab",
      headers: { authorization: `Bearer ${await serviceToken("PUT", "/api/assignments/a-lab", syncBody())}`, "content-type": "text/plain" },
      payload: JSON.stringify(syncBody()),
    });
    expect(raw.statusCode).toBe(415);
  });

  it("401 on a token signed for longer than two minutes, or without a jti", async () => {
    expect((await put(syncBody(), { exp: now() + 121 })).statusCode).toBe(401);
    expect((await put(syncBody(), { jti: undefined })).statusCode).toBe(401);
  });

  it("401 with an expired token", async () => {
    expect((await put(syncBody(), { iat: now() - 7200, exp: now() - 7100 })).statusCode).toBe(401);
  });

  it("400 on a body that is not the contract's", async () => {
    const reply = await put(syncBody({ mode: "free" }));
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toBe("invalid_body");
  });

  it("400 if the body id and the URL id differ", async () => {
    const reply = await put(syncBody({ id: "a-other" }), {}, "a-lab");
    expect(reply.statusCode).toBe(400);
  });

  it("400 on an id under the review prefix, the portal's own (ADR-129 §10)", async () => {
    const reply = await put(syncBody({ id: "review-x" }), {}, "review-x");
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toBe("reserved_id");
    expect(findAssignment(h.db, "review-x")).toBeUndefined();
  });

  it("400 if the id cannot name a volume directory", async () => {
    const reply = await put(syncBody({ id: "a$b" }), {}, "a$b");
    expect(reply.statusCode).toBe(400);
  });

  it("creates the assignment, translates the mode and sets the platform's fields", async () => {
    const reply = await put(syncBody());
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ id: "a-lab", configKey: null, sebLink: null });

    const row = findAssignment(h.db, "a-lab");
    expect(row?.mode).toBe("lab");
    expect(row?.title).toBe("TP 3 — pointeurs");
    expect(row?.teacherId).toBe("t-tania");
    expect(row?.teacherEmail).toBe("tania@heig-vd.ch");
    expect(row?.maxActiveSessions).toBe(2);
    expect(row?.classroomId).toBe("c-info2");
    expect(row?.classroomName).toBe("Info 2 TIN-B");
    expect(row?.sourceRepo).toEqual({ fullName: "codespace/tp-modele", defaultBranch: "main" });
    // Invariant 6: the teacher's template, in its clonable form.
    expect(row?.templateRepo).toBe("http://forge.test/codespace/tp-modele.git");
    // The target repository is no longer an attribute of the assignment: it
    // comes from the token.
    expect(row?.targetRepo).toBeNull();
    expect(row?.targetRepoPattern).toBeNull();
    // ADR-146: no image named, the default resolved at each start, never frozen here.
    expect(row?.imageRef).toBeNull();
    expect(row?.image).toBe(h.config.CODESPACE_DEFAULT_IMAGE);
  });

  it("stores a course image by digest, canonical, admitted or not; refuses a tag", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    expect((await put(syncBody({ image: `ghcr.io/heig/lab-go:2@${digest}` }))).statusCode).toBe(200);
    expect(findAssignment(h.db, "a-lab")?.imageRef).toBe(`ghcr.io/heig/lab-go@${digest}`);
    expect((await put(syncBody({ image: "codespace/python:1" }))).statusCode).toBe(400);
    // Back to the default.
    await put(syncBody({ image: null }));
    expect(findAssignment(h.db, "a-lab")?.imageRef).toBeNull();
  });

  it("is idempotent: two identical PUTs, one row and the same answer", async () => {
    const body = syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows"] });
    const first = await put(body);
    const second = await put(body);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const rows = h.db.all<{ n: number }>("SELECT count(*) AS n FROM assignments");
    expect(rows[0]?.n).toBe(1);
    const created = findAssignment(h.db, "a-lab")?.createdAt;
    await put(syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows", "bek-mac"] }));
    const after = findAssignment(h.db, "a-lab");
    expect(after?.beks).toEqual(["bek-windows", "bek-mac"]);
    expect(after?.createdAt).toEqual(created);
  });

  it("exam mode: Browser Exam Keys optional, no `.seb` of the portal's own (D21)", async () => {
    // No key: the Config Key alone, the platform's default.
    const reply = await put(syncBody({ mode: "online_seb", browserExamKeys: [] }));
    expect(reply.statusCode).toBe(200);
    // The platform builds the `.seb`: the portal has no Config Key nor link to announce.
    expect(reply.json()).toEqual({ id: "a-lab", configKey: null, sebLink: null });
    const row = findAssignment(h.db, "a-lab");
    expect(row?.mode).toBe("exam");
    expect(row?.beks).toEqual([]);
  });

  it("switching an exam assignment back to online mode drops its Browser Exam Keys", async () => {
    await put(syncBody({ mode: "online_seb", browserExamKeys: ["bek"] }));
    await put(syncBody({ browserExamKeys: ["bek"] }));
    const row = findAssignment(h.db, "a-lab");
    expect(row?.mode).toBe("lab");
    expect(row?.beks).toEqual([]);
  });

  it("stores the teacher's update of a lab and asks the running workspaces to fetch it; an exam keeps none, a sync without one clears it (ADR-132 §11)", async () => {
    const update = { heads: [{ branch: "main", sha: "c".repeat(40) }], message: { text: "Test fixed.", at: "2026-11-17T20:00:00.000Z" } };
    expect((await put(syncBody({ workspaceUpdate: update }))).statusCode).toBe(200);
    expect(findAssignment(h.db, "a-lab")?.workspaceUpdate).toEqual(update);
    expect(h.refreshes).toEqual(["a-lab"]);

    expect((await put(syncBody())).statusCode).toBe(200);
    expect(findAssignment(h.db, "a-lab")?.workspaceUpdate).toBeNull();
    expect((await put(syncBody({ mode: "online_seb", workspaceUpdate: update }))).statusCode).toBe(200);
    expect(findAssignment(h.db, "a-lab")?.workspaceUpdate).toBeNull();
    expect(h.refreshes).toEqual(["a-lab"]);
    // Anything but a branch and a full sha never reaches a refspec.
    expect((await put(syncBody({ workspaceUpdate: { ...update, heads: [{ branch: "main", sha: "HEAD" }] } }))).statusCode).toBe(400);
  });
});

// --- GET /api/assignments/:id/sessions --------------------------------------

describe("GET /api/assignments/:id/sessions", () => {
  it("401 without a service token, 404 on an unknown assignment", async () => {
    const anonymous = await h.app.inject({ url: "/api/assignments/a-lab/sessions" });
    expect(anonymous.statusCode).toBe(401);
    expect((await sessionsOf("a-unknown")).statusCode).toBe(404);
  });

  it("a token serves one read, of the assignment it names (audit L25)", async () => {
    await put(syncBody());
    const token = await serviceToken("GET", "/api/assignments/a-lab/sessions");
    expect((await sessionsOf("a-lab", token)).statusCode).toBe(200);
    expect((await sessionsOf("a-lab", token)).statusCode).toBe(401);
    expect((await sessionsOf("a-lab", await serviceToken("GET", "/api/assignments/a-other/sessions"))).statusCode).toBe(401);
    expect((await sessionsOf("a-lab", await serviceToken("GET", "/api/assignments/a-lab/sessions", { smuggled: true }))).statusCode).toBe(401);
  });

  it("returns the session summary with the platform's id, in the contract's shape", async () => {
    await put(syncBody());
    const launch = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
    expect(launch.statusCode).toBe(303);

    const reply = await sessionsOf();
    expect(reply.statusCode).toBe(200);
    const list = reply.json() as Array<Record<string, unknown>>;
    expect(CodespaceSessionSummary.array().safeParse(list).success).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]?.["userId"]).toBe("u-sacha");
    expect(list[0]?.["email"]).toBe("sacha@heig-vd.ch");
    expect(list[0]?.["state"]).toBe("running");
    expect(list[0]?.["lastPushAt"]).toBeNull();
    expect(list[0]?.["rejectedPush"]).toBeNull();
    expect(typeof list[0]?.["createdAt"]).toBe("string");

    // A push GitHub refused (ADR-078 §6) reaches the staff's list, until a later push of the branch.
    const sessionId = list[0]?.["sessionId"] as string;
    const store = createPushEventStore(h.db);
    const at = new Date("2026-10-07T09:00:00Z");
    const event = { sessionId, student: "u-sacha", assignment: "a-lab", ref: "refs/heads/main", oldSha: null, state: "pending" as const, attempts: 0 };
    await store.insert([{ ...event, id: "p1", sha: "a".repeat(40), receivedAt: at }]);
    await store.markRejected(["p1"], "fetch first");
    const read = async () =>
      CodespaceSessionSummary.array().parse(
        (await sessionsOf()).json(),
      )[0];
    expect((await read())?.rejectedPush).toEqual({ ref: "refs/heads/main", at: at.toISOString(), reason: "fetch first" });
    await store.insert([{ ...event, id: "p2", sha: "b".repeat(40), receivedAt: new Date(at.getTime() + 60_000) }]);
    expect((await read())?.rejectedPush).toBeNull();
  });
});

// --- GET /launch ------------------------------------------------------------

describe("GET /launch", () => {
  async function syncedAssignment(over: Record<string, unknown> = {}): Promise<void> {
    const reply = await put(syncBody(over), {}, (over["id"] as string) ?? "a-lab");
    expect(reply.statusCode).toBe(200);
  }

  it("403 without a token, in English to a browser that names none of the portal's languages", async () => {
    for (const headers of [{}, { "accept-language": "xx-YY,xx;q=0.9" }]) {
      const reply = await h.app.inject({ url: "/launch", headers });
      expect(reply.statusCode).toBe(403);
      expect(reply.body).toContain('<html lang="en">');
      expect(reply.body).toContain("Launch refused");
    }
  });

  it("refuses in English to a browser that asks for it", async () => {
    const reply = await h.app.inject({
      url: "/launch",
      headers: { "accept-language": "en-GB,en;q=0.9" },
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain('<html lang="en">');
    expect(reply.body).toContain("Launch refused");
    expect(reply.body).toContain("No launch token.");
  });

  it("403 on a signature made with another secret", async () => {
    await syncedAssignment();
    const token = await launchToken({}, "another-secret-of-thirty-two-chars");
    const reply = await h.app.inject({ url: `/launch?token=${token}` });
    expect(reply.statusCode).toBe(403);
    expect(h.starts).toHaveLength(0);
  });

  it("403 on an expired token", async () => {
    await syncedAssignment();
    const token = await launchToken({ iat: now() - 7200, exp: now() - 3600 });
    const reply = await h.app.inject({ url: `/launch?token=${token}`, headers: FR });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("expiré");
  });

  it("403 on a service token audience", async () => {
    await syncedAssignment();
    const token = await launchToken({ aud: "heig-codespace-api" });
    expect((await h.app.inject({ url: `/launch?token=${token}` })).statusCode).toBe(403);
  });

  it("409 with its own page when the project's image is not admitted (ADR-146 §5): no cookie", async () => {
    await syncedAssignment();
    startFails = new ImageNotAdmittedError(`ghcr.io/heig/lab@sha256:${"d".repeat(64)}`);
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}`, headers: FR });
    expect(reply.statusCode).toBe(409);
    expect(reply.body).toContain("Espace de travail pas prêt");
    expect(reply.headers["set-cookie"]).toBeUndefined();
  });

  it("single use: the same token does not serve twice", async () => {
    await syncedAssignment();
    const token = await launchToken();
    const first = await h.app.inject({ url: `/launch?token=${token}` });
    expect(first.statusCode).toBe(303);
    const second = await h.app.inject({ url: `/launch?token=${token}`, headers: FR });
    expect(second.statusCode).toBe(403);
    expect(second.body).toContain("déjà servi");
    expect(h.starts).toHaveLength(1);
  });

  it("a used token stays refused through the skew window after its exp (audit M11)", async () => {
    await syncedAssignment();
    // Presented at exp + 10 s: `verifyHs256` still accepts it (skew 30 s).
    const token = await launchToken({ iat: now() - 310, exp: now() - 10 });
    expect((await h.app.inject({ url: `/launch?token=${token}` })).statusCode).toBe(303);
    // The replay's own purge runs first: it must not sweep the row away.
    const replay = await h.app.inject({ url: `/launch?token=${token}`, headers: FR });
    expect(replay.statusCode).toBe(403);
    expect(replay.body).toContain("déjà servi");
    expect(h.starts).toHaveLength(1);
  });

  it("403 on a token signed for longer than five minutes", async () => {
    await syncedAssignment();
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken({ exp: now() + 301 })}` });
    expect(reply.statusCode).toBe(403);
    expect(h.starts).toHaveLength(0);
  });

  it("403 on an assignment not synchronized from the platform", async () => {
    const token = await launchToken({ assignmentId: "a-never-seen" });
    const reply = await h.app.inject({ url: `/launch?token=${token}`, headers: FR });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("non synchronisée depuis la plateforme");
  });

  it("403 outside the assignment window", async () => {
    await syncedAssignment({ deadlineAt: "2020-06-01T00:00:00.000Z" });
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}`, headers: FR });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("fenêtre d'ouverture");
  });

  it("a deadline taken back by the platform reopens launches (no deadline: Quiz decides, #958)", async () => {
    await syncedAssignment({ deadlineAt: "2020-06-01T00:00:00.000Z" });
    await syncedAssignment({ deadlineAt: null });
    expect(findAssignment(h.db, "a-lab")?.closesAt).toBeNull();
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
    expect(reply.statusCode).toBe(303);
    expect(h.starts).toHaveLength(1);
  });

  it("403 when the token carries no repository", async () => {
    await syncedAssignment();
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken({ repo: null })}`, headers: FR });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("dépôt");
    expect(h.starts).toHaveLength(0);
  });

  it("accepts a launch token issued by heig-quiz", async () => {
    await syncedAssignment();
    const reply = await h.app.inject({
      url: `/launch?token=${await launchToken({ iss: "heig-quiz" })}`,
    });
    expect(reply.statusCode).toBe(303);
    expect(h.starts).toHaveLength(1);
  });

  it("403 on a launch token from another issuer", async () => {
    await syncedAssignment();
    const reply = await h.app.inject({
      url: `/launch?token=${await launchToken({ iss: "heig-codespace" })}`,
    });
    expect(reply.statusCode).toBe(403);
    expect(h.starts).toHaveLength(0);
  });

  it("opens the session, sets the portal cookie and redirects", async () => {
    await syncedAssignment();
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });

    expect(reply.statusCode).toBe(303);
    expect(reply.headers["location"]).toBe("/s/sess-u-sacha-a-lab/");
    const cookies = reply.cookies as Array<{ name: string; value: string; path?: string }>;
    const portal = cookies.find((c) => c.name === "cs_session");
    expect(portal?.value).toBe("sess-u-sacha-a-lab.cookie-token");
    // `Path=/s/<id>`: two sessions in the same browser do not step on each
    // other.
    expect(portal?.path).toBe("/s/sess-u-sacha-a-lab");
    // No exam cookie on a lab assignment.
    expect(cookies.find((c) => c.name === "exam_session")).toBeUndefined();

    // The token's repository, the assignment's teacher and the `jti` are
    // passed on.
    expect(h.starts[0]?.opts).toMatchObject({
      sebVerified: false,
      teacherId: "t-tania",
      targetRepo: { fullName: "codespace/tp-sacha", defaultBranch: "main" },
    });
    expect(h.starts[0]?.opts.launchJti).toMatch(/^jti-/);
  });

  it("registers the user from the claims, without logging them in again", async () => {
    await syncedAssignment();
    await h.app.inject({ url: `/launch?token=${await launchToken()}` });
    const rows = h.db.all<{ login: string; email: string; github_login: string; oidc_sub: string; role: string }>(
      "SELECT login, email, github_login, oidc_sub, role FROM users",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      login: "u-sacha",
      email: "sacha@heig-vd.ch",
      github_login: "sacha-gh",
      oidc_sub: "classroom:u-sacha",
      // A launch token never grants the teacher role.
      role: "student",
    });

    await h.app.inject({
      url: `/launch?token=${await launchToken({ email: "sacha2@heig-vd.ch", githubLogin: null })}`,
    });
    const after = h.db.all<{ n: number }>("SELECT count(*) AS n FROM users");
    expect(after[0]?.n).toBe(1);
    expect(
      h.db.all<{ email: string; github_login: string | null }>(
        "SELECT email, github_login FROM users",
      )[0],
    ).toEqual({ email: "sacha2@heig-vd.ch", github_login: null });
  });

  describe("per-teacher quota", () => {
    /** Live session of another student, on another assignment of the same teacher. */
    function occupy(student: string, assignmentId: string): void {
      const at = new Date();
      h.db
        .insert(users)
        .values({
          id: `user-${student}`,
          oidcSub: `classroom:${student}`,
          login: student,
          email: `${student}@heig-vd.ch`,
          displayName: student,
          createdAt: at,
        })
        .onConflictDoNothing()
        .run();
      h.db
        .insert(sessions)
        .values({
          id: `sess-${student}-${assignmentId}`,
          userId: `user-${student}`,
          student,
          assignmentId,
          volumeDir: `/tmp/${student}`,
          state: "running",
          createdAt: at,
          lastSeen: at,
          cookieToken: "x",
          teacherId: "t-tania",
        })
        .run();
    }

    it("429 when the teacher's live sessions reach the quota", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      occupy("u-other", "a-lab");
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}`, headers: FR });
      expect(reply.statusCode).toBe(429);
      expect(reply.body).toContain("Quota atteint");
      expect(h.starts).toHaveLength(0);
    });

    it("the quota counts all the teacher's assignments, not only this one", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      await syncedAssignment({ id: "a-other", quota: { maxActiveSessions: 1 } });
      occupy("u-other", "a-other");
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(429);
    });

    it("resuming one's own live session does not consume quota", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      // The student already has their session on this assignment: resuming
      // does not open one more container (analyse.md D5).
      occupy("u-sacha", "a-lab");
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(303);
      expect(h.starts).toHaveLength(1);
    });

    it("a closed session no longer counts", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      occupy("u-other", "a-lab");
      h.db.run("UPDATE sessions SET state = 'closed'" as never);
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(303);
    });
  });

  describe("exam mode", () => {
    /** The Config Key of the student's `.seb`, as the platform signs it into the token (D21). */
    const CONFIG_KEY = "c".repeat(64);
    const SEB = { seb: { configKey: CONFIG_KEY } };
    const BEK_WIN = "a".repeat(64);
    const BEK_MAC = "b".repeat(64);
    const BEK_OTHER_VERSION = "e".repeat(64);

    async function syncedExam(browserExamKeys: string[] = [BEK_WIN]): Promise<void> {
      const reply = await put(syncBody({ mode: "online_seb", browserExamKeys }));
      expect(reply.statusCode).toBe(200);
    }

    /** The headers SEB sends on `url`, hashed over the portal's absolute URL. */
    function sebHeaders(url: string, bek: string | null = BEK_MAC, configKey = CONFIG_KEY): Record<string, string> {
      const absolute = `${PORTAL}${url}`;
      return {
        [CONFIG_KEY_HEADER]: expectedHash(absolute, configKey),
        ...(bek === null ? {} : { [REQUEST_HASH_HEADER]: expectedHash(absolute, bek) }),
      };
    }

    it("refuses without an SEB verification header", async () => {
      await syncedExam();
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken(SEB)}` });
      expect(reply.statusCode).toBe(403);
      expect(reply.body).toContain("Safe Exam Browser");
      expect(h.starts).toHaveLength(0);
    });

    it("refuses a token without the `seb` claim, even with the header: it did not come from SEB", async () => {
      await syncedExam();
      const reply = await h.app.inject({
        url: `/launch?token=${await launchToken()}`,
        headers: { "x-dev-seb": "ok" },
      });
      expect(reply.statusCode).toBe(403);
      expect(h.starts).toHaveLength(0);
    });

    it("accepts with the header and sets both cookies", async () => {
      await syncedExam();
      const reply = await h.app.inject({
        url: `/launch?token=${await launchToken(SEB)}`,
        headers: { "x-dev-seb": "ok" },
      });
      expect(reply.statusCode).toBe(303);
      expect(reply.headers["location"]).toBe("/s/sess-u-sacha-a-lab/");
      const cookies = reply.cookies as Array<{ name: string; path?: string }>;
      expect(cookies.find((c) => c.name === "exam_session")?.path).toBe("/");
      expect(cookies.find((c) => c.name === "cs_session")).toBeDefined();
      // The session is marked verified: that is what the proxy will require.
      expect(h.starts[0]?.opts.sebVerified).toBe(true);
    });

    describe("from a kiosk station (ADR-089 §4)", () => {
      const KIOSK = {
        kiosk: { deviceId: "6f1c2a3b-0000-4000-8000-0000000000d1", sitting: "6f1c2a3b-0000-4000-8000-0000000000a1" },
      };
      const examClaims = (reply: { cookies: unknown }) => {
        const value = (reply.cookies as Array<{ name: string; value: string }>).find((c) => c.name === EXAM_COOKIE)?.value;
        const verdict = verifyExamCookie(value, { secret: h.config.EXAM_COOKIE_SECRET, clientAddress: "127.0.0.1" });
        return verdict.ok ? verdict.claims : null;
      };

      it("accepts a `kiosk` claim without any SEB header, its cookie carrying the sitting", async () => {
        await h.app.close();
        h.handle.close();
        // The real verifier: no header would satisfy it, and none is read.
        h = await harness({ SEB_VERIFIER: "real" });
        await syncedExam();
        const reply = await h.app.inject({ url: `/launch?token=${await launchToken(KIOSK)}` });
        expect(reply.statusCode).toBe(303);
        expect(examClaims(reply)).toMatchObject({ sessionId: "sess-u-sacha-a-lab", sitting: KIOSK.kiosk.sitting });
        expect(h.starts[0]?.opts).toMatchObject({ sebVerified: false, openedBySitting: KIOSK.kiosk.sitting });
      });

      it("leaves a `seb` launch as it was: no sitting on its cookie, no opener", async () => {
        await syncedExam();
        const reply = await h.app.inject({ url: `/launch?token=${await launchToken(SEB)}`, headers: { "x-dev-seb": "ok" } });
        expect(reply.statusCode).toBe(303);
        const claims = examClaims(reply);
        expect(claims).not.toBeNull();
        expect(claims).not.toHaveProperty("sitting");
        expect(h.starts[0]?.opts).toMatchObject({ sebVerified: true, openedBySitting: null });
      });

      it("refuses a token with both claims, as one with neither", async () => {
        await syncedExam();
        for (const claims of [{ ...SEB, ...KIOSK }, {}]) {
          const reply = await h.app.inject({ url: `/launch?token=${await launchToken(claims)}`, headers: { "x-dev-seb": "ok" } });
          expect(reply.statusCode).toBe(403);
          expect(reply.headers["set-cookie"]).toBeUndefined();
        }
        expect(h.starts).toHaveLength(0);
      });

      it("uses a station's token once", async () => {
        await syncedExam();
        const url = `/launch?token=${await launchToken(KIOSK)}`;
        expect((await h.app.inject({ url })).statusCode).toBe(303);
        const replay = await h.app.inject({ url, headers: { "accept-language": "en" } });
        expect(replay.statusCode).toBe(403);
        expect(replay.body).toContain("already been used");
        expect(h.starts).toHaveLength(1);
      });

      it("refuses a `kiosk` claim outside an exam, before any side effect (ADR-089 §1)", async () => {
        await syncedAssignment();
        const reply = await h.app.inject({ url: `/launch?token=${await launchToken(KIOSK)}` });
        expect(reply.statusCode).toBe(403);
        expect(reply.headers["set-cookie"]).toBeUndefined();
        expect(h.starts).toHaveLength(0);
      });

      it("refuses, with no cookie, a launch whose sitting closed while the session started", async () => {
        await syncedExam();
        duringStart = () => void h.db.insert(closedSittings).values({ sitting: KIOSK.kiosk.sitting, closedAt: new Date() }).run();
        const reply = await h.app.inject({ url: `/launch?token=${await launchToken(KIOSK)}`, headers: { "accept-language": "en" } });
        expect(h.starts).toHaveLength(1);
        expect(reply.statusCode).toBe(403);
        expect(reply.body).toContain("Your session on this station has ended");
        expect(reply.headers["set-cookie"]).toBeUndefined();
      });

      it("refuses a token of a sitting already closed, before any side effect", async () => {
        await syncedExam();
        h.db.insert(closedSittings).values({ sitting: KIOSK.kiosk.sitting, closedAt: new Date() }).run();
        const reply = await h.app.inject({ url: `/launch?token=${await launchToken(KIOSK)}`, headers: { "accept-language": "en" } });
        expect(reply.statusCode).toBe(403);
        expect(reply.body).toContain("Your session on this station has ended");
        expect(h.starts).toHaveLength(0);
      });
    });

    describe("with the real verifier", () => {
      let lines: string[];
      beforeEach(async () => {
        await h.app.close();
        h.handle.close();
        lines = [];
        h = await harness({ SEB_VERIFIER: "real" }, lines);
      });

      /** A launch as SEB sends it: a fresh token carrying the student's Config Key. */
      async function launch(headers: (url: string) => Record<string, string>, over: Record<string, unknown> = SEB) {
        const url = `/launch?token=${await launchToken(over)}`;
        return h.app.inject({ url, headers: headers(url) });
      }

      it("accepts the Config Key alone when the project has no Browser Exam Key (D21)", async () => {
        await syncedExam([]);
        const reply = await launch((url) => sebHeaders(url, null));
        expect(reply.statusCode).toBe(303);
        expect(h.starts[0]?.opts.sebVerified).toBe(true);
      });

      it("accepts the Config Key and any of the project's Browser Exam Keys", async () => {
        await syncedExam([BEK_WIN, BEK_MAC]);
        expect((await launch((url) => sebHeaders(url, BEK_WIN))).statusCode).toBe(303);
        expect((await launch((url) => sebHeaders(url, BEK_MAC))).statusCode).toBe(303);
      });

      const refusals: Array<[string, string[], (url: string) => Record<string, string>, Record<string, unknown>?]> = [
        ["no header at all", [], () => ({})],
        ["another student's Config Key", [], (url) => sebHeaders(url, null, "d".repeat(64))],
        ["a header hashed over another URL", [], () => sebHeaders("/launch?token=other", null)],
        ["the development header alone", [], () => ({ "x-dev-seb": "ok" })],
        ["no `seb` claim, the header right", [], (url) => sebHeaders(url, null), {}],
        ["a Browser Exam Key of another SEB version", [BEK_WIN, BEK_MAC], (url) => sebHeaders(url, BEK_OTHER_VERSION)],
        ["no request hash where Browser Exam Keys are set", [BEK_WIN], (url) => sebHeaders(url, null)],
      ];
      for (const [name, beks, headers, claims] of refusals) {
        it(`refuses (403): ${name}`, async () => {
          await syncedExam(beks);
          const reply = await launch(headers, claims ?? SEB);
          expect(reply.statusCode).toBe(403);
          expect(reply.headers["content-type"]).toContain("text/html");
          expect(reply.headers["set-cookie"]).toBeUndefined();
          expect(h.starts).toHaveLength(0);
        });
      }

      it("never logs a Browser Exam Key nor a hash it received", async () => {
        await syncedExam([BEK_WIN, BEK_MAC]);
        const url = `/launch?token=${await launchToken(SEB)}`;
        const sent = sebHeaders(url, BEK_OTHER_VERSION);
        expect((await h.app.inject({ url, headers: sent })).statusCode).toBe(403);
        const log = lines.join("");
        expect(log).toContain("browser-exam-key-mismatch");
        for (const secret of [BEK_WIN, BEK_MAC, BEK_OTHER_VERSION, ...Object.values(sent)]) {
          expect(log).not.toContain(secret);
        }
      });
    });
  });
});

// --- registry of consumed tokens --------------------------------------------

// --- GET /review (ADR-129) --------------------------------------------------

describe("GET /review", () => {
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  const REPO_A = "22222222-2222-4222-8222-222222222222";
  const REPO_B = "33333333-3333-4333-8333-333333333333";
  const REPO_C = "44444444-4444-4444-8444-444444444444";

  /** A review launch token as Quiz signs one: the staff member Sam opens a student's repository. */
  function reviewToken(over: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
    jtiCounter += 1;
    return signHs256(
      {
        iss: "heig-quiz",
        aud: "heig-codespace-review",
        iat: now(),
        exp: now() + 300,
        jti: `review-jti-${jtiCounter}`,
        sub: "u-sam",
        email: "sam@heig-vd.ch",
        displayName: "Sam Staff",
        githubLogin: null,
        repo: { fullName: "org/tp-sacha", defaultBranch: "master" },
        projectId: PROJECT,
        projectRepoId: REPO_A,
        holder: { id: "t-tania", email: "tania@heig-vd.ch" },
        maxActiveSessions: 10,
        ...over,
      },
      secret,
    );
  }

  // A synchronized project of the same holder, whose students' sessions fill the quota.
  beforeEach(async () => {
    expect((await put(syncBody())).statusCode).toBe(200);
  });

  const review = async (over: Record<string, unknown> = {}) =>
    h.app.inject({ url: `/review?token=${await reviewToken(over)}`, headers: FR });

  /** A live session of `student` on `assignmentId`, carried by the holder Tania. */
  function occupy(student: string, assignmentId: string): string {
    const at = new Date();
    h.db
      .insert(users)
      .values({ id: `user-${student}`, oidcSub: `classroom:${student}`, login: student, email: `${student}@heig-vd.ch`, displayName: student, createdAt: at })
      .onConflictDoNothing()
      .run();
    const id = `sess-${student}-${assignmentId}`;
    h.db
      .insert(sessions)
      .values({ id, userId: `user-${student}`, student, assignmentId, volumeDir: `/tmp/${id}`, state: "running", createdAt: at, lastSeen: at, cookieToken: "x", teacherId: "t-tania" })
      .run();
    return id;
  }

  /** A live review session of `staff` on `repoId`, opened through the route itself. */
  async function liveReview(staff: string, repoId: string): Promise<string> {
    const reply = await review({ sub: staff, email: `${staff}@heig-vd.ch`, projectRepoId: repoId });
    expect(reply.statusCode).toBe(303);
    return `sess-${staff}-review-${repoId}`;
  }

  it("opens a review session on its own assignment, carried by the quota holder", async () => {
    const reply = await review();
    expect(reply.statusCode).toBe(303);
    expect(reply.headers.location).toBe(`/s/sess-u-sam-review-${REPO_A}/`);
    expect(String(reply.headers["set-cookie"])).toContain("cs_session=");

    const row = findAssignment(h.db, `review-${REPO_A}`);
    expect(row).toMatchObject({
      mode: "lab",
      uploadPack: true,
      teacherId: "t-tania",
      teacherEmail: "tania@heig-vd.ch",
      maxActiveSessions: 10,
      opensAt: null,
      closesAt: null,
      beks: [],
      templateRepo: null,
      image: h.config.CODESPACE_DEFAULT_IMAGE,
      reviewOf: { projectId: PROJECT, projectRepoId: REPO_A },
    });
    expect(h.starts).toEqual([
      {
        login: "u-sam",
        assignmentId: `review-${REPO_A}`,
        opts: {
          sebVerified: false,
          teacherId: "t-tania",
          launchJti: expect.stringMatching(/^review-jti-/) as unknown as string,
          targetRepo: { fullName: "org/tp-sacha", defaultBranch: "master" },
          // A review is never a station's: its close never rotates it (ADR-089).
          openedBySitting: null,
        },
      },
    ]);
    // The staff member's own account, with no role (portal invariant 9).
    expect(h.db.all<{ role: string }>("SELECT role FROM users WHERE login = 'u-sam'")).toEqual([{ role: "student" }]);
    // No image claim (an older platform): the default.
    expect(row?.imageRef).toBeNull();
  });

  it("runs the project's image the token names (ADR-147 §6)", async () => {
    const image = `ghcr.io/heig/lab-go@sha256:${"e".repeat(64)}`;
    expect((await review({ image })).statusCode).toBe(303);
    expect(findAssignment(h.db, `review-${REPO_A}`)?.imageRef).toBe(image);
    // A later launch without it goes back to the default.
    expect((await review({ image: null })).statusCode).toBe(303);
    expect(findAssignment(h.db, `review-${REPO_A}`)?.imageRef).toBeNull();
  });

  it("opens the project's distribution on its own assignment, a review like the others (ADR-147 §4)", async () => {
    const reply = await review({ projectRepoId: null, repo: { fullName: "org/tp-squashed", defaultBranch: "main" } });
    expect(reply.statusCode).toBe(303);
    expect(reply.headers.location).toBe(`/s/sess-u-sam-review-dist-${PROJECT}/`);
    const row = findAssignment(h.db, `review-dist-${PROJECT}`);
    expect(row).toMatchObject({ title: "org/tp-squashed", teacherId: "t-tania", reviewOf: { projectId: PROJECT, projectRepoId: null } });
    expect(h.starts.at(-1)).toMatchObject({ assignmentId: `review-dist-${PROJECT}`, opts: { targetRepo: { fullName: "org/tp-squashed" } } });
    // One review per staff member: a repository's review now replaces it.
    await liveReview("u-sam", REPO_A);
    expect(h.closes).toEqual([`sess-u-sam-review-dist-${PROJECT}`]);
  });

  it("tells a staff member where the image is managed when it is not admitted", async () => {
    startFails = new ImageNotAdmittedError(`ghcr.io/heig/lab@sha256:${"d".repeat(64)}`);
    const reply = await review({ image: `ghcr.io/heig/lab@sha256:${"d".repeat(64)}` });
    expect(reply.statusCode).toBe(409);
    expect(reply.body).toContain("onglet Images du cours");
    expect(reply.headers["set-cookie"]).toBeUndefined();
  });

  it("a review token never opens /launch, nor a launch token /review", async () => {
    await put(syncBody({ id: PROJECT }), {}, PROJECT);
    const asLaunch = await h.app.inject({ url: `/launch?token=${await reviewToken()}` });
    expect(asLaunch.statusCode).toBe(403);
    const asReview = await h.app.inject({ url: `/review?token=${await launchToken({ assignmentId: PROJECT })}` });
    expect(asReview.statusCode).toBe(403);
    expect(h.starts).toHaveLength(0);
  });

  it("accepts Quiz's review tokens only: another issuer, a forged or a long token is refused", async () => {
    expect((await review({ iss: "heig-classroom" })).statusCode).toBe(403);
    expect((await h.app.inject({ url: `/review?token=${await reviewToken({}, "another-secret-of-thirty-two-chars")}` })).statusCode).toBe(403);
    expect((await review({ exp: now() + 301 })).statusCode).toBe(403);
    expect((await review({ jti: undefined })).statusCode).toBe(403);
    expect((await h.app.inject({ url: "/review" })).statusCode).toBe(403);
    expect(h.starts).toHaveLength(0);
    expect(findAssignment(h.db, `review-${REPO_A}`)).toBeUndefined();
  });

  it("burns the jti before any other check: a refused token stays refused (invariant 7)", async () => {
    const token = await reviewToken({ repo: null });
    const first = await h.app.inject({ url: `/review?token=${token}`, headers: FR });
    expect(first.statusCode).toBe(403);
    expect(first.body).toContain("pas disponible");
    const replay = await h.app.inject({ url: `/review?token=${token}`, headers: FR });
    expect(replay.statusCode).toBe(403);
    expect(replay.body).toContain("déjà servi");
    expect(h.starts).toHaveLength(0);
  });

  it("the review assignment opens through /review only", async () => {
    await liveReview("u-sam", REPO_A);
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken({ assignmentId: `review-${REPO_A}` })}` });
    expect(reply.statusCode).toBe(403);
    expect(h.starts).toHaveLength(1);
  });

  it("429 with the review wording when the holder's quota is full, and nothing is closed", async () => {
    occupy("u-s1", "a-lab");
    occupy("u-s2", "a-lab");
    const mine = await liveReview("u-sam", REPO_A);
    const reply = await review({ projectRepoId: REPO_B, maxActiveSessions: 2 });
    // Sam's own review is excluded, and the two students fill the quota.
    expect(reply.statusCode).toBe(429);
    expect(reply.body).toContain("Quota atteint");
    expect(reply.body).toContain("deux dépôts ouverts dans l'espace de travail");
    expect(h.closes).toEqual([]);
    expect(h.db.select().from(sessions).where(eq(sessions.id, mine)).get()?.state).toBe("running");
  });

  it("the quota excludes the staff member's review it replaces, then closes it (one per staff member)", async () => {
    occupy("u-s1", "a-lab");
    const previous = await liveReview("u-sam", REPO_A);
    // Holder's live sessions: u-s1 and Sam's review of A. Without the
    // exclusion a quota of 2 would refuse; with it, B replaces A.
    const reply = await review({ projectRepoId: REPO_B, maxActiveSessions: 2 });
    expect(reply.statusCode).toBe(303);
    expect(h.closes).toEqual([previous]);
    expect(h.starts.map((s) => s.assignmentId)).toEqual([`review-${REPO_A}`, `review-${REPO_B}`]);
  });

  it("at most two live review sessions per holder, the replaced one excluded", async () => {
    await liveReview("u-ana", REPO_A);
    await liveReview("u-bob", REPO_B);
    const refused = await review({ projectRepoId: REPO_C });
    expect(refused.statusCode).toBe(429);
    expect(h.closes).toEqual([]);
    // Bob switching repositories frees his own place first: allowed.
    const bob = await review({ sub: "u-bob", email: "u-bob@heig-vd.ch", projectRepoId: REPO_C });
    expect(bob.statusCode).toBe(303);
    expect(h.closes).toEqual([`sess-u-bob-review-${REPO_B}`]);
  });

  it("two simultaneous openings by one staff member leave one live review (one at a time per login)", async () => {
    const first = await liveReview("u-sam", REPO_A);
    const [b, c] = await Promise.all([review({ projectRepoId: REPO_B }), review({ projectRepoId: REPO_C })]);
    expect([b.statusCode, c.statusCode]).toEqual([303, 303]);
    // Which opening reaches the serializer first depends on the token check
    // that precedes it, so either order may win; the second replaces the
    // first, which replaced A: never two at once.
    const live = h.db.all<{ id: string }>("SELECT id FROM sessions WHERE student = 'u-sam' AND state = 'running'");
    expect(live).toHaveLength(1);
    const [winner, loser] =
      live[0]!.id === `sess-u-sam-review-${REPO_C}` ? [REPO_C, REPO_B] : [REPO_B, REPO_C];
    expect(live).toEqual([{ id: `sess-u-sam-review-${winner}` }]);
    expect(h.closes).toEqual([first, `sess-u-sam-review-${loser}`]);
  });

  it("resuming the same repository's live review consults no quota and closes nothing", async () => {
    await liveReview("u-sam", REPO_A);
    occupy("u-s1", "a-lab");
    const reply = await review({ maxActiveSessions: 1 });
    expect(reply.statusCode).toBe(303);
    expect(h.closes).toEqual([]);
  });

  it("a student's session is never closed by a review, and a review is never one of the project's sessions", async () => {
    await put(syncBody({ id: PROJECT }), {}, PROJECT);
    expect((await h.app.inject({ url: `/launch?token=${await launchToken({ assignmentId: PROJECT })}` })).statusCode).toBe(303);
    // Sam, also enrolled, has a student workspace of the project: it stays.
    expect((await h.app.inject({ url: `/launch?token=${await launchToken({ assignmentId: PROJECT, sub: "u-sam", email: "sam@heig-vd.ch" })}` })).statusCode).toBe(303);
    await liveReview("u-sam", REPO_A);
    await liveReview("u-sam", REPO_B);
    expect(h.closes).toEqual([`sess-u-sam-review-${REPO_A}`]);

    const list = CodespaceSessionSummary.array().parse((await sessionsOf(PROJECT)).json());
    expect(list.map((s) => s.userId).sort()).toEqual(["u-sacha", "u-sam"]);
    expect(list.every((s) => !s.sessionId.includes("review-"))).toBe(true);
  });

  it("no log line carries the token (invariant 15)", async () => {
    await h.app.close();
    h.handle.close();
    const lines: string[] = [];
    h = await harness({}, lines);
    const token = await reviewToken();
    expect((await h.app.inject({ url: `/review?token=${token}` })).statusCode).toBe(303);
    expect((await h.app.inject({ url: `/review?token=${token}` })).statusCode).toBe(403);
    const signature = token.split(".")[2] as string;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(signature);
  });
});

// --- POST /api/sittings/close (ADR-089) ---------------------------------------

describe("POST /api/sittings/close", () => {
  const SITTING = "6f1c2a3b-0000-4000-8000-0000000000a1";
  const OTHER = "6f1c2a3b-0000-4000-8000-0000000000a2";
  const PROJECT = "6f1c2a3b-0000-4000-8000-0000000000b1";

  function closeToken(over: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
    jtiCounter += 1;
    return signHs256(
      { iss: "heig-quiz", aud: "heig-codespace-sitting-close", iat: now(), exp: now() + 120, jti: `close-${jtiCounter}`, sitting: SITTING, projectId: PROJECT, ...over },
      secret,
    );
  }
  const close = async (token: string | null) =>
    h.app.inject({ method: "POST", url: "/api/sittings/close", ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }) });

  /** A session opened last by `sitting` (null: by SEB or a browser), its cookie token `token`. */
  function session(id: string, sitting: string | null, token = `tok-${id}`): void {
    const at = new Date();
    h.db.insert(users).values({ id: `user-${id}`, oidcSub: `classroom:${id}`, login: id, email: `${id}@heig-vd.ch`, displayName: id, createdAt: at }).run();
    h.db.insert(sessions).values({ id, userId: `user-${id}`, student: id, assignmentId: "a-lab", volumeDir: `/tmp/${id}`, state: "running", createdAt: at, lastSeen: at, cookieToken: token, openedBySitting: sitting }).run();
  }
  const row = (id: string) => h.db.select().from(sessions).where(eq(sessions.id, id)).get();
  const closed = () => h.db.select().from(closedSittings).all().map((r) => r.sitting);

  beforeEach(async () => {
    expect((await put(syncBody({ mode: "online_seb" }))).statusCode).toBe(200);
  });

  it("401 without a token, with another secret, another audience or issuer, expired, over two minutes, without a jti", async () => {
    expect((await close(null)).statusCode).toBe(401);
    for (const token of [
      await closeToken({}, "another-secret-0123456789012345678"),
      await closeToken({ aud: "heig-codespace-api" }),
      await closeToken({ iss: "heig-classroom" }),
      await closeToken({ iat: now() - 400, exp: now() - 280 }),
      await closeToken({ exp: now() + 121 }),
      await closeToken({ jti: undefined }),
      await closeToken({ sitting: "not-a-uuid" }),
      await serviceToken("POST", "/api/sittings/close"),
    ]) {
      expect((await close(token)).statusCode).toBe(401);
    }
    expect(closed()).toEqual([]);
  });

  it("revokes that sitting only, and rotates the session that sitting opened last", async () => {
    session("station", SITTING);
    session("other-station", OTHER);
    session("seb", null);
    const reply = await close(await closeToken());
    expect(reply.statusCode).toBe(204);
    expect(closed()).toEqual([SITTING]);
    expect(row("station")?.cookieToken).not.toBe("tok-station");
    expect(row("station")?.openedBySitting).toBeNull();
    // Container and state untouched: only the cookie moved.
    expect(row("station")?.state).toBe("running");
    expect(row("other-station")).toMatchObject({ cookieToken: "tok-other-station", openedBySitting: OTHER });
    expect(row("seb")).toMatchObject({ cookieToken: "tok-seb", openedBySitting: null });
    expect(h.closes).toEqual([]);
  });

  it("leaves a session another browser resumed since: its cookie already left the station", async () => {
    session("resumed", null);
    expect((await close(await closeToken())).statusCode).toBe(204);
    expect(row("resumed")?.cookieToken).toBe("tok-resumed");
  });

  it("is idempotent: a replay, a second close and an unknown sitting answer 204 without effect", async () => {
    session("station", SITTING);
    const token = await closeToken();
    expect((await close(token)).statusCode).toBe(204);
    const rotated = row("station")?.cookieToken;
    expect((await close(token)).statusCode).toBe(204);
    expect((await close(await closeToken())).statusCode).toBe(204);
    expect(row("station")?.cookieToken).toBe(rotated);
    expect((await close(await closeToken({ sitting: OTHER, projectId: null }))).statusCode).toBe(204);
    expect(closed().sort()).toEqual([SITTING, OTHER].sort());
  });
});

describe("consumeJti", () => {
  it("accepts a fresh `jti`, refuses the second one, purges the expired ones", () => {
    const handle = openDb(":memory:");
    const t = Math.floor(Date.now() / 1000);
    expect(consumeJti(handle.db, "a", t + 300)).toBe(true);
    expect(consumeJti(handle.db, "a", t + 300)).toBe(false);
    // An already expired token: the row is inserted then swept on the next
    // pass, because `verifyHs256` refuses it anyway.
    consumeJti(handle.db, "old", t - 3600);
    consumeJti(handle.db, "b", t + 300);
    const rows = handle.db.all<{ jti: string }>("SELECT jti FROM launch_tokens_used ORDER BY jti");
    expect(rows.map((r) => r.jti)).toEqual(["a", "b"]);
    handle.close();
  });

  it("keeps a row while verifyHs256 may still accept its token: exp + skew, plus a minute (audit M11)", () => {
    const handle = openDb(":memory:");
    const t = 2_000_000_000;
    const at = (seconds: number) => new Date(seconds * 1000);
    expect(JTI_RETENTION_AFTER_EXP_MS).toBe((HS256_SKEW_SECONDS + 60) * 1000);
    consumeJti(handle.db, "expired-10s-ago", t - 10, at(t));
    consumeJti(handle.db, "expired-89s-ago", t - 89, at(t));
    consumeJti(handle.db, "expired-91s-ago", t - 91, at(t));
    consumeJti(handle.db, "fresh", t + 120, at(t));
    const rows = handle.db.all<{ jti: string }>("SELECT jti FROM launch_tokens_used ORDER BY jti");
    expect(rows.map((r) => r.jti)).toEqual(["expired-10s-ago", "expired-89s-ago", "fresh"]);
    // Within the window, the replay is refused.
    expect(consumeJti(handle.db, "expired-10s-ago", t - 10, at(t))).toBe(false);
    handle.close();
  });
});
