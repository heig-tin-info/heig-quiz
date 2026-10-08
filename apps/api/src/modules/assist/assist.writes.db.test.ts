/**
 * The assistant's writes and editor proposals (ADR-080, P3 amendment), on a
 * real application over PGlite. A write the model asks for is NOT executed:
 * it is frozen as a pending write of the teacher and the conversation, shown
 * as a card the server read back, and runs — exactly as frozen, once, within
 * ten minutes — only on its teacher's Confirm, audited as `assistant`. An
 * editor proposal writes nothing either: it comes back as an action.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AssistReply, AssistWriteDone } from "@quiz/contracts";
import { ASSIST_PENDING_TTL_MS } from "@quiz/domain";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { ASSIST_AUDIENCE } from "../../auth/tokens.js";
import { loadConfig } from "../../config.js";
import { apiTokens, auditLog, categories, questions } from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import type { ConverseReply, ConverseRequest, LlmProvider, Metered } from "../llm/provider.js";
import { LlmGateway } from "../llm/service.js";

const SECRET = "test-llm-master-key-0123456789abcdef";
const KEY = "sk-ant-api03-test-key-0123456789-WXYZ";
const CONTEXT = { route: "/pools/:id", helpTopic: "pool", locale: "fr" };

type Who = { id: string; headers: Record<string, string> };

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
/** What each tool call answered the model, and whether the turn was then ended. */
const results: { name: string; content: string; error: boolean }[] = [];
let endedAfter: boolean[] = [];
/** A model that makes the tool calls `calls`, in order, asking after each whether the turn ends, then answers. */
const calling =
  (...calls: [string, unknown][]) =>
  async (req: ConverseRequest, metered: Metered): Promise<ConverseReply> => {
    await metered(1_000, async () => ({ model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 100 }));
    for (const [name, input] of calls) {
      const tool = req.tools.find((t) => t.name === name);
      try {
        if (!tool) throw new Error(`No tool named ${name}.`);
        results.push({ name, content: await tool.run(input), error: false });
      } catch (err) {
        results.push({ name, content: (err as Error).message, error: true });
      }
      endedAfter.push(req.endAfter?.() ?? false);
    }
    return { text: "J'ai préparé ceci ; rien n'est fait tant que vous ne confirmez pas.", model: "claude-sonnet-5-5", steps: 1 };
  };

let server: TestServer;
let teacher: Who;
let colleague: Who;
let poolId: string;
let courseId: string;
let draftId: string;
let publishedId: string;

const call = (who: { headers: Record<string, string> }, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });
const ask = (who: Who, message: string, extra: Record<string, unknown> = {}) =>
  call(who, "POST", "/app/api/assist/ask", { message, context: { ...CONTEXT, entities: { pool: poolId } }, ...extra });
const confirmAs = (who: { headers: Record<string, string> }, id: string, conversationId: string) =>
  call(who, "POST", `/app/api/assist/writes/${id}/confirm`, { conversationId });
const MCQ = (prompt: string) => ({
  configVersion: 2,
  prompt,
  choices: [
    { text: "4", correct: true },
    { text: "5", correct: false },
  ],
  mode: "single",
  policy: "inherit",
  shuffleChoices: true,
});

async function question(name: string, publish: boolean): Promise<string> {
  const created = await call(teacher, "POST", `/app/api/pools/${poolId}/questions`, { type: "mcq", internalName: name });
  expect(created.statusCode).toBe(201);
  const id = (created.json() as { meta: { id: string } }).meta.id;
  expect((await call(teacher, "PUT", `/app/api/questions/${id}/draft`, { config: MCQ("2 + 2 ?"), explanation: "" })).statusCode).toBe(200);
  if (publish) expect((await call(teacher, "POST", `/app/api/questions/${id}/publish`, {})).statusCode).toBe(201);
  return id;
}

/** The single pending write of a reply. */
function pendingOf(reply: AssistReply) {
  const writes = reply.actions.filter((a) => a.kind === "pending_write");
  expect(writes).toHaveLength(1);
  return writes[0] as Extract<AssistReply["actions"][number], { kind: "pending_write" }>;
}

