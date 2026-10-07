/**
 * The LLM gateway (ADR-058) on a real application over PGlite, with a fake
 * provider in place of Anthropic: the write-only key, the cap reserved
 * before the call, the call log without content, the connection test, the
 * usage, and the budget check of the system status.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LlmSettings, LlmTestResult, LlmUsage, SystemStatus } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import { auditLog, llmCalls, llmSettings } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { LlmError, type LlmProvider, type ProviderRequest } from "./provider.js";
import { LlmGateway } from "./service.js";

const SECRET = "test-llm-master-key-0123456789abcdef";
const KEY = "sk-ant-api03-test-key-0123456789-WXYZ";

/** What the fake provider does next, and every request it was handed. */
let next: (req: ProviderRequest<unknown>) => Promise<unknown>;
const seen: ProviderRequest<unknown>[] = [];
const fake: LlmProvider = {
  id: "anthropic",
  converse: () => Promise.reject(new Error("no conversation here")),
  async complete<T>(req: ProviderRequest<T>) {
    seen.push(req as ProviderRequest<unknown>);
    return (await next(req as ProviderRequest<unknown>)) as never as Awaited<
      ReturnType<LlmProvider["complete"]>
    > & { value: T | null };
  },
};
const answer = (value: unknown, model = "claude-sonnet-5-5") => async () => ({
  value,
  model,
  inputTokens: 100,
  outputTokens: 50,
});

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let admin: Actor;

const inject = (method: "GET" | "PATCH" | "POST", url: string, payload?: object, who: Actor = admin) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

beforeAll(async () => {
  const env = { SUPER_ADMIN_EMAIL: "boss@heig.test", LLM_KEY_SECRET: SECRET, LLM_DAILY_CAP_MAX_USD: "50" };
  server = await testServer(env);
  server.app.llmGateway = new LlmGateway({
    db: server.app.db,
    clock: server.clock,
    config: loadConfig({ NODE_ENV: "test", ...env }),
    provider: fake,
  });
  admin = await server.signIn("admin", "boss@heig.test");
});

afterAll(() => server.close());

beforeEach(async () => {
  // Past the test route's per-minute budget, still the same day.
  server.clock.advance(61_000);
  seen.length = 0;
  next = answer({ answer: "Paris" });
  await server.app.db.delete(llmCalls);
});

