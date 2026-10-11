/**
 * The training routes (ADR-105): who reaches them (§1: a teacher's or an
 * admin's own portal session, nobody else), the admin task that installs
 * the content, the provisioning over HTTP, and the progress card (§4) whose
 * four missions flip on real service calls — including the staff seat's
 * released grade on the feedback path (`releasedGradesOf`, the live tally,
 * since a staff attempt is frozen in no snapshot). The shipped content is
 * replaced by the test fixture, so the task installs two questions and the
 * provisioning opens a welcome quiz that holds them.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CSRF_COOKIE, type TrainingStatus } from "@quiz/contracts";

import { SESSION_COOKIE, createSession, type NewSession } from "../../auth/session.js";
import { evaluations, oauthClients, userEmails } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { evaluationRows } from "../../test/grades.js";
import { kioskStation } from "../../test/kiosk.js";
import { publishQuestion, reload } from "../../test/live.js";
import { TRAINING_SHORT } from "../../test/training.js";
import * as evaluationService from "../evaluation/service.js";
import { saveAsTemplate } from "../evaluation/templates.js";
import { runEvaluationGrading } from "../grading/jobs.js";
import * as live from "../live/service.js";
import * as poolService from "../pool/service.js";
import { releaseResults } from "../results/service.js";
import { trainingPool } from "./service.js";

vi.mock("./content.js", async () => ({ TRAINING_CONTENT: (await import("../../test/training.js")).trainingFixture() }));

const ADMIN_EMAIL = "admin@heig.test";
type Headers = Record<string, string>;

let server: TestServer;
let admin: { id: string; headers: Headers };
let teacher: { id: string; headers: Headers };
let student: { id: string; headers: Headers };

const get = (url: string, headers: Headers) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Headers, payload?: Record<string, unknown>) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

async function statusOf(headers = teacher.headers): Promise<TrainingStatus> {
  const res = await get("/app/api/training", headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TrainingStatus;
}

const missions = (s: TrainingStatus) => Object.fromEntries(s.missions.map((m) => [m.key, m.state]));

/** A session of another kind for `userId`, as its cookie headers. */
async function sessionOf(userId: string, auth: Partial<NewSession> & Pick<NewSession, "kind">): Promise<Headers> {
  const s = await createSession(server.app.db, userId, 8, { actorUserId: null, evaluationId: null, projectId: null, ...auth });
  return {
    cookie: `${server.app.cookieName(SESSION_COOKIE)}=${s.token}; ${server.app.cookieName(CSRF_COOKIE)}=${s.csrf}`,
    "x-csrf-token": s.csrf,
  };
}

/** An OAuth access token of `headers`'s teacher (ADR-023): the real register → consent → exchange. */
async function oauthBearer(headers: Headers): Promise<string> {
  const issuer = "http://localhost:3000";
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const client = (await post("/app/oauth/register", {}, { redirect_uris: [redirect], client_name: "Claude", token_endpoint_auth_method: "none" })).json() as {
    client_id: string;
  };
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "quiz",
    resource: `${issuer}/app/api/mcp`,
  });
  const start = await server.app.inject({ method: "GET", url: `/app/oauth/authorize?${params}` });
  const id = (start.headers.location as string).split("/").pop()!;
  const decision = await post(`/app/api/oauth/requests/${id}/decision`, headers, { approve: true });
  const code = new URL((decision.json() as { redirectTo: string }).redirectTo).searchParams.get("code")!;
  const exchanged = await server.app.inject({
    method: "POST",
    url: "/app/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      client_id: client.client_id,
      resource: `${issuer}/app/api/mcp`,
    }).toString(),
  });
  expect(exchanged.statusCode, exchanged.body).toBe(200);
  return (exchanged.json() as { access_token: string }).access_token;
}