beforeAll(async () => {
  const env = { LLM_KEY_SECRET: SECRET, SUPER_ADMIN_EMAIL: "boss@heig.test" };
  server = await testServer(env);
  server.clock.set("2026-10-08T09:00:00.000Z");
  server.app.llmGateway = new LlmGateway({ db: server.app.db, clock: server.clock, config: loadConfig({ NODE_ENV: "test", ...env }), provider: fake });
  const boss = await server.signIn("admin", "boss@heig.test");
  expect((await call(boss, "PATCH", "/app/api/admin/llm", { apiKey: KEY })).statusCode).toBe(200);
  teacher = await server.signIn("teacher");
  colleague = await server.signIn("teacher");
  const pool = await call(teacher, "POST", "/app/api/pools", { name: "Sandbox" });
  poolId = (pool.json() as { id: string }).id;
  const course = await call(teacher, "POST", "/app/api/courses", { name: "Programmation 1", code: "PRG1" });
  expect(course.statusCode).toBe(201);
  courseId = (course.json() as { id: string }).id;
  expect((await call(teacher, "PUT", `/app/api/courses/${courseId}/pools`, { poolIds: [poolId] })).statusCode).toBe(200);
  draftId = await question("brouillon", false);
  publishedId = await question("publiee", true);
});
afterAll(() => server.close());

beforeEach(() => {
  server.clock.advance(61_000);
  seen.length = 0;
  results.length = 0;
  endedAfter = [];
});

const categoryCount = async (name: string) =>
  (await server.app.db.select().from(categories).where(and(eq(categories.poolId, poolId), eq(categories.name, name)))).length;

describe("a write the model asks for (decision 7)", () => {
  it("is frozen as a pending write — nothing written —, its card read back by the server, and the turn ends", async () => {
    script = calling(["create_category", { poolId, name: "Pointeurs" }]);
    const reply = AssistReply.parse((await ask(teacher, "Crée la catégorie Pointeurs")).json());
    const write = pendingOf(reply);
    expect(write).toMatchObject({
      tool: "create_category",
      lines: [
        { field: "pool", values: ["Sandbox"] },
        { field: "name", values: ["Pointeurs"] },
      ],
    });
    expect(Date.parse(write.expiresAt) - server.clock.now().getTime()).toBe(ASSIST_PENDING_TTL_MS);
    expect(results[0]!.content).toMatch(/^Prepared, NOT done/);
    expect(endedAfter).toEqual([true]);
    expect(await categoryCount("Pointeurs")).toBe(0);
    // The question's token is gone; the exchange stores the text, never the write.
    expect(await server.app.db.select().from(apiTokens).where(eq(apiTokens.audience, ASSIST_AUDIENCE))).toEqual([]);
  });

  it("runs on Confirm exactly as frozen, once, audited as the assistant with the teacher as actor", async () => {
    script = calling(["create_category", { poolId, name: "Tableaux" }]);
    const reply = AssistReply.parse((await ask(teacher, "Crée la catégorie Tableaux")).json());
    const write = pendingOf(reply);
    const done = await confirmAs(teacher, write.id, reply.conversationId);
    expect(done.statusCode).toBe(200);
    expect(AssistWriteDone.parse(done.json())).toEqual({ path: `/pools/${poolId}/categories` });
    expect(await categoryCount("Tableaux")).toBe(1);
    const [category] = await server.app.db.select().from(categories).where(eq(categories.name, "Tableaux"));
    const rows = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "category.create"), eq(auditLog.subjectId, category!.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "assistant", actorUserId: teacher.id });
    expect(rows[0]!.payload).toMatchObject({ assistTool: "create_category" });
    // Replayed: nothing left to run.
    expect((await confirmAs(teacher, write.id, reply.conversationId)).statusCode).toBe(404);
    expect(await categoryCount("Tableaux")).toBe(1);
    // Its single-call token is gone too.
    expect(await server.app.db.select().from(apiTokens).where(eq(apiTokens.audience, ASSIST_AUDIENCE))).toEqual([]);
  });

  it("is refused to another teacher, from another conversation, once expired, and after a cancel", async () => {
    script = calling(["create_category", { poolId, name: "Listes" }]);
    const reply = AssistReply.parse((await ask(teacher, "Crée la catégorie Listes")).json());
    const write = pendingOf(reply);
    expect((await confirmAs(colleague, write.id, reply.conversationId)).statusCode).toBe(404);
    expect((await confirmAs(teacher, write.id, randomUUID())).statusCode).toBe(404);
    expect((await confirmAs(teacher, randomUUID(), reply.conversationId)).statusCode).toBe(404);
    // Neither refusal spent it: its owner may still cancel it, and then nothing runs.
    expect((await call(teacher, "POST", `/app/api/assist/writes/${write.id}/cancel`, { conversationId: reply.conversationId })).statusCode).toBe(204);
    expect((await confirmAs(teacher, write.id, reply.conversationId)).statusCode).toBe(404);

    script = calling(["create_category", { poolId, name: "Listes" }]);
    const later = AssistReply.parse((await ask(teacher, "Crée la catégorie Listes")).json());
    server.clock.advance(ASSIST_PENDING_TTL_MS + 1_000);
    expect((await confirmAs(teacher, pendingOf(later).id, later.conversationId)).statusCode).toBe(404);
    expect(await categoryCount("Listes")).toBe(0);
  });

  it("is refused under impersonation (403), the write left for its teacher", async () => {
    script = calling(["create_category", { poolId, name: "Fichiers" }]);
    const reply = AssistReply.parse((await ask(teacher, "Crée la catégorie Fichiers")).json());
    const write = pendingOf(reply);
    const boss = await server.signIn("admin");
    const s = await createSession(server.app.db, teacher.id, 12, {
      kind: "impersonation",
      actorUserId: boss.id,
      evaluationId: null,
      projectId: null,
    });
    const acting = { headers: { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf } };
    expect((await confirmAs(acting, write.id, reply.conversationId)).statusCode).toBe(403);
    expect((await confirmAs(teacher, write.id, reply.conversationId)).statusCode).toBe(200);
  });
});

