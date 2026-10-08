/**
 * The help assistant's data tools (ADR-080 §8 and its P2 amendment) over the
 * real application: the closed allowlist, the per-question token (its
 * audience, never listed, deleted at the end of the question, purged when
 * left), the results reader through the gradebook route — another teacher's
 * classroom a 404, an administrator's Super Powers never passing, final
 * marks only while an evaluation runs —, the screen's ids (a closed list,
 * stored without them), and what an exchange stores. The model is a fake
 * provider that calls the tools it is handed; the development stub answers
 * through the same token and routes.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AssistReply, type ApiToken } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { MCP_PATH } from "../../auth/oauth/service.js";
import { INTERNAL_CALL_HEADER } from "../../auth/plugin.js";
import { ASSIST_AUDIENCE, ASSIST_TOKEN_TTL_MS, mintAssistToken, purgeAssistTokens } from "../../auth/tokens.js";
import { loadConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { apiTokens, assistExchanges, evaluationItems } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as grading from "../grading/service.js";
import * as live from "../live/service.js";
import type { ConverseReply, ConverseRequest, LlmProvider, Metered } from "../llm/provider.js";
import { LlmError, LlmGateway } from "../llm/service.js";
import { TOOLS, toolByName } from "../mcp/tools.js";
import { loadConfig as loadQuestionConfig, typeOf } from "../pool/config.js";
import * as results from "../results/service.js";
import { ASSIST_DATA_TOOLS, MCP_READS, RESULTS_TOOL } from "./tools.js";

const SECRET = "test-llm-master-key-0123456789abcdef";
const KEY = "sk-ant-api03-test-key-0123456789-WXYZ";
type Who = { id: string; headers: Record<string, string> };

let restore: () => void;
let server: TestServer;
let teacher: Who;
let colleague: Who;
let students: Who[];
let seed: Seeded;
/** A running exam of the classroom, with a graded answer and a staff mark in its column. */
let runningId: string;

/** What the fake model does with the request of the next question; the requests it was handed. */
let script: (req: ConverseRequest, metered: Metered) => Promise<ConverseReply>;
const seen: ConverseRequest[] = [];
const fake: LlmProvider = {
  id: "anthropic",
  complete: () => Promise.reject(new Error("no structured call here")),
  converse(req, metered) {
    seen.push(req);
    return script(req, metered);
  },
};
/** A model that calls one tool once, keeps its result, and answers `text`. */
let lastToolResult: { content: string; error: boolean } | null = null;
const callsTool =
  (name: string, input: unknown, text = "Voici.") =>
  async (req: ConverseRequest, metered: Metered): Promise<ConverseReply> => {
    await metered(1_000, async () => ({ model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 100 }));
    const tool = req.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    try {
      lastToolResult = { content: await tool.run(input), error: false };
    } catch (err) {
      lastToolResult = { content: (err as Error).message, error: true };
    }
    return { text, model: "claude-sonnet-5-5", steps: 1 };
  };

const db = (): Db => server.app.db;
const call = (who: { headers: Record<string, string> }, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });
const ask = (who: Who, message: string, entities?: Record<string, string>) =>
  call(who, "POST", "/app/api/assist/ask", {
    message,
    context: { route: "/classrooms/:id", helpTopic: null, locale: "fr", ...(entities ? { entities } : {}) },
  });

/** Plays an evaluation: each taker hands in and is graded on its one 10-point item; closed and released when asked. */
async function play(id: string, takers: { student: number; points: number }[], finish: boolean) {
  const now = server.clock.now();
  let evaluation = await applyState(db(), await reload(db(), id), "running", now);
  const [item] = await joinedItems(db(), id);
  await db().update(evaluationItems).set({ points: 10 }).where(eq(evaluationItems.id, item!.item.id));
  for (const { student, points } of takers) {
    const participant = (await live.participantOf(db(), evaluation, students[student]!.id))!;
    const created = await live.ensureAttempt(db(), evaluation, participant, now);
    const attempt = await live.beginAttempt(db(), evaluation, created, participant, now);
    await live.submitAttempt(db(), evaluation, attempt, now);
    await grading.writeGrading(db(), {
      attemptId: attempt.id,
      itemId: item!.item.id,
      answerId: null,
      points,
      maxPoints: 10,
      source: "manual",
      state: "validated",
      details: { manual: true },
      now,
    });
  }
  if (finish) {
    evaluation = await live.closeEvaluation(db(), evaluation, now, "teacher");
    await results.releaseResults(db(), await reload(db(), id), now);
  }
  server.clock.advance(60_000);
}

