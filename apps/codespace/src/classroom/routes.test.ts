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
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../auth/config.js";
import { openDb, type Db, type DbHandle } from "../db/client.js";
import { sessions, users, type AssignmentRow, type SessionRow, type UserRow } from "../db/schema.js";
import { CONFIG_KEY_HEADER, REQUEST_HASH_HEADER, expectedHash } from "@quiz/seb";

import { createPushEventStore } from "../git/index.js";
import { createSebVerifier } from "../seb/index.js";
import type { SessionManager, StartOptions, StartResult } from "../sessions/manager.js";
import { findAssignment } from "../sessions/store.js";

import { JTI_RETENTION_AFTER_EXP_MS, classroomRoutes, consumeJti } from "./routes.js";

const SECRET = "test-launch-secret-0123456789012345";
const CLASSROOM = "http://classroom.test";
const PORTAL = "http://portal.test";

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
}

function fakeManager(db: Db, starts: Harness["starts"]): SessionManager {
  return {
    async start(
      user: UserRow,
      assignment: AssignmentRow,
      opts: StartOptions = {},
    ): Promise<StartResult> {
      starts.push({ login: user.login, assignmentId: assignment.id, opts });
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
  const app = Fastify({
    logger: logLines ? { level: "trace", stream: { write: (line: string) => void logLines.push(line) } } : false,
  });
  await app.register(cookie);
  await app.register(classroomRoutes, {
    config,
    db: handle.db,
    manager: fakeManager(handle.db, starts),
    verifier: createSebVerifier({ mode: config.SEB_VERIFIER, nodeEnv: config.NODE_ENV, url: { publicOrigin: PORTAL } }),
    repoUrl: (repo) => `http://forge.test/${repo.owner}/${repo.name}.git`,
  });
  await app.ready();
  return { app, db: handle.db, handle, config, starts };
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
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
    expect(row?.image).toBe(h.config.CODESPACE_DEFAULT_IMAGE);
  });

  it("`image` from the body wins over the default image", async () => {
    await put(syncBody({ image: "codespace/python:1" }));
    expect(findAssignment(h.db, "a-lab")?.image).toBe("codespace/python:1");
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

  it("403 without a token", async () => {
    const reply = await h.app.inject({ url: "/launch" });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("Lancement refusé");
    expect(reply.body).toContain('<html lang="fr">');
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
    const reply = await h.app.inject({ url: `/launch?token=${token}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("expiré");
  });

  it("403 on a service token audience", async () => {
    await syncedAssignment();
    const token = await launchToken({ aud: "heig-codespace-api" });
    expect((await h.app.inject({ url: `/launch?token=${token}` })).statusCode).toBe(403);
  });

  it("single use: the same token does not serve twice", async () => {
    await syncedAssignment();
    const token = await launchToken();
    const first = await h.app.inject({ url: `/launch?token=${token}` });
    expect(first.statusCode).toBe(303);
    const second = await h.app.inject({ url: `/launch?token=${token}` });
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
    const replay = await h.app.inject({ url: `/launch?token=${token}` });
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
    const reply = await h.app.inject({ url: `/launch?token=${token}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("non synchronisée depuis la plateforme");
  });

  it("403 outside the assignment window", async () => {
    await syncedAssignment({ deadlineAt: "2020-06-01T00:00:00.000Z" });
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
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
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken({ repo: null })}` });
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
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
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
