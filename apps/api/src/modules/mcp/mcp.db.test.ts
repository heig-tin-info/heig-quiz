/**
 * The MCP endpoint over the REAL application (ADR-022): the handshake, the
 * catalogue, and one whole authoring session the way a model runs it —
 * course, classroom, pool, three questions of three types, an exercise —
 * through the ordinary routes, with the real question types.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiTokenCreated } from "@quiz/contracts";
import { questionType } from "@quiz/registry/server";

import { conceptTagSortings, evaluations } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { EXPLANATION, PARAMETERIZED, VARIABLES } from "../../test/parameterized.js";

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
    expect(result.instructions).toContain("create_template");

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
    // The closed list of ADR-022 §C: a tool is added there before it is added here.
    expect([...names].sort()).toEqual(
      [
        "list_courses",
        "get_course",
        "list_pools",
        "get_pool",
        "get_pool_question_stats",
        "find_similar_questions",
        "list_questions",
        "get_question",
        "describe_question_types",
        "list_evaluations",
        "get_evaluation",
        "create_course",
        "create_classroom",
        "create_pool",
        "link_pool_to_course",
        "create_category",
        "create_question",
        "update_question",
        "create_evaluation",
        "add_questions_to_evaluation",
        "update_evaluation",
        "create_poll",
        "list_templates",
        "create_template",
        "add_questions_to_template",
        "instantiate_template",
      ].sort(),
    );
    // …and its reading half, the one set annotated read-only.
    const readOnly = result.tools.filter((t: any) => t.annotations.readOnlyHint).map((t: any) => t.name);
    expect(readOnly.sort()).toEqual(
      [
        "list_courses",
        "get_course",
        "list_pools",
        "get_pool",
        "get_pool_question_stats",
        "find_similar_questions",
        "list_questions",
        "get_question",
        "list_evaluations",
        "get_evaluation",
        "describe_question_types",
        "list_templates",
      ].sort(),
    );
    for (const t of result.tools) expect(t.inputSchema.type, t.name).toBe("object");
    // Nothing destructive is exposed.
    expect(names.some((n: string) => /delete|remove|close|release/.test(n))).toBe(false);
  });
});

describe("the question-type guide", () => {
  it.each(["mcq", "short", "cloze", "categorize", "diagram"])("gives a %s example the publication gate accepts", (type) => {
    const guide = describeQuestionType(type) as { example: unknown; configSchema: { type: string } };
    expect(guide.configSchema.type).toBe("object");
    expect(checkConfig(type, guide.example)).toBeNull();
  });

  it("gives a diagram example that passes the publication checks too (a reference, one kind)", () => {
    const type = questionType("diagram");
    const config = type.configSchema.parse((describeQuestionType("diagram") as { example: unknown }).example);
    expect(type.publicationIssues?.(config)).toEqual([]);
  });
});

describe("an authoring session", () => {
  it("builds a course, a classroom, a pool, three questions and an exercise", async () => {
    const course = await ok("create_course", { name: "Français", code: "FRA-MCP" });
    const room = await ok("create_classroom", {
      courseId: course.id,
      name: "Français 2026",
      period: "Automne 2026",
      periodStart: "2026-09",
      periodEnd: "2027-01",
    });
    expect(room.url).toContain(`/classrooms/${room.id}`);
    expect([room.periodStart, room.periodEnd]).toEqual(["2026-09", "2027-01"]);
    // Half a period is refused at the tool's own input, with the field named.
    const half = await call("create_classroom", {
      courseId: course.id,
      name: "Moitié",
      periodStart: "2026-09",
    });
    expect(half.isError).toBe(true);
    expect(half.data).toMatchObject({
      error: "invalid_arguments",
      issues: [{ path: "periodEnd" }],
    });
    const pool = await ok("create_pool", { name: "Culture générale" });
    await ok("link_pool_to_course", { courseId: course.id, poolId: pool.id });
    // Idempotent: a second link keeps one entry.
    const linked = await ok("link_pool_to_course", { courseId: course.id, poolId: pool.id });
    expect(linked.map((p: { id: string }) => p.id)).toEqual([pool.id]);

    // A concept the vocabulary lacks is refused before anything is created, unless asked for (ADR-081).
    const unknown = await call("create_question", {
      poolId: pool.id,
      type: "mcq",
      internalName: "fr-unknown-concept",
      config: describeQuestionType("mcq").example,
      concepts: ["figures de style"],
    });
    expect(unknown.isError).toBe(true);
    expect((await ok("list_questions", { poolId: pool.id })).total).toBe(0);
    // A label the admin dropped is refused before anything is created, even with creation asked.
    await server.app.db
      .insert(conceptTagSortings)
      .values({ poolId: pool.id, tag: "vocabulaire", decision: "drop", dropReason: "task_kind", decidedAt: new Date() });
    const dropped = await call("create_question", {
      poolId: pool.id,
      type: "mcq",
      internalName: "fr-dropped-concept",
      config: describeQuestionType("mcq").example,
      concepts: ["Vocabulaire"],
      createMissing: true,
    });
    expect(dropped.isError).toBe(true);
    expect(JSON.stringify(dropped.data)).toContain("task_kind");
    expect((await ok("list_questions", { poolId: pool.id })).total).toBe(0);
    // A client still holding the tool of before the cut-over: its `tags` are refused, never ignored.
    const stale = await call("create_question", {
      poolId: pool.id,
      type: "mcq",
      internalName: "fr-stale-tags",
      config: describeQuestionType("mcq").example,
      tags: ["vocabulaire"],
    });
    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ error: "invalid_arguments" });
    expect(JSON.stringify(stale.data)).toContain("tags");
    expect((await ok("list_questions", { poolId: pool.id })).total).toBe(0);

    const ids: string[] = [];
    for (const type of ["mcq", "short", "cloze"] as const) {
      const guide = describeQuestionType(type);
      const q = await ok("create_question", {
        poolId: pool.id,
        type,
        internalName: `fr-${type}`,
        config: guide.example,
        explanation: "Parce que.",
        difficulty: 4,
        // The first creates the concept; the others find it, whatever the case.
        concepts: [type === "mcq" ? "figures de style" : "Figures de style"],
        createMissing: type === "mcq",
      });
      expect(q).toMatchObject({ valid: true, publishedVersion: 1 });
      ids.push(q.questionId);
    }

    const listed = await ok("list_questions", { poolId: pool.id, type: ["mcq", "cloze"] });
    expect(listed.total).toBe(2);
    expect((await ok("list_questions", { poolId: pool.id, concepts: ["figures de style"] })).total).toBe(3);
    expect((await call("list_questions", { poolId: pool.id, concepts: ["nothing like it"] })).isError).toBe(true);
    const detail = await ok("get_question", { questionId: ids[0] });
    expect(detail.meta).toMatchObject({
      difficulty: 4,
      concepts: [expect.objectContaining({ label: "figures de style", status: "proposed" })],
    });
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

  it("refuses to link a colleague's public pool the teacher only reads (ADR-013)", async () => {
    const colleague = await server.signIn("teacher");
    const open = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: colleague.headers,
      payload: { name: "Publique", visibility: "public" },
    });
    const course = await ok("create_course", { name: "Emprunt", code: "BORROW-MCP" });
    const { isError, data } = await call("link_pool_to_course", {
      courseId: course.id,
      poolId: open.json().id,
    });
    expect(isError).toBe(true);
    expect(data).toMatchObject({ status: 403, body: { error: "pool_link_forbidden" } });
    expect((await ok("get_course", { courseId: course.id })).pools).toEqual([]);
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

  it("writes a parameterized question end to end, and drops its variables on update (ADR-056)", async () => {
    const pool = await ok("create_pool", { name: "Paramétrées" });
    const q = await ok("create_question", {
      poolId: pool.id,
      type: "short",
      internalName: "chute-libre",
      config: PARAMETERIZED.short as Record<string, unknown>,
      explanation: EXPLANATION,
      variables: VARIABLES,
    });
    expect(q.publishedVersion).toBe(1);
    const detail = await ok("get_question", { questionId: q.questionId });
    expect(JSON.stringify(detail)).toContain("[[t]]");
    const listed = await ok("list_questions", { poolId: pool.id });
    expect(JSON.stringify(listed)).toContain('"randomizable":true');
    // A tolerance below half the step of `t` (.2): refused before anything is published.
    const tight = await call("update_question", {
      questionId: q.questionId,
      config: { ...(PARAMETERIZED.short as object), matchers: [{ kind: "number", value: "[[t]]", tolerance: 0.001 }] },
    });
    expect(tight.isError).toBe(true);
    expect(JSON.stringify(tight.data)).toContain("short.tolerance_below_format");
    // null makes it static again: a static key is a number.
    const plain = await ok("update_question", {
      questionId: q.questionId,
      config: { configVersion: 3, prompt: "2 + 2 ?", kind: "number", matchers: [{ kind: "number", value: 4 }] },
      variables: null,
    });
    expect(plain.publishedVersion).toBe(2);
    expect(JSON.stringify(await ok("list_questions", { poolId: pool.id }))).toContain('"randomizable":false');
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

  it("reads a pool's question statistics through the pool screen's route, and nothing of another teacher's", async () => {
    const pool = await ok("create_pool", { name: "Statistiques" });
    await ok("create_question", {
      poolId: pool.id,
      type: "mcq",
      internalName: "stats-mcq",
      config: (describeQuestionType("mcq") as { example: unknown }).example,
    });
    // Never answered: under the threshold, so absent — the route's rule, not the tool's.
    expect(await ok("get_pool_question_stats", { poolId: pool.id })).toEqual({ items: [] });

    const other = await server.signIn("teacher");
    const { isError, data } = await call("get_pool_question_stats", { poolId: pool.id }, await tokenFor(other.headers));
    expect(isError).toBe(true);
    expect(data.status).toBe(404);
  });

  it("finds an existing question before one is written, through the course's route", async () => {
    const course = await ok("create_course", { name: "Réemploi", code: "REUSE-MCP" });
    const pool = await ok("create_pool", { name: "Réemploi" });
    await ok("link_pool_to_course", { courseId: course.id, poolId: pool.id });
    const example = (describeQuestionType("mcq") as unknown as { example: { prompt: string } }).example;
    const q = await ok("create_question", { poolId: pool.id, type: "mcq", internalName: "reuse-mcq", config: example });

    const found = await ok("find_similar_questions", { courseId: course.id, text: example.prompt });
    expect(found.items[0]).toMatchObject({
      questionId: q.questionId,
      pool: { id: pool.id },
      linked: true,
      canLink: true,
      // Never answered in an exam: withheld, not zero.
      stats: null,
    });
    expect(await ok("find_similar_questions", { courseId: course.id, text: example.prompt, type: "code" })).toEqual({
      items: [],
    });

    // Another teacher: the course is out of reach, the 404 of a missing one.
    const other = await server.signIn("teacher");
    const { isError, data } = await call(
      "find_similar_questions",
      { courseId: course.id, text: example.prompt },
      await tokenFor(other.headers),
    );
    expect(isError).toBe(true);
    expect(data.status).toBe(404);
  });

  it("tells the model to look before writing a question", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(result.instructions).toContain("find_similar_questions");
    const create = TOOLS.find((t) => t.name === "create_question")!;
    expect(create.description).toContain("find_similar_questions");
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

    // Without a classroom: an anonymous poll, open to anyone with the code.
    const open = await ok("create_poll", {
      type: "short",
      config: { configVersion: 2, prompt: "Un mot ?" },
    });
    expect(open.code).toMatch(/^[A-Z0-9]+$/);
    expect(open.code).not.toBe(poll.code);
  });

  it("returns the argument issues when the model sends a malformed call", async () => {
    const { isError, data } = await call("create_course", { name: "" });
    expect(isError).toBe(true);
    expect(data.error).toBe("invalid_arguments");
  });
});

describe("templates first (ADR-022, addendum of 2026-10-01)", () => {
  /** A course with a classroom, a linked pool and two published questions. */
  async function courseWithQuestions(code: string) {
    const course = await ok("create_course", { name: code, code });
    const room = await ok("create_classroom", { courseId: course.id, name: `${code} 2026` });
    const pool = await ok("create_pool", { name: code });
    await ok("link_pool_to_course", { courseId: course.id, poolId: pool.id });
    const example = (describeQuestionType("mcq") as { example: unknown }).example;
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const q = await ok("create_question", { poolId: pool.id, type: "mcq", internalName: `${code}-${n}`, config: example });
      ids.push(q.questionId);
    }
    return { course, room, pool, ids };
  }

  it("adds questions to a template, and refuses an unpublished one", async () => {
    const { course, pool, ids } = await courseWithQuestions("TPL-ADD");
    const made = await ok("create_template", { courseId: course.id, title: "À compléter", questionIds: [ids[0]] });
    const draft = await ok("create_question", {
      poolId: pool.id,
      type: "mcq",
      internalName: "TPL-ADD-draft",
      config: (describeQuestionType("mcq") as { example: unknown }).example,
      publish: false,
    });

    const refused = await call("add_questions_to_template", { templateId: made.template.id, questionIds: [draft.questionId] });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ status: 422, body: { error: "no_published_version" } });

    const added = await ok("add_questions_to_template", { templateId: made.template.id, questionIds: [ids[1]] });
    expect(added.template).toMatchObject({ id: made.template.id, itemCount: 2 });
    expect(added.template.revision).toBeGreaterThan(made.template.revision);
    expect(added.url).toContain(`/templates/${made.template.id}`);
  });

  it("creates a template of the course, lists it and instantiates it into a classroom", async () => {
    const { course, room, ids } = await courseWithQuestions("TPL-MCP");
    expect(await ok("list_templates", { courseId: course.id })).toEqual([]);

    const made = await ok("create_template", {
      courseId: course.id,
      title: "Examen type",
      mode: "exam",
      questionIds: ids,
    });
    expect(made.template).toMatchObject({ courseId: course.id, mode: "exam", revision: 2, itemCount: 2 });
    expect(made.items).toHaveLength(2);
    expect(made.url).toContain(`/templates/${made.template.id}`);

    const listed = await ok("list_templates", { courseId: course.id });
    expect(listed).toEqual([expect.objectContaining({ id: made.template.id, title: "Examen type", itemCount: 2 })]);
    expect(listed[0].url).toContain(`/templates/${made.template.id}`);

    const instance = await ok("instantiate_template", { templateId: made.template.id, classroomId: room.id });
    expect(instance.evaluation).toMatchObject({ title: "Examen type", mode: "exam", state: "draft" });
    expect(instance.deprecatedItems).toEqual([]);
    expect(instance.url).toContain(`/evaluations/${instance.evaluation.id}`);
    expect((await ok("get_evaluation", { evaluationId: instance.evaluation.id })).items).toHaveLength(2);
  });

  it("refuses an instantiation once the course no longer links the pool (422), and a stranger (404)", async () => {
    const { course, room, ids } = await courseWithQuestions("TPL-UNLINK");
    const made = await ok("create_template", { courseId: course.id, title: "Exercice type", questionIds: ids });
    const unlink = await server.app.inject({
      method: "PUT",
      url: `/app/api/courses/${course.id}/pools`,
      headers: teacher.headers,
      payload: { poolIds: [] },
    });
    expect(unlink.statusCode).toBe(200);

    const refused = await call("instantiate_template", { templateId: made.template.id, classroomId: room.id });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ status: 422, body: { error: "template_pool_unlinked" } });

    // A classroom of another course, even the teacher's own, is the 404 of one the template does not reach.
    const elsewhere = await courseWithQuestions("TPL-ELSEWHERE");
    const foreign = await call("instantiate_template", { templateId: made.template.id, classroomId: elsewhere.room.id });
    expect(foreign.isError).toBe(true);
    expect(foreign.data.status).toBe(404);

    // No seat on the course's staff: the course is the 404 of a missing one.
    const other = await server.signIn("teacher");
    const stranger = await call("create_template", { courseId: course.id, title: "Intrus" }, await tokenFor(other.headers));
    expect(stranger.isError).toBe(true);
    expect(stranger.data.status).toBe(404);
  });
});