async function setup(stub: boolean) {
  const env = { LLM_KEY_SECRET: SECRET, ...(stub ? { LLM_PROVIDER: "stub" } : {}) };
  server = await testServer(env);
  server.clock.set("2026-10-08T09:00:00.000Z");
  server.app.llmGateway = new LlmGateway({
    db: server.app.db,
    clock: server.clock,
    config: loadConfig({ NODE_ENV: "test", ...env }),
    provider: fake,
  });
  teacher = await server.signIn("teacher");
  colleague = await server.signIn("teacher");
  students = await Promise.all([0, 1].map(() => server.signIn("student")));
  seed = await seedLive(db(), { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 1 });
  // The final exam: Prenom0 8/10, Prenom1 5/10, released.
  await play(seed.evaluationId, [{ student: 0, points: 8 }, { student: 1, points: 5 }], true);
  // A running exam: Prenom0 already graded 3/10, and a staff mark for Prenom1 in its column.
  const running = await evaluationService.createEvaluation(db(), {
    classroomId: seed.classroomId,
    title: "Examen en cours",
    mode: "exam",
    createdBy: teacher.id,
  });
  runningId = running.id;
  await evaluationService.addItems(
    db(),
    (await evaluationService.byId(db(), runningId))!,
    seed.questionIds,
    (type, version) => typeOf(type).defaultPoints(loadQuestionConfig(type, version)),
    { attemptCount: 0 },
  );
  await play(runningId, [{ student: 0, points: 3 }], false);
  const table = (await call(teacher, "GET", `/app/api/classrooms/${seed.classroomId}/gradebook`)).json() as {
    rows: { enrollmentId: string; prenom: string }[];
  };
  const seat = table.rows.find((r) => r.prenom === "Prenom1")!.enrollmentId;
  const mark = await call(
    teacher,
    "PUT",
    `/app/api/classrooms/${seed.classroomId}/gradebook/columns/evaluation/${runningId}/marks/${seat}`,
    { kind: "score", points: 2.75, max: 10 },
  );
  expect(mark.statusCode, mark.body).toBe(200);
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  await setup(true);
});
afterAll(async () => {
  await server.close();
  restore();
});
beforeEach(() => {
  server.clock.advance(61_000);
  seen.length = 0;
  lastToolResult = null;
});

describe("the development stub reads through the same token and routes", () => {
  it("answers the teacher's own classroom's final results", async () => {
    const res = await ask(teacher, "Quels sont les résultats de la classe ?", { classroom: seed.classroomId });
    expect(res.statusCode, res.body).toBe(200);
    const answer = AssistReply.parse(res.json()).exchange.answer;
    expect(answer).toContain("**Prenom0 Nom0**");
    expect(answer).toContain("Test évaluation 5.0");
    // Final marks only: neither the running exam, its graded answer nor its staff mark.
    expect(answer).not.toContain("Examen en cours");
    expect(answer).toContain("1 colonne(s) non publiée(s)");
  });

  it("refuses a screen context that names a student, a user or an attempt", async () => {
    for (const kind of ["student", "user", "enrollment", "attempt"]) {
      const res = await ask(teacher, "Ses notes ?", { classroom: seed.classroomId, [kind]: students[0]!.id });
      expect(res.statusCode, kind).toBe(400);
    }
  });

  it("stores the screen without its ids, and the answer, never what a tool read beyond it", async () => {
    const res = await ask(teacher, "Comment partager une banque ?", { classroom: seed.classroomId, course: seed.courseId });
    const { exchange } = AssistReply.parse(res.json());
    const [row] = await db().select().from(assistExchanges).where(eq(assistExchanges.id, exchange.id));
    expect(row!.context).toEqual({ route: "/classrooms/:id", helpTopic: null, locale: "fr" });
    expect(JSON.stringify(row)).not.toContain(seed.classroomId);
  });

  it("leaves no token behind", async () => {
    await ask(teacher, "Quels sont les résultats ?", { classroom: seed.classroomId });
    expect(await db().select().from(apiTokens).where(eq(apiTokens.audience, ASSIST_AUDIENCE))).toHaveLength(0);
  });
});