beforeAll(async () => {
  server = await testServer({ SUPER_ADMIN_EMAIL: ADMIN_EMAIL });
  server.clock.set("2026-10-11T10:00:00.000Z");
  admin = await server.signIn("admin", ADMIN_EMAIL);
  // The install resolves the super admin through verified addresses, as a sign-in records them.
  await server.app.db.insert(userEmails).values({ userId: admin.id, email: ADMIN_EMAIL, source: "login", verified: true });
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(() => server.close());

describe("before the install", () => {
  it("reports nothing installed, no course, every mission to do; provisioning is refused", async () => {
    expect(await statusOf()).toEqual({
      installed: false,
      course: null,
      missions: [
        { key: "student", state: "todo" },
        { key: "run", state: "todo" },
        { key: "own", state: "todo" },
        { key: "tools", state: "todo" },
      ],
    });
    const res = await post("/app/api/training", teacher.headers);
    expect([res.statusCode, res.json().error]).toEqual([409, "training_not_installed"]);
  });
});

describe("the training.install admin task (§2)", () => {
  it("is in the catalog and installs the content when run", async () => {
    const list = (await get("/app/api/admin/tasks", admin.headers)).json() as { key: string }[];
    expect(list.map((t) => t.key)).toContain("training.install");
    const res = await post("/app/api/admin/tasks/training.install/run", admin.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ key: "training.install", lastStatus: "ok", lastMessage: "2 created, 0 updated, 0 unchanged" });
    expect((await statusOf()).installed).toBe(true);
    expect((await trainingPool(server.app.db))!.ownerId).toBe(admin.id);
  });
});

describe("provisioning over HTTP and the four missions (§1, §4)", () => {
  let courseId: string;
  let classroomId: string;

  const evaluationTitled = async (title: string) => {
    const [row] = await server.app.db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.classroomId, classroomId), eq(evaluations.title, title)));
    return row!;
  };

  it("provisions once: 201 then 200 with the same course; the welcome quiz is open", async () => {
    const first = await post("/app/api/training", { ...teacher.headers, "accept-language": "fr" });
    expect(first.statusCode, first.body).toBe(201);
    const body = first.json() as { courseId: string; classroomId: string; created: boolean };
    expect(body.created).toBe(true);
    ({ courseId, classroomId } = body);
    const second = await post("/app/api/training", teacher.headers);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ courseId, classroomId, created: false });
    const s = await statusOf();
    const liveQuiz = await evaluationTitled("Le quiz en direct");
    expect(s.course).toEqual({ id: courseId, classroomId, liveEvaluationId: liveQuiz.id });
    expect(await evaluationTitled("Le quiz d'accueil")).toMatchObject({ state: "running", mode: "exercise" });
    // No LLM gateway and no OAuth client in this server: the fourth mission cannot be done.
    expect(missions(s)).toEqual({ student: "todo", run: "todo", own: "todo", tools: "unavailable" });
  });

  it("a student, a personal token, an OAuth token, an impersonation, a seb and a kiosk session are refused (§1)", async () => {
    const other = await server.signIn("teacher");
    const token = (await post("/app/api/me/tokens", other.headers, { name: "t" })).json() as { token: string };
    const oauth = await oauthBearer(other.headers);
    const welcome = await evaluationTitled("Le quiz d'accueil");
    const station = await kioskStation(server.app);
    const kiosk = await sessionOf(student.id, { kind: "kiosk", evaluationId: welcome.id, deviceId: station.deviceId });
    // An impersonation session's write is refused by the session layer first (ADR-034); its read by the route's guard.
    // An OAuth token's audience is the MCP endpoint, and a seb or kiosk session is confined to its evaluation's
    // routes (ADR-027, ADR-051): the session layer refuses them everywhere else, as nobody.
    const callers: [string, Headers, Record<"GET" | "POST", [number, string]>][] = [
      ["student", student.headers, { GET: [403, "forbidden"], POST: [403, "forbidden"] }],
      ["token", { authorization: `Bearer ${token.token}` }, { GET: [403, "session_required"], POST: [403, "session_required"] }],
      ["oauth", { authorization: `Bearer ${oauth}` }, { GET: [401, "unauthenticated"], POST: [401, "unauthenticated"] }],
      [
        "impersonation",
        await sessionOf(teacher.id, { kind: "impersonation", actorUserId: admin.id }),
        { GET: [403, "session_required"], POST: [403, "impersonation_read_only"] },
      ],
      ["seb", await sessionOf(student.id, { kind: "seb", evaluationId: welcome.id }), { GET: [401, "unauthenticated"], POST: [401, "unauthenticated"] }],
      ["kiosk", { ...kiosk, cookie: `${kiosk.cookie}; ${station.cookie}` }, { GET: [401, "unauthenticated"], POST: [401, "unauthenticated"] }],
    ];
    try {
      for (const [who, headers, expected] of callers) {
        for (const method of ["GET", "POST"] as const) {
          const res = await server.app.inject({ method, url: "/app/api/training", headers });
          expect([res.statusCode, res.json().error], `${who} ${method}`).toEqual(expected[method]);
        }
      }
      expect((await get("/app/api/training", admin.headers)).statusCode).toBe(200);
    } finally {
      // The OAuth client registered above goes, grant and token with it: mission 4 starts from nothing.
      await server.app.db.delete(oauthClients);
    }
  });

  /** The seated teacher enters and hands in, as a student does (ADR-018). */
  const takeAsSeat = async (evaluationId: string) => {
    const db = server.app.db;
    const evaluation = await reload(db, evaluationId);
    const participant = (await live.participantOf(db, evaluation, teacher.id))!;
    const entered = await live.enterEvaluation(db, { evaluation, participant, now: server.clock.now(), start: true });
    if (entered.kind !== "attempt") throw new Error(`entered ${entered.kind}`);
    server.clock.advance(60_000);
    await live.submitAttempt(db, evaluation, entered.attempt, server.clock.now());
  };

  it("mission 1: joining as a student and handing in the welcome quiz", async () => {
    const seat = await post(`/app/api/classrooms/${classroomId}/self-enroll`, teacher.headers);
    expect(seat.statusCode, seat.body).toBe(201);
    expect(missions(await statusOf()).student).toBe("todo");
    await takeAsSeat((await evaluationTitled("Le quiz d'accueil")).id);
    expect(missions(await statusOf()).student).toBe("done");
  });

  it("mission 2: a released evaluation — and the seat reads its released grade", async () => {
    const db = server.app.db;
    const now = () => server.clock.now();
    let row = await evaluationTitled("Le quiz en direct");
    row = await evaluationService.patchEvaluation(db, row, { durationS: 600 }, { attemptCount: 0, now: now() });
    evaluationService.guardTransition(row, "running", { items: await evaluationService.itemRows(db, row.id), attemptCount: 0, now: now() });
    row = await live.startEvaluation(db, row, now());
    await takeAsSeat(row.id);
    row = await live.closeEvaluation(db, await reload(db, row.id), now());
    await runEvaluationGrading(server.app, { evaluationId: row.id });
    expect(missions(await statusOf()).run).toBe("todo");
    await releaseResults(db, await reload(db, row.id), now());
    expect(missions(await statusOf()).run).toBe("done");

    // ADR-105 §3 (2): the staff seat's grade is not in the frozen snapshot
    // (ADR-018), so the feedback path computes it from the live tally.
    const grades = await live.studentGrades(db, teacher.id, now());
    const mine = evaluationRows(grades).find((r) => r.evaluationId === row.id);
    expect(mine).toMatchObject({ status: "released", score: { grade: expect.any(Number), pendingCount: 0 } });
  });

  it("mission 3: a published question in a pool linked edit AND a template of the course", async () => {
    const db = server.app.db;
    const mine = await poolService.createPool(db, { name: "Ma banque", ownerId: teacher.id });
    // The whole set is replaced: the read link to the training pool stays beside the new one.
    await poolService.setCoursePools(
      db,
      courseId,
      [
        { poolId: (await trainingPool(db))!.id, mode: "read" },
        { poolId: mine.id, mode: "edit" },
      ],
      undefined,
      { id: teacher.id, role: "teacher", reach: "seats" },
    );
    await publishQuestion(db, mine.id, teacher.id, "ma-question", { type: "short", config: TRAINING_SHORT.config });
    expect(missions(await statusOf()).own).toBe("todo");
    const welcome = await evaluationTitled("Le quiz d'accueil");
    await saveAsTemplate(db, welcome, { courseId, title: "Quiz d'accueil (modèle)", createdBy: teacher.id });
    expect(missions(await statusOf()).own).toBe("done");
  });

  it("mission 4: unavailable without a gateway or a client; to do with a client; done with a token", async () => {
    expect(missions(await statusOf()).tools).toBe("unavailable");
    await server.app.db.insert(oauthClients).values({ id: "client-1", kind: "dcr", name: "An MCP host", redirectUris: ["https://host.test/cb"] });
    expect(missions(await statusOf()).tools).toBe("todo");
    const res = await post("/app/api/me/tokens", teacher.headers, { name: "mcp" });
    expect(res.statusCode, res.body).toBe(201);
    expect(missions(await statusOf()).tools).toBe("done");
  });
});
