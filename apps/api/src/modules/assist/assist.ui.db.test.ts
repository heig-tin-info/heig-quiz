/**
 * The assistant drives the interface (ADR-080, P2b amendment), on a real
 * application over PGlite: the two UI tools run nothing on the server; they
 * check what the model asks against the screen catalogue and the screen's
 * effect-free commands, and the checked actions come back with the answer,
 * never stored. The stub opens the pool a question names.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AssistReply } from "@quiz/contracts";
import { ASSIST_WRITE_TOOLS } from "@quiz/domain";

import { loadConfig } from "../../config.js";
import { assistExchanges } from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import type { ConverseReply, ConverseRequest, LlmProvider, Metered } from "../llm/provider.js";
import { LlmGateway } from "../llm/service.js";
import { ASSIST_DATA_TOOLS } from "./tools.js";

const SECRET = "test-llm-master-key-0123456789abcdef";
const KEY = "sk-ant-api03-test-key-0123456789-WXYZ";
const COMMANDS = [
  { id: "question:preview", label: "Preview", effect: "none" },
  { id: "question:publish", label: "Publish this question", effect: "write" },
];
const CONTEXT = { route: "/questions/:id", helpTopic: "question-editor", locale: "fr", commands: COMMANDS };

type Who = { headers: Record<string, string> };

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
/** What each tool call answered the model: its text, or its refusal. */
const results: { name: string; content: string; error: boolean }[] = [];
/** A model that makes the tool calls `calls`, in order, then answers. */
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
    }
    return { text: "C'est ouvert.", model: "claude-sonnet-5-5", steps: 1 };
  };

let server: TestServer;
let teacher: Who & { id: string };
let poolId: string;

const call = (who: Who, method: "GET" | "POST" | "PATCH", url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });
const ask = (message: string, context: unknown = CONTEXT) => call(teacher, "POST", "/app/api/assist/ask", { message, context });

async function setup(stub: boolean) {
  const env = { LLM_KEY_SECRET: SECRET, SUPER_ADMIN_EMAIL: "boss@heig.test", ...(stub ? { LLM_PROVIDER: "stub" } : {}) };
  server = await testServer(env);
  server.app.llmGateway = new LlmGateway({ db: server.app.db, clock: server.clock, config: loadConfig({ NODE_ENV: "test", ...env }), provider: fake });
  teacher = await server.signIn("teacher");
  const pool = await call(teacher, "POST", "/app/api/pools", { name: "Sandbox" });
  expect(pool.statusCode).toBe(201);
  poolId = (pool.json() as { id: string }).id;
}

beforeEach(() => {
  server.clock.advance(61_000);
  seen.length = 0;
  results.length = 0;
});

describe("the development stub (ADR-080 P2b)", () => {
  beforeAll(() => setup(true));
  afterAll(() => server.close());

  it("opens the pool a question names, searched by its tag, and stores the text only", async () => {
    const res = await ask("Montre-moi les questions du pool sandbox, seulement tag:printf");
    expect(res.statusCode).toBe(200);
    const reply = AssistReply.parse(res.json());
    expect(reply.actions).toEqual([{ kind: "open_screen", screen: "pool", ids: { id: poolId }, params: { q: "tag:printf" } }]);
    expect(reply.exchange.answer).toContain("**Sandbox**");
    const [stored] = await server.app.db.select().from(assistExchanges).where(eq(assistExchanges.id, reply.exchange.id));
    // The screen, never its commands nor the actions.
    expect(stored!.context).toEqual({ route: "/questions/:id", helpTopic: "question-editor", locale: "fr" });
  });

  it("answers from the documentation, with no action, when the question names no pool of the teacher's", async () => {
    const reply = AssistReply.parse((await ask("Montre-moi la banque Inconnue")).json());
    expect(reply.actions).toEqual([]);
  });

  it("prepares a quoted category on a pool through the same write tool as a model's (ADR-080 P3)", async () => {
    const context = { route: "/pools/:id", helpTopic: "pool", locale: "en", entities: { pool: poolId } };
    const reply = AssistReply.parse((await ask('Create the category "Pointers"', context)).json());
    expect(reply.actions).toMatchObject([
      { kind: "pending_write", tool: "create_category", lines: [{ field: "pool", values: ["Sandbox"] }, { field: "name", values: ["Pointers"] }] },
    ]);
    expect(reply.exchange.answer).toContain("Nothing is created until you confirm it.");
  });

  it("refuses a command id that is not the palette's shape, or a write labelled as anything else", async () => {
    const bad = { ...CONTEXT, commands: [{ id: "Question Publish!", label: "x", effect: "none" }] };
    expect((await ask("?", bad)).statusCode).toBe(400);
    const odd = { ...CONTEXT, commands: [{ id: "x", label: "x", effect: "maybe" }] };
    expect((await ask("?", odd)).statusCode).toBe(400);
  });
});

