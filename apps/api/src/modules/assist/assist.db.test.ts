/**
 * The teacher assistant (ADR-080) on a real application over PGlite: who may
 * ask, whose conversation is whose, the administrators' audited read, the
 * development stub, the model path through the gateway (each request
 * logged under `assist`, the chat's share refused before the cap), and the
 * 30-day purge. The model is a fake provider; the real loop's bound is
 * `llm/anthropic.converse.test.ts`'s.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AssistAvailability, AssistConversation, AssistConversationSummary, AssistReply } from "@quiz/contracts";
import { ASSIST_MAX_STEPS, ASSIST_TURNS_PER_MINUTE } from "@quiz/domain";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import { loadConfig } from "../../config.js";
import { assistConversations, assistExchanges, auditLog, llmCalls } from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import type { ConverseReply, ConverseRequest, LlmProvider, Metered } from "../llm/provider.js";
import { LlmError, LlmGateway } from "../llm/service.js";
import { purgeAssist } from "./service.js";
import { ASSIST_DATA_TOOLS } from "./tools.js";

const SECRET = "test-llm-master-key-0123456789abcdef";
const KEY = "sk-ant-api03-test-key-0123456789-WXYZ";
const CONTEXT = { route: "/pools/:id", helpTopic: "pool", locale: "fr" };

type Actor = Awaited<ReturnType<TestServer["signIn"]>>;

/** What the fake model does for the next question, and every request it was handed. */
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
/** A model that makes `n` metered requests, then answers. */
const steps =
  (n: number, text = "Clique sur **Partager**.") =>
  async (_req: ConverseRequest, metered: Metered): Promise<ConverseReply> => {
    for (let i = 0; i < n; i++) {
      await metered(1_000, async () => ({ model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 100 }));
    }
    return { text, model: "claude-sonnet-5-5", steps: n };
  };

let server: TestServer;
let teacher: Actor;
let colleague: Actor;
let admin: Actor;

const call = (who: { headers: Record<string, string> }, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });
const askAs = (who: { headers: Record<string, string> }, message: string, conversationId?: string) =>
  call(who, "POST", "/app/api/assist/ask", { message, context: CONTEXT, ...(conversationId ? { conversationId } : {}) });

/** A session of another kind for `userId`, with the cookies that carry it. */
async function sessionOf(userId: string, auth: Parameters<typeof createSession>[3]) {
  const s = await createSession(server.app.db, userId, 12, auth);
  return { headers: { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf } };
}

/** A server, its gateway on the fake model, and its people; `stub`: `LLM_PROVIDER=stub`, which answers first. */
async function setup(stub: boolean) {
  const env = { LLM_KEY_SECRET: SECRET, SUPER_ADMIN_EMAIL: "boss@heig.test", ...(stub ? { LLM_PROVIDER: "stub" } : {}) };
  server = await testServer(env);
  server.app.llmGateway = new LlmGateway({
    db: server.app.db,
    clock: server.clock,
    config: loadConfig({ NODE_ENV: "test", ...env }),
    provider: fake,
  });
  teacher = await server.signIn("teacher");
  colleague = await server.signIn("teacher");
  admin = await server.signIn("admin", "boss@heig.test");
}

beforeAll(() => setup(true));

afterAll(() => server.close());

beforeEach(() => {
  // Past the per-minute budget of the previous test, still the same day.
  server.clock.advance(61_000);
  seen.length = 0;
  script = steps(1);
});