describe("the per-question token (ADR-080 §8)", () => {
  it("is good for the in-process calls only: refused from outside and on the public MCP path", async () => {
    const { token } = await mintAssistToken(db(), teacher.id, server.clock.now());
    const bearer = { authorization: `Bearer ${token}` };
    const inside = { ...bearer, [INTERNAL_CALL_HEADER]: server.app.internalCallSecret };
    expect((await server.app.inject({ method: "GET", url: "/app/api/courses", headers: inside })).statusCode).toBe(200);
    expect((await server.app.inject({ method: "GET", url: "/app/api/courses", headers: bearer })).statusCode).toBe(401);
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await server.app.inject({ method: "POST", url: MCP_PATH, headers: bearer, payload: rpc })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "POST", url: MCP_PATH, headers: inside, payload: rpc })).statusCode).toBe(401);
    // Never on the teacher's tokens page, and not revocable there.
    const listed = (await call(teacher, "GET", "/app/api/me/tokens")).json() as ApiToken[];
    expect(listed).toEqual([]);
  });

  it("expires, and the daily task deletes one left behind", async () => {
    const { id, token } = await mintAssistToken(db(), teacher.id, server.clock.now());
    server.clock.advance(ASSIST_TOKEN_TTL_MS + 1_000);
    const inside = { authorization: `Bearer ${token}`, [INTERNAL_CALL_HEADER]: server.app.internalCallSecret };
    expect((await server.app.inject({ method: "GET", url: "/app/api/courses", headers: inside })).statusCode).toBe(401);
    expect(await purgeAssistTokens(db(), server.clock.now())).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(apiTokens).where(eq(apiTokens.id, id))).toHaveLength(0);
  });
});