describe("the model's UI tools (ADR-080 P2b)", () => {
  beforeAll(async () => {
    await setup(false);
    const admin = await server.signIn("admin", "boss@heig.test");
    expect((await call(admin, "PATCH", "/app/api/admin/llm", { apiKey: KEY })).statusCode).toBe(200);
  });
  afterAll(() => server.close());

  it("are handed after the read tools, with the catalogue in the stable prompt and the screen's commands, each kind said, in the screen's", async () => {
    script = calling();
    expect((await ask("Bonjour")).statusCode).toBe(200);
    const req = seen[0]!;
    expect(req.tools.map((t) => t.name)).toEqual(["read_guide", ...ASSIST_DATA_TOOLS, "open_screen", "run_screen_command", ...ASSIST_WRITE_TOOLS]);
    expect(req.system.stable).toContain("- pool — /pools/:id — Question pool (help/pool)");
    expect(req.system.stable).not.toContain("- admin —");
    expect(req.system.volatile).toContain("  - question:preview — Preview");
    // A command that writes is offered behind the teacher's confirmation only (ADR-080 P3).
    expect(req.system.volatile).toContain("question:publish — Publish this question (changes data: the user is shown a card and it runs only if they confirm)");
  });

  it("return the checked actions with the answer, the model told it is done by the browser", async () => {
    script = calling(["run_screen_command", { id: "question:preview" }], ["open_screen", { screen: "pool", ids: { id: poolId }, params: { q: "tag:printf" } }]);
    const reply = AssistReply.parse((await ask("Montre les printf")).json());
    expect(reply.actions).toEqual([
      { kind: "run_command", id: "question:preview" },
      { kind: "open_screen", screen: "pool", ids: { id: poolId }, params: { q: "tag:printf" } },
    ]);
    expect(results.map((r) => r.error)).toEqual([false, false]);
    expect(results[1]!.content).toContain("browser opens Question pool after your answer");
  });

  it("refuse a screen off the catalogue — the model reads why, nothing comes back (the matrix is the domain's)", async () => {
    script = calling(["open_screen", { screen: "attempt", ids: { evaluationId: poolId } }]);
    const reply = AssistReply.parse((await ask("Ouvre l'examen")).json());
    expect(reply.actions).toEqual([]);
    expect(results[0]).toMatchObject({ error: true, content: expect.stringMatching(/No screen "attempt"/) });
  });

  it("return a command that writes as a proposal to confirm, never as run, and never one the screen did not list", async () => {
    script = calling(["run_screen_command", { id: "question:publish" }], ["run_screen_command", { id: "live:close" }]);
    const reply = AssistReply.parse((await ask("Publie")).json());
    expect(reply.actions).toEqual([{ kind: "confirm_command", id: "question:publish", label: "Publish this question" }]);
    expect(results.map((r) => r.error)).toEqual([false, true]);
    expect(results[0]!.content).toMatch(/runs only if they confirm it/);
  });
});
