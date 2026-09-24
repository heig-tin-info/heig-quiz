/**
 * The MCP endpoint over the REAL application (ADR-022): the handshake, the
 * catalogue, and one whole authoring session the way a model runs it —
 * course, classroom, pool, three questions of three types, an exercise —
 * through the ordinary routes, with the real question types.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiTokenCreated } from "@quiz/contracts";

import { evaluations } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { checkConfig, describeQuestionType } from "./questionTypes.js";
import { TOOLS } from "./tools.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string>; token: string };
let rpcId = 0;

async function tokenFor(headers: Record<string, string>) {
  const res = await server.app.inject({
    method: "POST",
    url: "/app/api/me/tokens",
    headers,
    payload: { name: "mcp test" },
  });
  return (res.json() as ApiTokenCreated).token;
}

beforeAll(async () => {
  server = await testServer();
  const signed = await server.signIn("teacher");
  teacher = { ...signed, token: await tokenFor(signed.headers) };
});
afterAll(() => server.close());

async function rpc(method: string, params?: unknown, token = teacher.token) {
  const res = await server.app.inject({
    method: "POST",
    url: "/app/api/mcp",
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) },
  });
  return res.json() as { result?: any; error?: { code: number; message: string } };
}

/** Calls a tool; returns its parsed JSON result and whether it was an error. */
async function call(name: string, args: Record<string, unknown> = {}, token = teacher.token) {
  const { result, error } = await rpc("tools/call", { name, arguments: args }, token);
  if (error) throw new Error(`${name}: ${error.message}`);
  return { isError: result.isError as boolean, data: JSON.parse(result.content[0].text) };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const { isError, data } = await call(name, args);
  expect(isError, `${name}: ${JSON.stringify(data)}`).toBe(false);
  return data;
}

describe("the transport", () => {
  it("refuses a browser session and an anonymous caller with 401", async () => {
    const payload = { jsonrpc: "2.0", id: 1, method: "ping" };
    const cookie = await server.app.inject({ method: "POST", url: "/app/api/mcp", headers: teacher.headers, payload });
    expect(cookie.statusCode).toBe(401);
    const anonymous = await server.app.inject({ method: "POST", url: "/app/api/mcp", payload });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toContain("Bearer");
  });

  it("answers GET with 405: there is no server stream", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/app/api/mcp",
      headers: { authorization: `Bearer ${teacher.token}` },
    });
    expect(res.statusCode).toBe(405);
  });

  it("negotiates the protocol version and announces the tools capability", async () => {
    const { result } = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toContain("link_pool_to_course");

    const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
  });

  it("acknowledges a notification with 202 and no body", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/app/api/mcp",
      headers: { authorization: `Bearer ${teacher.token}` },
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("");
  });

  it("answers an unknown method and an unknown tool with JSON-RPC errors", async () => {
    expect((await rpc("resources/list")).error?.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "drop_database", arguments: {} })).error?.code).toBe(-32602);
  });

  it("lists every tool with an object input schema", async () => {
    const { result } = await rpc("tools/list");
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(TOOLS.map((t) => t.name));
    for (const t of result.tools) expect(t.inputSchema.type, t.name).toBe("object");
    // Nothing destructive is exposed.
    expect(names.some((n: string) => /delete|remove|close|release/.test(n))).toBe(false);
  });
});

describe("the question-type guide", () => {
  it.each(["mcq", "short", "cloze"])("gives a %s example the publication gate accepts", (type) => {
    const guide = describeQuestionType(type) as { example: unknown; configSchema: { type: string } };
    expect(guide.configSchema.type).toBe("object");
    expect(checkConfig(type, guide.example)).toBeNull();
  });
});