describe("the settings", () => {
  it("are an administrator's only", async () => {
    const teacher = await server.signIn("teacher");
    expect((await inject("GET", "/app/api/admin/llm", undefined, teacher)).statusCode).toBe(403);
    expect((await inject("PATCH", "/app/api/admin/llm", { model: "claude-opus-5-5" }, teacher)).statusCode).toBe(403);
    expect((await inject("POST", "/app/api/admin/llm/test", undefined, teacher)).statusCode).toBe(403);
    expect((await inject("GET", "/app/api/admin/llm/usage", undefined, teacher)).statusCode).toBe(403);
  });

  it("start with no key, Sonnet and the default cap (the migration's row)", async () => {
    const s = LlmSettings.parse((await inject("GET", "/app/api/admin/llm")).json());
    expect(s).toMatchObject({
      enabled: true,
      keyLast4: null,
      model: "claude-sonnet-5-5",
      dailyCapUsd: 20,
      updatedAt: null,
    });
    expect(s.dailyCapMaxUsd).toBe(50);
  });

  it("take a key they never give back, nor log, nor audit", async () => {
    const res = await inject("PATCH", "/app/api/admin/llm", { apiKey: KEY, model: "claude-haiku-4-5" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("sk-ant");
    const s = LlmSettings.parse(res.json());
    expect(s).toMatchObject({ keyLast4: "WXYZ", keyReadable: true, model: "claude-haiku-4-5" });

    const [row] = await server.app.db.select().from(llmSettings);
    expect(row!.keyCiphertext!.toString("utf8")).not.toContain("sk-ant");
    const audits = await server.app.db.select().from(auditLog).where(eq(auditLog.action, "llm.settings"));
    expect(JSON.stringify(audits)).not.toContain("sk-ant");
    expect(audits.at(-1)!.payload).toMatchObject({ key: "set", model: "claude-haiku-4-5" });
  });

  it("refuse a cap above the environment's ceiling, and a malformed patch", async () => {
    expect((await inject("PATCH", "/app/api/admin/llm", { dailyCapUsd: 51 })).json()).toMatchObject({
      error: "cap_too_high",
    });
    expect((await inject("PATCH", "/app/api/admin/llm", { model: "gpt-5" })).statusCode).toBe(400);
    expect((await inject("PATCH", "/app/api/admin/llm", { apiKey: "short" })).statusCode).toBe(400);
    expect((await inject("PATCH", "/app/api/admin/llm", { dailyCapUsd: 30 })).statusCode).toBe(200);
  });
});

describe("the connection test", () => {
  beforeAll(async () => {
    await inject("PATCH", "/app/api/admin/llm", { apiKey: KEY, model: "claude-sonnet-5-5", dailyCapUsd: 20 });
  });

  it("asks the configured model with the stored key, and logs the call without its content", async () => {
    const result = LlmTestResult.parse((await inject("POST", "/app/api/admin/llm/test")).json());
    expect(result).toMatchObject({ ok: true, model: "claude-sonnet-5-5" });
    expect(seen[0]).toMatchObject({ apiKey: KEY, model: "claude-sonnet-5-5", effort: "low" });
    const calls = await server.app.db.select().from(llmCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: "test",
      userId: admin.id,
      status: "ok",
      inputTokens: 100,
      outputTokens: 50,
    });
    // 100 × $2/M + 50 × $10/M.
    expect(calls[0]!.costUsd).toBeCloseTo(0.0007);
    expect(JSON.stringify(calls)).not.toMatch(/capital|Paris/i);
  });

  it("fails on a wrong answer, and on a provider error, by its code", async () => {
    next = answer({ answer: "Lyon" });
    expect((await inject("POST", "/app/api/admin/llm/test")).json()).toEqual({
      ok: false,
      model: "claude-sonnet-5-5",
      error: "invalid_output",
    });
    next = async () => {
      throw new LlmError("auth_failed");
    };
    expect((await inject("POST", "/app/api/admin/llm/test")).json()).toMatchObject({ ok: false, error: "auth_failed" });
    const failed = await server.app.db.select().from(llmCalls).where(eq(llmCalls.status, "error"));
    expect(failed).toMatchObject([{ error: "auth_failed", costUsd: 0 }]);
  });

  it("asks once more when the reply does not fit the schema", async () => {
    let n = 0;
    next = async () => (n++ === 0 ? answer(null)() : answer({ answer: "Paris" })());
    expect((await inject("POST", "/app/api/admin/llm/test")).json()).toMatchObject({ ok: true });
    expect(seen).toHaveLength(2);
    const calls = await server.app.db.select().from(llmCalls);
    expect(calls.map((c) => c.status).sort()).toEqual(["error", "ok"]);
  });

  it("says the key is unreadable once the master key changed", async () => {
    const other = new LlmGateway({
      db: server.app.db,
      clock: server.clock,
      config: { LLM_KEY_SECRET: "another-master-key-0123456789abcdef" },
      provider: fake,
    });
    await expect(
      other.complete({ purpose: "test", userId: null, system: "s", prompt: "p", schema: {} as never, maxTokens: 10 }),
    ).rejects.toMatchObject({ code: "key_unreadable" });
    expect(seen).toHaveLength(0);
  });
});

describe("the daily cap", () => {
  beforeAll(async () => {
    await inject("PATCH", "/app/api/admin/llm", { apiKey: KEY, model: "claude-sonnet-5-5", dailyCapUsd: 1 });
  });
  afterAll(async () => {
    await inject("PATCH", "/app/api/admin/llm", { dailyCapUsd: 20 });
  });

  const call = (maxTokens: number) =>
    server.app.llmGateway.complete({
      purpose: "generate",
      userId: null,
      system: "s",
      prompt: "p",
      schema: {} as never,
      maxTokens,
    });

  it("refuses a call whose worst case would cross it, before calling anyone", async () => {
    // 100 000 output tokens at $10/M is $1: over a $1 cap with the prompt.
    await expect(call(100_000)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(seen).toHaveLength(0);
  });

  it("counts calls in flight at their worst case, so parallel calls cannot overshoot together", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    next = async () => {
      await gate;
      return answer({ ok: true })();
    };
    // Each reserves $0.60: the first fits under $1, the second does not.
    const first = call(60_000);
    await new Promise((r) => setTimeout(r, 50));
    await expect(call(60_000)).rejects.toMatchObject({ code: "budget_exhausted" });
    release();
    await expect(first).resolves.toMatchObject({ value: { ok: true } });
    // Settled at its real cost, the budget is free again.
    await expect(call(60_000)).resolves.toBeDefined();
  });

  it("logs a refusal at no cost, and turns the budget check of the system status red", async () => {
    await expect(call(100_000)).rejects.toMatchObject({ code: "budget_exhausted" });
    await expect(call(100_000)).rejects.toMatchObject({ code: "budget_exhausted" });
    // Once a day: a loop past the cap writes nothing more.
    const refused = await server.app.db.select().from(llmCalls).where(eq(llmCalls.error, "budget_exhausted"));
    expect(refused).toMatchObject([{ status: "error", costUsd: 0 }]);
    const status = SystemStatus.parse((await inject("GET", "/app/api/admin/system?fresh=1")).json());
    const budget = status.checks.find((c) => c.key === "llm.budget");
    expect(budget).toMatchObject({ status: "fail", cause: "llm.budget" });
    expect(JSON.stringify(budget)).not.toContain("boss@heig.test");
  });
});

describe("the usage", () => {
  it("sums the month per person and in total", async () => {
    await inject("PATCH", "/app/api/admin/llm", { apiKey: KEY, dailyCapUsd: 20 });
    await inject("POST", "/app/api/admin/llm/test");
    await server.app.llmGateway.complete({
      purpose: "generate",
      userId: null,
      system: "s",
      prompt: "p",
      schema: {} as never,
      maxTokens: 100,
    });
    const usage = LlmUsage.parse((await inject("GET", "/app/api/admin/llm/usage")).json());
    expect(usage.total).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 100 });
    expect(usage.rows.find((r) => r.userId === admin.id)).toMatchObject({ calls: 1, email: "boss@heig.test" });
    expect(usage.rows.find((r) => r.userId === null)).toMatchObject({ calls: 1 });
  });
});