describe("who may ask (ADR-080 §3)", () => {
  it("is a teacher's or an administrator's portal session", async () => {
    expect((await call(teacher, "GET", "/app/api/assist/availability")).statusCode).toBe(200);
    expect((await call(admin, "GET", "/app/api/assist/availability")).statusCode).toBe(200);
    expect((await call({ headers: {} }, "GET", "/app/api/assist/availability")).statusCode).toBe(401);
  });

  it("refuses a student, a personal API token and a session acting as somebody", async () => {
    const student = await server.signIn("student");
    expect((await askAs(student, "Comment partager ?")).statusCode).toBe(403);
    const { token } = await createApiToken(server.app.db, teacher.id, { name: "mcp", expiresInDays: null });
    const bearer = { headers: { authorization: `Bearer ${token}` } };
    expect((await call(bearer, "GET", "/app/api/assist/availability")).statusCode).toBe(403);
    expect((await askAs(bearer, "Comment partager ?")).statusCode).toBe(403);
    // ADR-034: an administrator acting as somebody — even a teacher's account in development.
    const acting = await sessionOf(teacher.id, {
      kind: "impersonation",
      actorUserId: admin.id,
      evaluationId: null,
      projectId: null,
    });
    expect((await call(acting, "GET", "/app/api/assist/availability")).statusCode).toBe(403);
  });

  it("is not there for a seb or a kiosk session (ADR-027, ADR-051)", async () => {
    for (const kind of ["seb", "kiosk"] as const) {
      const confined = await sessionOf(teacher.id, { kind, actorUserId: null, evaluationId: null, projectId: null });
      expect((await call(confined, "GET", "/app/api/assist/availability")).statusCode).toBe(401);
      expect((await askAs(confined, "Comment partager ?")).statusCode).toBe(401);
    }
  });

  it("validates the context: a route with an id is refused", async () => {
    const res = await call(teacher, "POST", "/app/api/assist/ask", {
      message: "Comment partager ?",
      context: { ...CONTEXT, route: `/pools/${randomUUID()}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("the development stub", () => {
  it("answers without a model, and the conversation is stored with its screen", async () => {
    expect(AssistAvailability.parse((await call(teacher, "GET", "/app/api/assist/availability")).json())).toEqual({
      available: true,
      stub: true,
    });
    const reply = AssistReply.parse((await askAs(teacher, "Comment partager une banque ?")).json());
    expect(reply.exchange.answer).toContain("Réponse de développement");
    expect(reply.exchange.question).toBe("Comment partager une banque ?");
    const [stored] = await server.app.db
      .select()
      .from(assistExchanges)
      .where(eq(assistExchanges.conversationId, reply.conversationId));
    expect(stored).toMatchObject({ context: CONTEXT, model: "development-stub" });
    // The stub calls no model: nothing is billed.
    expect(await server.app.db.select().from(llmCalls)).toHaveLength(0);

    server.clock.advance(1_000);
    const next = AssistReply.parse((await askAs(teacher, "Et la supprimer ?", reply.conversationId)).json());
    expect(next.conversationId).toBe(reply.conversationId);
    const detail = AssistConversation.parse(
      (await call(teacher, "GET", `/app/api/assist/conversations/${reply.conversationId}`)).json(),
    );
    expect(detail.exchanges.map((e) => e.question)).toEqual(["Comment partager une banque ?", "Et la supprimer ?"]);
  });

  it("limits the questions per minute", async () => {
    const hurried = await server.signIn("teacher");
    for (let i = 0; i < ASSIST_TURNS_PER_MINUTE; i++) expect((await askAs(hurried, `Question ${i}`)).statusCode).toBe(200);
    expect((await askAs(hurried, "Une de trop")).statusCode).toBe(429);
  });
});

describe("a conversation is its owner's (ADR-080 §6)", () => {
  it("is a 404 for another teacher, to read, to continue and to delete", async () => {
    const { conversationId } = AssistReply.parse((await askAs(teacher, "Où sont les tags ?")).json());
    const other = await call(colleague, "GET", `/app/api/assist/conversations/${conversationId}`);
    expect(other.statusCode).toBe(404);
    // One code for a conversation that is not the caller's, on every route.
    expect(other.json()).toEqual({ error: "conversation_not_found" });
    const cont = await askAs(colleague, "Et ensuite ?", conversationId);
    expect(cont.statusCode).toBe(404);
    expect(cont.json()).toEqual({ error: "conversation_not_found" });
    const removed = await call(colleague, "DELETE", `/app/api/assist/conversations/${conversationId}`);
    expect([removed.statusCode, removed.json()]).toEqual([404, { error: "conversation_not_found" }]);
    expect((await call(colleague, "GET", `/app/api/assist/conversations?userId=${teacher.id}`)).statusCode).toBe(404);
    const mine = (await call(colleague, "GET", "/app/api/assist/conversations")).json() as unknown[];
    expect(mine.map((c) => AssistConversationSummary.parse(c).id)).not.toContain(conversationId);
  });

  it("is read by an administrator with Super Powers, and the read is audited; their own reads are not", async () => {
    const { conversationId } = AssistReply.parse((await askAs(teacher, "Où sont les versions ?")).json());
    // The role alone reaches nothing of anybody's (ADR-054).
    expect((await call(admin, "GET", `/app/api/assist/conversations/${conversationId}`)).statusCode).toBe(404);
    expect((await call(admin, "GET", `/app/api/assist/conversations?userId=${teacher.id}`)).statusCode).toBe(404);
    admin = await server.signInWithSuperPowers();
    const read = await call(admin, "GET", `/app/api/assist/conversations/${conversationId}`);
    expect(read.statusCode).toBe(200);
    const list = await call(admin, "GET", `/app/api/assist/conversations?userId=${teacher.id}`);
    expect((list.json() as { id: string }[]).map((c) => c.id)).toContain(conversationId);
    const rows = await server.app.db.select().from(auditLog).where(eq(auditLog.action, "assist.read"));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorUserId: admin.id, subjectType: "assist_conversation", subjectId: conversationId, payload: { owner: teacher.id } }),
        expect.objectContaining({ actorUserId: admin.id, subjectType: "user", subjectId: teacher.id }),
      ]),
    );
    const before = rows.length;
    await call(admin, "GET", "/app/api/assist/conversations");
    expect(await server.app.db.select().from(auditLog).where(eq(auditLog.action, "assist.read"))).toHaveLength(before);
    // Read, never deleted, by an administrator.
    expect((await call(admin, "DELETE", `/app/api/assist/conversations/${conversationId}`)).statusCode).toBe(404);
  });

  it("is deleted by its owner", async () => {
    const { conversationId } = AssistReply.parse((await askAs(teacher, "Comment publier ?")).json());
    expect((await call(teacher, "DELETE", `/app/api/assist/conversations/${conversationId}`)).statusCode).toBe(204);
    expect((await call(teacher, "GET", `/app/api/assist/conversations/${conversationId}`)).statusCode).toBe(404);
    expect(await server.app.db.select().from(assistExchanges).where(eq(assistExchanges.conversationId, conversationId))).toHaveLength(0);
  });
});

describe("the model, through the gateway", () => {
  beforeAll(async () => {
    // Without the stub, which would answer first, as for the grading.
    await server.close();
    await setup(false);
    const res = await call(admin, "PATCH", "/app/api/admin/llm", { apiKey: KEY });
    expect(res.statusCode).toBe(200);
  });
  beforeEach(async () => {
    await server.app.db.delete(llmCalls);
  });

  it("is used once a key is stored: the screen, the question and the tool, never a name", async () => {
    expect(AssistAvailability.parse((await call(teacher, "GET", "/app/api/assist/availability")).json()).stub).toBe(false);
    const res = await askAs(teacher, "À quoi sert l'option Grouper ?");
    expect(res.statusCode).toBe(200);
    expect(AssistReply.parse(res.json()).exchange.answer).toBe("Clique sur **Partager**.");
    const req = seen[0]!;
    expect(req.system.volatile).toContain("Route: /pools/:id");
    expect(req.system.volatile).toContain("help/pool");
    expect(req.history.at(-1)).toEqual({ role: "user", text: "À quoi sert l'option Grouper ?" });
    expect(req.tools.map((t) => t.name)).toEqual(["read_guide", ...ASSIST_DATA_TOOLS]);
    expect(req.maxSteps).toBe(ASSIST_MAX_STEPS);
    expect(JSON.stringify(req)).not.toContain(teacher.id);
    expect(JSON.stringify(req)).not.toContain("@heig.test");
    // The tool reads the corpus, and only that.
    expect(req.tools[0]!.run({ page: "guide/pools" })).toContain("# Question pools");
    expect(() => req.tools[0]!.run({})).toThrow();
  });

  it("logs each request of a question under `assist`, never its content", async () => {
    script = steps(3);
    expect((await askAs(teacher, "Comment partager ?")).statusCode).toBe(200);
    const calls = await server.app.db.select().from(llmCalls);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.purpose === "assist" && c.userId === teacher.id && c.status === "ok")).toBe(true);
  });

  it("replays the conversation as text, opening on a question", async () => {
    const first = AssistReply.parse((await askAs(teacher, "Première ?")).json());
    await askAs(teacher, "Deuxième ?", first.conversationId);
    expect(seen.at(-1)!.history.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
  });

  it("refuses the chat once the day nears the cap, before the cap itself, and the check stays green", async () => {
    // Grading spent 15.5 of the 20 USD: the last quarter is not the chat's.
    await server.app.db.insert(llmCalls).values({
      id: randomUUID(),
      createdAt: server.clock.now(),
      userId: null,
      purpose: "grade",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      status: "ok",
      costUsd: 15.5,
    });
    const res = await askAs(teacher, "Comment partager ?");
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "llm_budget_exhausted" });
    expect(seen).toHaveLength(1); // the provider was handed the question …
    const refused = await server.app.db.select().from(llmCalls).where(eq(llmCalls.error, "budget_exhausted"));
    expect(refused).toHaveLength(0); // … and nothing reached the model, nor turned `llm.budget` red.
  });

  it("refuses the chat once it spent its own share", async () => {
    await server.app.db.insert(llmCalls).values({
      id: randomUUID(),
      createdAt: server.clock.now(),
      userId: colleague.id,
      purpose: "assist",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      status: "ok",
      costUsd: 5,
    });
    expect((await askAs(teacher, "Comment partager ?")).statusCode).toBe(429);
  });

  it("stores nothing when the model fails", async () => {
    script = () => Promise.reject(new LlmError("provider_error"));
    const before = await server.app.db.select().from(assistExchanges);
    const res = await askAs(teacher, "Comment partager ?");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "llm_failed" });
    expect(await server.app.db.select().from(assistExchanges)).toHaveLength(before.length);
  });

  it("answers 404 when the conversation was purged while the model answered", async () => {
    const { conversationId } = AssistReply.parse((await askAs(teacher, "Première ?")).json());
    script = async (req, metered) => {
      await server.app.db.delete(assistConversations).where(eq(assistConversations.id, conversationId));
      return steps(1)(req, metered);
    };
    const res = await askAs(teacher, "Deuxième ?", conversationId);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "conversation_not_found" });
    expect(await server.app.db.select().from(assistExchanges).where(eq(assistExchanges.conversationId, conversationId))).toHaveLength(0);
  });
});

describe("the 30-day retention (ADR-080 §6)", () => {
  it("deletes the exchanges past 30 days, then the conversations left empty", async () => {
    await server.app.db.delete(assistConversations);
    script = steps(0);
    const old = AssistReply.parse((await askAs(colleague, "Vieille question")).json());
    server.clock.advance(20 * 86_400_000);
    const kept = AssistReply.parse((await askAs(colleague, "Récente")).json());
    server.clock.advance(11 * 86_400_000);
    expect(await purgeAssist(server.app.db, server.clock.now())).toEqual({ exchanges: 1, conversations: 1 });
    const left = await server.app.db.select({ id: assistConversations.id }).from(assistConversations);
    expect(left.map((c) => c.id)).toEqual([kept.conversationId]);
    expect(left.map((c) => c.id)).not.toContain(old.conversationId);
  });
});

describe("without a model nor the stub", () => {
  it("is unavailable, and a question is refused", async () => {
    const plain = await testServer();
    try {
      const someone = await plain.signIn("teacher");
      const availability = await plain.app.inject({ method: "GET", url: "/app/api/assist/availability", headers: someone.headers });
      expect(availability.json()).toEqual({ available: false, stub: false });
      const res = await plain.app.inject({
        method: "POST",
        url: "/app/api/assist/ask",
        headers: someone.headers,
        payload: { message: "Bonjour", context: CONTEXT },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "llm_not_configured" });
    } finally {
      await plain.close();
    }
  });
});