describe("the writes it may prepare (decision 4)", () => {
  it("creates a question as a DRAFT only, even when asked to publish, after a look for similar ones", async () => {
    const input = { poolId, type: "mcq", internalName: "assist-q", config: MCQ("Combien font 3 + 3 ?"), publish: true };
    script = calling(["create_question", input]);
    AssistReply.parse((await ask(teacher, "Crée une question")).json());
    expect(results[0]).toMatchObject({ error: true, content: expect.stringMatching(/find_similar_questions/) });

    script = calling(["find_similar_questions", { courseId, text: "3 + 3" }], ["create_question", input]);
    const reply = AssistReply.parse((await ask(teacher, "Crée une question")).json());
    const write = pendingOf(reply);
    expect(write.lines).toEqual([
      { field: "pool", values: ["Sandbox"] },
      { field: "type", values: ["mcq"] },
      { field: "name", values: ["assist-q"] },
      { field: "statement", values: ["Combien font 3 + 3 ?"] },
    ]);
    // The schema the model is handed has no `publish`.
    expect(Object.keys(seen[0]!.tools.find((t) => t.name === "create_question")!.inputSchema.properties)).not.toContain("publish");
    expect((await server.app.db.select().from(questions).where(eq(questions.internalName, "assist-q"))).length).toBe(0);
    const done = AssistWriteDone.parse((await confirmAs(teacher, write.id, reply.conversationId)).json());
    const id = done.path.split("/").at(-1)!;
    const detail = (await call(teacher, "GET", `/app/api/questions/${id}`)).json() as { latestPublished: unknown; meta: { internalName: string } };
    expect(detail.meta.internalName).toBe("assist-q");
    expect(detail.latestPublished).toBeNull();
  });

  it("refuses an invalid question config before anything is prepared", async () => {
    script = calling(
      ["find_similar_questions", { courseId, text: "x" }],
      ["create_question", { poolId, type: "mcq", internalName: "bad", config: { prompt: "x" } }],
    );
    const reply = AssistReply.parse((await ask(teacher, "Crée une question")).json());
    expect(reply.actions).toEqual([]);
    expect(results[1]).toMatchObject({ error: true, content: expect.stringMatching(/does not satisfy the type's schema/) });
  });

  it("puts published questions only into a template: a draft is refused with what to do", async () => {
    script = calling(["create_template", { courseId, title: "Test 1", questionIds: [draftId] }]);
    const refused = AssistReply.parse((await ask(teacher, "Crée un modèle")).json());
    expect(refused.actions).toEqual([]);
    expect(results[0]!.content).toMatch(/brouillon is a draft, never published.*publish it in its editor, then to ask again/);

    script = calling(["create_template", { courseId, title: "Test 1", questionIds: [publishedId] }]);
    const reply = AssistReply.parse((await ask(teacher, "Crée un modèle")).json());
    expect(pendingOf(reply).lines).toEqual([
      { field: "course", values: ["Programmation 1"] },
      { field: "title", values: ["Test 1"] },
      { field: "mode", values: ["exercise"] },
      { field: "questions", values: ["publiee"] },
    ]);
    const done = AssistWriteDone.parse((await confirmAs(teacher, pendingOf(reply).id, reply.conversationId)).json());
    expect(done.path).toMatch(/^\/templates\/[0-9a-f-]{36}$/);
  });

  it("names, on a link's card, the whole staff who gain access", async () => {
    const other = await call(teacher, "POST", "/app/api/pools", { name: "Autre" });
    const otherId = (other.json() as { id: string }).id;
    script = calling(["link_pool_to_course", { courseId, poolId: otherId }]);
    const reply = AssistReply.parse((await ask(teacher, "Lie la banque Autre au cours")).json());
    const lines = pendingOf(reply).lines;
    expect(lines.slice(0, 2)).toEqual([
      { field: "course", values: ["Programmation 1"] },
      { field: "pool", values: ["Autre"] },
    ]);
    expect(lines[2]).toMatchObject({ field: "access" });
    expect(lines[2]!.values).toHaveLength(1);
  });

  it("never reaches an excluded write, whatever the model names", async () => {
    const excluded = ["update_question", "update_evaluation", "add_questions_to_evaluation", "create_evaluation", "instantiate_template", "create_pool", "create_classroom", "create_poll", "create_course"];
    script = calling(...excluded.map((name): [string, unknown] => [name, {}]));
    const reply = AssistReply.parse((await ask(teacher, "Fais tout")).json());
    expect(reply.actions).toEqual([]);
    expect(results.map((r) => r.content)).toEqual(excluded.map((n) => `No tool named ${n}.`));
  });

  it("reads as the teacher's own seats: an administrator with Super Powers prepares nothing on another's pool", async () => {
    const admin = await server.signInWithSuperPowers();
    script = calling(["create_category", { poolId, name: "Admin" }]);
    const reply = AssistReply.parse(
      (await call(admin, "POST", "/app/api/assist/ask", { message: "Crée", context: { ...CONTEXT, entities: { pool: poolId } } })).json(),
    );
    expect(reply.actions).toEqual([]);
    expect(results[0]).toMatchObject({ error: true, content: expect.stringMatching(/^Not found: the user holds no seat/) });
  });
});

describe("an editor proposal (decisions 1, 2, 6)", () => {
  const editorContext = () => ({ route: "/questions/:id", helpTopic: "question-editor", locale: "fr", entities: { question: draftId } });
  const askEditor = (message: string, editor: unknown, context: unknown = editorContext()) =>
    call(teacher, "POST", "/app/api/assist/ask", { message, context, editor });

  it("is offered in the question editor only, the draft's texts in the screen part, and writes nothing", async () => {
    script = calling(["propose_question_edit", { edits: [{ path: "prompt", text: "Combien font 2 + 2 ?" }], add: ["3"] }]);
    const editor = { questionId: draftId, config: MCQ("2 + 2 ?"), explanation: "" };
    const reply = AssistReply.parse((await askEditor("Reformule et ajoute un choix", editor)).json());
    expect(seen[0]!.system.volatile).toContain('  - prompt: "2 + 2 ?"');
    expect(seen[0]!.system.volatile).toContain('  - choices.1.text: "5"');
    const [edit] = reply.actions;
    expect(edit).toMatchObject({
      kind: "edit_question",
      questionId: draftId,
      fields: [
        { path: "prompt", before: "2 + 2 ?", after: "Combien font 2 + 2 ?" },
        { path: "choices.2.text", before: null, after: "3" },
      ],
    });
    expect((edit as { config: { choices: unknown[] } }).config.choices[2]).toEqual({ text: "3", correct: false });
    const stored = (await call(teacher, "GET", `/app/api/questions/${draftId}`)).json() as { draft: { config: { prompt: string } } };
    expect(stored.draft.config.prompt).toBe("2 + 2 ?");
    // Without the editor's draft, there is no proposal tool.
    script = calling(["propose_question_edit", { edits: [] }]);
    await ask(teacher, "Reformule");
    expect(results.at(-1)).toMatchObject({ error: true, content: "No tool named propose_question_edit." });
  });

  it("refuses a setting, the key or a lost expression — the model reads why", async () => {
    script = calling(["propose_question_edit", { edits: [{ path: "choices.0.correct", text: "false" }] }]);
    const editor = { questionId: draftId, config: MCQ("2 + 2 ?"), explanation: "" };
    expect(AssistReply.parse((await askEditor("Change la clé", editor)).json()).actions).toEqual([]);
    expect(results[0]!.content).toMatch(/not a text you may rewrite/);
  });

  it("refuses a draft sent from another screen than its question's editor", async () => {
    const editor = { questionId: draftId, config: MCQ("2 + 2 ?"), explanation: "" };
    expect((await askEditor("?", editor, { ...CONTEXT, entities: { pool: poolId } })).statusCode).toBe(400);
    expect((await askEditor("?", editor, { ...editorContext(), entities: { question: publishedId } })).statusCode).toBe(400);
  });

  it("gives another teacher's question no editor at all", async () => {
    script = calling(["propose_question_edit", { edits: [{ path: "prompt", text: "x" }] }]);
    const editor = { questionId: draftId, config: MCQ("2 + 2 ?"), explanation: "" };
    const res = await call(colleague, "POST", "/app/api/assist/ask", { message: "?", context: editorContext(), editor });
    expect(res.statusCode).toBe(200);
    expect(results[0]).toMatchObject({ error: true, content: "No tool named propose_question_edit." });
  });
});
