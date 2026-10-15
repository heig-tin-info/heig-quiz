/**
 * The scope of a personal token over the REAL application (ADR-113, N-SEC-22):
 * enforced where the token is resolved, before any load; `quiz` and
 * `quiz:read` confined to the MCP endpoint and its tools' calls, `quiz:read`
 * to the reading tools; `api` the whole API. And the catalogue's own
 * declaration: a tool's scope says the same as its `readOnlyHint`.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiTokenCreated, TokenScope } from "@quiz/contracts";

import { testServer, type TestServer } from "../../test/http.js";

import { ApiError, injectedApi } from "./service.js";
import { TOOLS } from "./tools.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
const tokens = {} as Record<TokenScope, string>;
let rpcId = 0;

async function mint(scope: TokenScope) {
  const res = await server.app.inject({
    method: "POST",
    url: "/app/api/me/tokens",
    headers: teacher.headers,
    payload: { name: `scope ${scope}`, scope },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as ApiTokenCreated).token;
}

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  for (const scope of ["quiz", "quiz:read", "api"] as const) tokens[scope] = await mint(scope);
});
afterAll(() => server.close());

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function rpc(token: string, method: string, params?: unknown) {
  const res = await server.app.inject({
    method: "POST",
    url: "/app/api/mcp",
    headers: bearer(token),
    payload: { jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { result?: any; error?: { code: number; message: string } };
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const { result } = await rpc(token, "tools/call", { name, arguments: args });
  return { isError: result.isError as boolean, data: JSON.parse(result.content[0].text) };
}

describe("the catalogue declares each tool's scope", () => {
  it("quiz:read exactly for the tools annotated read-only", () => {
    for (const t of TOOLS) expect(t.annotations.readOnlyHint, t.name).toBe(t.scope === "quiz:read");
    expect(TOOLS.filter((t) => t.scope === "quiz:read")).toHaveLength(16);
  });
});

describe("enforced where the token is resolved (ADR-113 §2)", () => {
  it("keeps an MCP token off every other route with 403 insufficient_scope, before anything is loaded", async () => {
    for (const scope of ["quiz", "quiz:read"] as const) {
      for (const [method, url] of [
        ["GET", "/app/api/courses"],
        ["POST", "/app/api/pools"],
        // A staff route no tool calls: the students' grades (ADR-080 §8's promise).
        ["GET", `/app/api/classrooms/${randomUUID()}/gradebook`],
        ["DELETE", `/app/api/pools/${randomUUID()}`],
      ] as const) {
        const res = await server.app.inject({ method, url, headers: bearer(tokens[scope]), payload: { name: "x" } });
        expect(res.statusCode, `${scope} ${method} ${url}`).toBe(403);
        expect(res.json()).toMatchObject({ error: "insufficient_scope" });
        expect(res.headers["www-authenticate"]).toBe('Bearer error="insufficient_scope", scope="api"');
      }
    }
  });

  it("lets a full API token reach the routes with its owner's rights, as before", async () => {
    const list = await server.app.inject({ method: "GET", url: "/app/api/courses", headers: bearer(tokens.api) });
    expect(list.statusCode).toBe(200);
    const missing = await server.app.inject({
      method: "GET",
      url: `/app/api/classrooms/${randomUUID()}/gradebook`,
      headers: bearer(tokens.api),
    });
    expect(missing.statusCode).toBe(404);
    // …and the MCP endpoint, every tool listed.
    expect((await rpc(tokens.api, "tools/list")).result.tools).toHaveLength(TOOLS.length);
  });

  it("refuses a quiz:read token's write on a tool's own call, and lets a quiz token's through", async () => {
    const read = injectedApi(server.app, `Bearer ${tokens["quiz:read"]}`, "http://web.test");
    const error = await read.post("/pools", { name: "Not by a reader" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).body).toMatchObject({ error: "insufficient_scope" });
    expect(await read.get("/courses")).toEqual(expect.any(Array));

    const write = injectedApi(server.app, `Bearer ${tokens.quiz}`, "http://web.test");
    expect(await write.post("/pools", { name: "By an MCP token" })).toMatchObject({ name: "By an MCP token" });
  });
});

describe("a quiz:read token over MCP (ADR-113 §4)", () => {
  it("lists the reading tools only", async () => {
    const { result } = await rpc(tokens["quiz:read"], "tools/list");
    const names = result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(TOOLS.filter((t) => t.scope === "quiz:read").map((t) => t.name).sort());
    expect((await rpc(tokens.quiz, "tools/list")).result.tools).toHaveLength(TOOLS.length);
  });

  it("is told early that a writing tool is out of its scope, and nothing is created", async () => {
    const { isError, data } = await call(tokens["quiz:read"], "create_course", { name: "Nope", code: "NOPE-1" });
    expect(isError).toBe(true);
    expect(data).toMatchObject({ error: "insufficient_scope", needed: "quiz" });
    const { data: courses } = await call(tokens["quiz:read"], "list_courses");
    expect(courses.map((c: { code: string }) => c.code)).not.toContain("NOPE-1");
  });

  it("runs every reading tool without one scope refusal: they only GET", async () => {
    const { data: course } = await call(tokens.quiz, "create_course", { name: "Scopes", code: "SCOPE-1" });
    const { data: room } = await call(tokens.quiz, "create_classroom", { courseId: course.id, name: "Scopes 2026" });
    const { data: pool } = await call(tokens.quiz, "create_pool", { name: "Scopes pool" });
    const args: Record<string, Record<string, unknown>> = {
      list_courses: {},
      get_course: { courseId: course.id },
      list_pools: {},
      get_pool: { poolId: pool.id },
      get_pool_question_stats: { poolId: pool.id },
      list_questions: { poolId: pool.id, concepts: ["pointers"], courseId: course.id },
      find_similar_questions: { courseId: course.id, text: "What is a pointer in C?" },
      get_question: { questionId: randomUUID() },
      describe_question_types: { type: "mcq" },
      list_evaluations: { classroomId: room.id },
      get_evaluation: { evaluationId: randomUUID() },
      get_journal: { classroomId: room.id },
      get_journal_page: { classroomId: room.id, path: "010-intro/README.md" },
      list_templates: { courseId: course.id },
      list_projects: { classroomId: room.id },
      list_project_sources: { classroomId: room.id },
    };
    const reading = TOOLS.filter((t) => t.scope === "quiz:read").map((t) => t.name);
    expect(Object.keys(args).sort()).toEqual([...reading].sort());
    for (const name of reading) {
      const { data } = await call(tokens["quiz:read"], name, args[name]);
      // A 404 or a refusal of the tool itself is fine here (a missing question,
      // no GitHub App in this server); a scope refusal is not.
      expect(JSON.stringify(data), name).not.toContain("insufficient_scope");
    }
  });
});