describe("the model's tools", () => {
  beforeAll(async () => {
    await server.close();
    await setup(false);
    const admin = await server.signIn("admin");
    expect((await call(admin, "PATCH", "/app/api/admin/llm", { apiKey: KEY })).statusCode).toBe(200);
  });

  it("are a closed allowlist: read_guide, the MCP reads without student data, and the results reader", async () => {
    script = callsTool("list_courses", {});
    expect((await ask(teacher, "Mes cours ?")).statusCode).toBe(200);
    const names = seen[0]!.tools.map((t) => t.name);
    expect(names).toEqual(["read_guide", ...ASSIST_DATA_TOOLS]);
    expect(names).toEqual([
      "read_guide",
      "list_courses",
      "get_course",
      "list_pools",
      "get_pool",
      "get_pool_question_stats",
      "list_questions",
      "find_similar_questions",
      "get_question",
      "describe_question_types",
      "list_evaluations",
      "get_evaluation",
      "list_templates",
      "get_classroom_results",
    ]);
    // Every MCP write is out of reach, whatever its name; the results reader is not in the MCP catalogue.
    const writes = TOOLS.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name);
    expect(writes.length).toBeGreaterThan(0);
    for (const name of writes) expect(names).not.toContain(name);
    expect(TOOLS.map((t) => t.name)).not.toContain(RESULTS_TOOL);
    // The assistant's own descriptions: no authoring nudge.
    for (const tool of seen[0]!.tools) expect(tool.description).not.toMatch(/BEFORE create|create_question|Look before/i);
  });

  it("mint no token for a question the documentation answers", async () => {
    const tokens = () => db().select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.audience, ASSIST_AUDIENCE));
    let during: unknown[] = ["unset"];
    script = async (req, metered) => {
      const reply = await callsTool("read_guide", { page: "guide/pools" })(req, metered);
      during = await tokens();
      return reply;
    };
    expect((await ask(teacher, "Comment partager une banque ?")).statusCode).toBe(200);
    expect(lastToolResult!.error).toBe(false);
    expect(during).toEqual([]);
    expect(await tokens()).toEqual([]);
  });

  it("run under a token minted on the first data call, not listed while it lives, and gone after", async () => {
    let before: unknown[] = ["unset"];
    let during: { audience: string | null; userId: string }[] = [];
    let listed: ApiToken[] = [];
    script = async (req, metered) => {
      before = await db().select().from(apiTokens).where(eq(apiTokens.audience, ASSIST_AUDIENCE));
      const reply = await callsTool("list_courses", {})(req, metered);
      // A second data call reuses the question's token.
      await req.tools.find((t) => t.name === "list_pools")!.run({});
      during = await db().select({ audience: apiTokens.audience, userId: apiTokens.userId }).from(apiTokens);
      listed = (await call(teacher, "GET", "/app/api/me/tokens")).json() as ApiToken[];
      return reply;
    };
    expect((await ask(teacher, "Mes cours ?")).statusCode).toBe(200);
    expect(before).toEqual([]);
    expect(during).toEqual([{ audience: ASSIST_AUDIENCE, userId: teacher.id }]);
    expect(listed).toEqual([]);
    expect(lastToolResult!.error).toBe(false);
    expect(lastToolResult!.content).toContain(seed.courseId);
    expect(await db().select().from(apiTokens).where(eq(apiTokens.audience, ASSIST_AUDIENCE))).toHaveLength(0);
  });

  it("delete the token even when the model fails after a data call", async () => {
    let minted = 0;
    script = async (req, metered) => {
      await callsTool("list_courses", {})(req, metered);
      minted = (await db().select().from(apiTokens).where(eq(apiTokens.audience, ASSIST_AUDIENCE))).length;
      throw new LlmError("provider_error");
    };
    expect((await ask(teacher, "Mes cours ?")).statusCode).toBe(502);
    expect(minted).toBe(1);
    expect(await db().select().from(apiTokens).where(eq(apiTokens.audience, ASSIST_AUDIENCE))).toHaveLength(0);
  });

  it("are, every MCP one of them, read-only tools of the catalogue", () => {
    for (const name of Object.keys(MCP_READS)) {
      expect(toolByName.get(name)?.annotations.readOnlyHint, name).toBe(true);
    }
  });

  it("read the final results of the teacher's classroom, never a running evaluation's scores", async () => {
    script = callsTool(RESULTS_TOOL, { classroomId: seed.classroomId }, "Prenom0 a 5.0.");
    expect((await ask(teacher, "Les notes ?", { classroom: seed.classroomId })).statusCode).toBe(200);
    const read = JSON.parse(lastToolResult!.content) as {
      columns: { title: string }[];
      students: { name: string; grades: unknown[]; mean: number | null }[];
      unreleasedColumns: number;
    };
    expect(read.columns.map((c) => c.title)).toEqual(["Test évaluation"]);
    expect(read.students).toEqual([
      { name: "Prenom0 Nom0", grades: [5], mean: 5 },
      { name: "Prenom1 Nom1", grades: [3.5], mean: 3.5 },
    ]);
    expect(read.unreleasedColumns).toBe(1);
    expect(lastToolResult!.content).not.toContain("Examen en cours");
    expect(lastToolResult!.content).not.toContain("2.75");
    expect(lastToolResult!.content).not.toContain(runningId);
    // The evaluation's structure stays readable while it runs.
    script = callsTool("get_evaluation", { evaluationId: runningId });
    await ask(teacher, "Et l'examen en cours ?");
    expect(lastToolResult!.error).toBe(false);
    expect(lastToolResult!.content).toContain("Examen en cours");
  });

  it("are a 404 on another teacher's classroom, told as a missing seat", async () => {
    script = callsTool(RESULTS_TOOL, { classroomId: seed.classroomId });
    await ask(colleague, "Les notes ?", { classroom: seed.classroomId });
    expect(lastToolResult).toEqual({ content: expect.stringContaining("no seat on the course"), error: true });
    script = callsTool("get_course", { courseId: seed.courseId });
    await ask(colleague, "Ce cours ?");
    expect(lastToolResult!.error).toBe(true);
  });

  it("never lend Super Powers to an administrator's assistant", async () => {
    const admin = await server.signInWithSuperPowers();
    script = callsTool(RESULTS_TOOL, { classroomId: seed.classroomId });
    await ask(admin, "Les notes ?", { classroom: seed.classroomId });
    expect(lastToolResult).toEqual({ content: expect.stringContaining("no seat on the course"), error: true });
  });

  it("store the question and the answer, never what a tool returned", async () => {
    script = callsTool(RESULTS_TOOL, { classroomId: seed.classroomId }, "Deux élèves.");
    const { exchange } = AssistReply.parse((await ask(teacher, "Les notes ?", { classroom: seed.classroomId })).json());
    expect(lastToolResult!.content).toContain("Prenom0");
    const rows = await db().select().from(assistExchanges).where(eq(assistExchanges.id, exchange.id));
    expect(JSON.stringify(rows)).not.toContain("Prenom0");
    expect(rows[0]!.answer).toBe("Deux élèves.");
  });
});
