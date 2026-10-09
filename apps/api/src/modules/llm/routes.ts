/**
 * The LLM gateway's administration (ADR-058): the settings, the connection
 * test and the month's usage, administrators only. The key is write-only:
 * it comes in on a PATCH and never goes out, nor into an audit payload.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { LlmSettingsPatch, type LlmTestResult } from "@quiz/contracts";
import { isParis } from "@quiz/domain";

import { tracer } from "../../audit.js";
import { Budget, BUDGET_RETRY_AFTER_S } from "../../budget.js";
import type { AppConfig } from "../../config.js";
import { publish } from "../../events.js";
import { adminGuard } from "../guards.js";
import { rateLimited } from "../http.js";
import { LlmError, monthUsage, readSettings, writeSettings } from "./service.js";

/** The connection test (ADR-058 §6): a question with one obvious answer. */
const TEST_QUESTION = "What is the capital of France? Answer with the name of the city only.";
const TestReply = z.object({ answer: z.string() });
/** A few per minute per admin: a guard against a held-down button, not a quota. */
const TESTS_PER_MINUTE = 3;

export async function llmPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireAdmin = adminGuard(app);
  const trace = tracer(app);

  app.get("/app/api/admin/llm", { preHandler: requireAdmin }, async () =>
    readSettings(app.db, config, app.clock.now()),
  );

  app.patch("/app/api/admin/llm", { preHandler: requireAdmin }, async (req, reply) => {
    if (!app.llmGateway.enabled) {
      return reply.code(409).send({ error: "llm_disabled", message: "LLM_KEY_SECRET is not set" });
    }
    const body = LlmSettingsPatch.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation" });
    const { dailyCapUsd } = body.data;
    if (dailyCapUsd !== undefined && dailyCapUsd > config.LLM_DAILY_CAP_MAX_USD) {
      return reply.code(400).send({
        error: "cap_too_high",
        message: `The daily cap cannot exceed ${config.LLM_DAILY_CAP_MAX_USD} USD`,
      });
    }
    await writeSettings(app.db, config, body.data, req.user!.id, app.clock.now());
    // What changed, never the key: `key` says only whether it was set or removed.
    const { apiKey, ...rest } = body.data;
    await trace(req, "llm.settings", "llm_settings", "default", {
      ...rest,
      ...(apiKey === undefined ? {} : { key: apiKey === null ? "removed" : "set" }),
    });
    publish("admin", ["admin"]);
    return readSettings(app.db, config, app.clock.now());
  });

  const tests = new Budget();
  app.post("/app/api/admin/llm/test", { preHandler: requireAdmin }, async (req, reply) => {
    const user = req.user!;
    if (!tests.spend(`llm-test:${user.id}`, TESTS_PER_MINUTE, app.clock.now())) {
      return rateLimited(reply, BUDGET_RETRY_AFTER_S, "A few tests per minute");
    }
    let result: LlmTestResult;
    try {
      const { value, model, durationMs } = await app.llmGateway.complete({
        purpose: "test",
        userId: user.id,
        system: "You answer general-knowledge questions in one word.",
        prompt: TEST_QUESTION,
        schema: TestReply,
        maxTokens: 1024,
        effort: "low",
      });
      result = isParis(value.answer)
        ? { ok: true, model, latencyMs: durationMs }
        : { ok: false, model, error: "invalid_output" };
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      result = { ok: false, model: null, error: err.code };
    }
    await trace(req, "llm.test", "llm_settings", "default", result.ok ? { ok: true } : { ok: false, error: result.error });
    publish("admin", ["admin"]);
    return result;
  });

  app.get("/app/api/admin/llm/usage", { preHandler: requireAdmin }, async () =>
    monthUsage(app.db, app.clock.now()),
  );
}