describe("an authoring session", () => {
  it("builds a course, a classroom, a pool, three questions and an exercise", async () => {
    const course = await ok("create_course", { name: "Français", code: "FRA-MCP" });
    const room = await ok("create_classroom", { courseId: course.id, name: "Français 2026", period: "2026" });
    expect(room.url).toContain(`/classrooms/${room.id}`);
    const pool = await ok("create_pool", { name: "Culture générale" });
    await ok("link_pool_to_course", { courseId: course.id, poolId: pool.id });
    // Idempotent: a second link keeps one entry.
    const linked = await ok("link_pool_to_course", { courseId: course.id, poolId: pool.id });
    expect(linked.map((p: { id: string }) => p.id)).toEqual([pool.id]);

    const ids: string[] = [];
    for (const type of ["mcq", "short", "cloze"] as const) {
      const guide = describeQuestionType(type) as { example: Record<string, unknown> };
      const q = await ok("create_question", {
        poolId: pool.id,
        type,
        internalName: `fr-${type}`,
        config: guide.example,
        explanation: "Parce que.",
        difficulty: 4,
        tags: ["vocabulaire"],
      });
      expect(q).toMatchObject({ valid: true, publishedVersion: 1 });
      ids.push(q.questionId);
    }

    const listed = await ok("list_questions", { poolId: pool.id, type: ["mcq", "cloze"] });
    expect(listed.total).toBe(2);
    const detail = await ok("get_question", { questionId: ids[0] });
    expect(detail.meta).toMatchObject({ difficulty: 4, tags: ["vocabulaire"] });
    expect(detail.draft.explanation).toBe("Parce que.");

    const evaluation = await ok("create_evaluation", {
      classroomId: room.id,
      title: "Culture générale — exercice",
      mode: "exercise",
      questionIds: ids,
    });
    expect(evaluation.evaluation).toMatchObject({ mode: "exercise", state: "draft" });
    expect(evaluation.items).toHaveLength(3);
    expect(evaluation.url).toContain(`/evaluations/${evaluation.evaluation.id}`);
  });

  it("cannot add questions to an evaluation once it is opened (issue #79)", async () => {
    const course = await ok("create_course", { name: "Gelé", code: "FROZEN-MCP" });
    const room = await ok("create_classroom", { courseId: course.id, name: "Gelé 2026" });
    const pool = await ok("create_pool", { name: "Gelé" });
    await ok("link_pool_to_course", { courseId: course.id, poolId: pool.id });
    const example = (describeQuestionType("mcq") as { example: unknown }).example;
    const first = await ok("create_question", { poolId: pool.id, type: "mcq", internalName: "frozen-1", config: example });
    const second = await ok("create_question", { poolId: pool.id, type: "mcq", internalName: "frozen-2", config: example });
    const created = await ok("create_evaluation", {
      classroomId: room.id,
      title: "Déjà lancée",
      questionIds: [first.questionId],
    });
    await server.app.db
      .update(evaluations)
      .set({ state: "running" })
      .where(eq(evaluations.id, created.evaluation.id));

    const { isError, data } = await call("add_questions_to_evaluation", {
      evaluationId: created.evaluation.id,
      questionIds: [second.questionId],
    });
    expect(isError).toBe(true);
    expect(data).toMatchObject({ status: 409, body: { error: "items_frozen" } });
    expect((await ok("get_evaluation", { evaluationId: created.evaluation.id })).items).toHaveLength(1);
  });

  it("refuses an invalid config with its issues, and creates nothing", async () => {
    const pool = await ok("create_pool", { name: "Brouillons" });
    const { isError, data } = await call("create_question", {
      poolId: pool.id,
      type: "mcq",
      internalName: "broken",
      config: { configVersion: 2, prompt: "?", choices: [{ text: "seul", correct: false }] },
    });
    expect(isError).toBe(true);
    expect(data.details.length).toBeGreaterThan(0);
    expect((await ok("list_questions", { poolId: pool.id })).total).toBe(0);
  });

  it("refuses a question from a pool the course does not use", async () => {
    const course = await ok("create_course", { name: "Autre", code: "OTHER-MCP" });
    const room = await ok("create_classroom", { courseId: course.id, name: "Autre 2026" });
    const pool = await ok("create_pool", { name: "Non lié" });
    const q = await ok("create_question", {
      poolId: pool.id,
      type: "mcq",
      internalName: "unlinked",
      config: (describeQuestionType("mcq") as { example: unknown }).example,
    });
    const { isError } = await call("create_evaluation", {
      classroomId: room.id,
      title: "Refusée",
      questionIds: [q.questionId],
    });
    expect(isError).toBe(true);
  });

  it("reaches nothing of another teacher's: a 404 through the tool", async () => {
    const pool = await ok("create_pool", { name: "Privé" });
    const other = await server.signIn("teacher");
    const token = await tokenFor(other.headers);
    const { isError, data } = await call("get_pool", { poolId: pool.id }, token);
    expect(isError).toBe(true);
    expect(data.status).toBe(404);
  });

  it("launches an inline opinion poll and returns its join code", async () => {
    const course = await ok("create_course", { name: "Sondages", code: "POLL-MCP" });
    const room = await ok("create_classroom", { courseId: course.id, name: "Sondages 2026" });
    const poll = await ok("create_poll", {
      classroomId: room.id,
      type: "mcq",
      config: {
        configVersion: 2,
        prompt: "Quel auteur lire ensuite ?",
        choices: [{ text: "Camus" }, { text: "Duras" }],
      },
    });
    expect(poll.code).toMatch(/^[A-Z0-9]+$/);
  });

  it("returns the argument issues when the model sends a malformed call", async () => {
    const { isError, data } = await call("create_course", { name: "" });
    expect(isError).toBe(true);
    expect(data.error).toBe("invalid_arguments");
  });
});
