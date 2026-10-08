/**
 * The teacher assistant's routes (ADR-080): a teacher's or an
 * administrator's PORTAL session only — never a personal API token, a
 * `seb` or `kiosk` session, nor a session acting as a student (ADR-034).
 * A conversation is its owner's: anyone else's is a 404 (invariant 6),
 * except for an administrator with Super Powers on (ADR-054), whose read is
 * audited (`assist.read`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AssistAsk, AssistListQuery, IdParam, type AssistAvailability } from "@quiz/contracts";
import { ASSIST_TURNS_PER_MINUTE } from "@quiz/domain";

import { tracer } from "../../audit.js";
import { Budget, BUDGET_RETRY_AFTER_S } from "../../budget.js";
import type { AppConfig } from "../../config.js";
import { callerOf, ownSessionGuard, teacherGuard } from "../guards.js";
import { invalid, notFound } from "../http.js";
import { LlmError, llmFailure } from "../llm/service.js";
import { injectedApi } from "../mcp/service.js";
import { loadCorpus } from "./corpus.js";
import {
  ask,
  assistEngine,
  ConversationNotFound,
  conversationDetail,
  deleteConversation,
  findConversation,
  listConversations,
} from "./service.js";

export async function assistPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const corpus = loadCorpus(config.NODE_ENV === "production");
  if (!corpus) app.log.warn("assist: no corpus (dist/assist-corpus.json); the assistant is unavailable");
  const stub = config.LLM_PROVIDER === "stub";
  const trace = tracer(app);

  /** A teacher or an administrator, in their own portal session, through the browser (ADR-080 §3). */
  const requireAssist = [teacherGuard(app), ownSessionGuard(app)];
  /**
   * Reading another teacher's conversations is reaching their content: an
   * administrator with Super Powers on (ADR-054), audited (ADR-080 §6).
   */
  const readsEveryone = (req: FastifyRequest) => callerOf(req).reach === "all";
  /** The engine that answers now, or null: no corpus, no key and no stub. */
  const engineNow = async () => (corpus ? assistEngine(app.llmGateway, stub) : null);
  /**
   * A conversation that is not the caller's — missing, somebody else's,
   * purged — is ONE answer on every route: `404 conversation_not_found`
   * (invariant 6: nothing tells them apart).
   */
  const missing = (reply: FastifyReply) => reply.code(404).send({ error: "conversation_not_found" });
  /** The data tools' client of the API, with the question's own token (ADR-080 §8). */
  const api = (authorization: string) => injectedApi(app, authorization, config.WEB_URL);

  app.get("/app/api/assist/availability", { preHandler: requireAssist }, async (): Promise<AssistAvailability> => {
    const engine = await engineNow();
    return { available: engine !== null, stub: engine === "stub" };
  });

  const questions = new Budget();
  app.post("/app/api/assist/ask", { preHandler: requireAssist }, async (req, reply) => {
    const body = AssistAsk.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const user = req.user!;
    const now = app.clock.now();
    if (!questions.spend(`assist:${user.id}`, ASSIST_TURNS_PER_MINUTE, now)) {
      return reply.code(429).header("retry-after", String(BUDGET_RETRY_AFTER_S)).send({ error: "rate_limited" });
    }
    const engine = await engineNow();
    if (!corpus || !engine) return reply.code(409).send({ error: "llm_not_configured" });
    try {
      return await ask({ db: app.db, gateway: app.llmGateway, corpus, engine, api }, user, body.data, now);
    } catch (error) {
      // Missing, somebody else's, or purged while the model answered: the same
      // 404. In the last case the model's requests were made and logged; the
      // panel asks again in a new conversation, so that rare race is charged
      // twice — a few cents, rather than an exchange written into a
      // conversation its owner just deleted.
      if (error instanceof ConversationNotFound) return missing(reply);
      if (error instanceof LlmError) {
        const { status, body: failure } = llmFailure(error);
        return reply.code(status).send(failure);
      }
      throw error;
    }
  });

  app.get("/app/api/assist/conversations", { preHandler: requireAssist }, async (req, reply) => {
    const query = AssistListQuery.safeParse(req.query ?? {});
    if (!query.success) return invalid(reply, query.error);
    const user = req.user!;
    const owner = query.data.userId ?? user.id;
    if (owner === user.id) return listConversations(app.db, user.id);
    // Another person's list: an administrator's read, audited; anyone else learns nothing.
    if (!readsEveryone(req)) return notFound(reply);
    await trace(req, "assist.read", "user", owner, { list: true });
    return listConversations(app.db, owner);
  });

  app.get("/app/api/assist/conversations/:id", { preHandler: requireAssist }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return missing(reply);
    const user = req.user!;
    const own = await findConversation(app.db, params.data.id, user.id);
    if (own) return conversationDetail(app.db, own);
    const other = readsEveryone(req) ? await findConversation(app.db, params.data.id, null) : null;
    if (!other) return missing(reply);
    await trace(req, "assist.read", "assist_conversation", other.id, { owner: other.userId });
    return conversationDetail(app.db, other);
  });

  /** The owner's alone (ADR-080 §6): an administrator reads another's, never deletes it. */
  app.delete("/app/api/assist/conversations/:id", { preHandler: requireAssist }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return missing(reply);
    const own = await findConversation(app.db, params.data.id, req.user!.id);
    if (!own) return missing(reply);
    await deleteConversation(app.db, own.id);
    return reply.code(204).send();
  });
}
