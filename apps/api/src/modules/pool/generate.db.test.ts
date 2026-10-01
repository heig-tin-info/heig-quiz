/**
 * "Generate answers" (ADR-059) on a real application over PGlite, with a fake
 * provider in place of Anthropic: what is sent, what comes back merged, the
 * wand of one MCQ choice, the refusals, and access (invariant 6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GenerateResult, LlmAvailability } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { LlmError, type LlmProvider, type ProviderRequest } from "../llm/provider.js";
import { LlmGateway, writeSettings } from "../llm/service.js";

const SECRET = "test-llm-master-key-0123456789abcdef";

let next: (req: ProviderRequest<unknown>) => unknown;
const seen: ProviderRequest<unknown>[] = [];
const fake: LlmProvider = {
  id: "anthropic",
  async complete(req) {
    seen.push(req as ProviderRequest<unknown>);
    return { value: next(req as ProviderRequest<unknown>), model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } as never;
  },
};

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let owner: Actor;
let stranger: Actor;
let questionId: string;

const call = (who: Actor, method: "GET" | "POST", url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });
const generate = (payload: Payload, who: Actor = owner) =>
  call(who, "POST", `/app/api/questions/${questionId}/generate`, payload);

const mcq = (choices: { text: string; correct: boolean }[], prompt = "Combien font 2 + 2 ?") => ({
  configVersion: 2,
  prompt,
  choices,
  mode: "single",
  policy: "inherit",
  shuffleChoices: true,
});

beforeAll(async () => {
  const env = { LLM_KEY_SECRET: SECRET };
  server = await testServer(env);
  server.app.llmGateway = new LlmGateway({
    db: server.app.db,
    clock: server.clock,
    config: loadConfig({ NODE_ENV: "test", ...env }),
    provider: fake,
  });
  owner = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  const pool = (await call(owner, "POST", "/app/api/pools", { name: "Generate" })).json<{ id: string }>().id;
  const created = await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type: "mcq", internalName: "2+2" });
  questionId = created.json<{ meta: { id: string } }>().meta.id;
});

afterAll(() => server.close());

beforeEach(() => {
  server.clock.advance(61_000);
  seen.length = 0;
});

describe("availability", () => {
  it("says the wand is off until a key is stored, and lists the types that have one", async () => {
    const before = LlmAvailability.parse((await call(owner, "GET", "/app/api/generate/availability")).json());
    expect(before.available).toBe(false);
    expect(before.types.sort()).toEqual(["categorize", "code", "codeimage", "mcq", "rich", "short"]);
    expect((await generate({ config: mcq([{ text: "", correct: true }]), explanation: "" })).json()).toMatchObject({
      error: "llm_not_configured",
    });

    await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { apiKey: "sk-ant-api03-test-0123456789" }, owner.id, server.clock.now());
    expect(LlmAvailability.parse((await call(owner, "GET", "/app/api/generate/availability")).json()).available).toBe(true);
  });
});

describe("POST /questions/:id/generate", () => {
  it("sends the draft, never changes the statement, and merges the proposal and an empty explanation", async () => {
    next = () => ({
      proposal: { choices: [{ text: "4", correct: true }, { text: "3", correct: false }, { text: "22", correct: false }] },
      explanation: "2 + 2 = 4.",
    });
    const res = await generate({
      config: mcq([
        { text: "", correct: true },
        { text: "", correct: false },
      ]),
      explanation: "",
    });
    expect(res.statusCode).toBe(200);
    const result = GenerateResult.parse(res.json());
    expect(result.explanation).toBe("2 + 2 = 4.");
    expect(result.config).toMatchObject({
      prompt: "Combien font 2 + 2 ?",
      choices: [
        { text: "4", correct: true },
        { text: "3", correct: false },
        { text: "22", correct: false },
      ],
    });
    expect(seen[0]!.prompt).toContain("Combien font 2 + 2 ?");
    expect(seen[0]!.system).toContain("language of the statement");
  });

  it("keeps an explanation the teacher wrote", async () => {
    next = () => ({ proposal: { choices: [] }, explanation: "Theirs" });
    const result = GenerateResult.parse((await generate({ config: mcq([{ text: "4", correct: true }]), explanation: "Mine" })).json());
    expect(result.explanation).toBe("Mine");
  });

  it("fills one empty choice, and refuses a choice that is written", async () => {
    next = () => ({ text: "5", correct: false });
    const config = mcq([
      { text: "4", correct: true },
      { text: "", correct: false },
    ]);
    const res = await generate({ config, explanation: "", item: 1 });
    expect(GenerateResult.parse(res.json()).config).toMatchObject({
      choices: [
        { text: "4", correct: true },
        { text: "5", correct: false },
      ],
    });
    expect(seen[0]!.prompt).toContain("number 2");
    expect((await generate({ config, explanation: "", item: 0 })).json()).toEqual({ error: "item_not_empty" });
  });

  it("refuses an empty statement before asking anyone", async () => {
    const res = await generate({ config: mcq([{ text: "", correct: true }], "  "), explanation: "" });
    expect(res.json()).toEqual({ error: "statement_empty" });
    expect(seen).toHaveLength(0);
  });

  it("answers the gateway's failures by their code", async () => {
    next = () => {
      throw new LlmError("budget_exhausted");
    };
    const res = await generate({ config: mcq([{ text: "", correct: true }]), explanation: "" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "llm_budget_exhausted", reason: "budget_exhausted" });
  });

  it("is a 404 for a teacher outside the pool (invariant 6)", async () => {
    const res = await generate({ config: mcq([{ text: "", correct: true }]), explanation: "" }, stranger);
    expect(res.statusCode).toBe(404);
    expect(seen).toHaveLength(0);
  });
});

describe("a code question: the outputs come from running the reference (ADR-059 §7)", () => {
  let codeId: string;
  const codeDraft = {
    configVersion: 1,
    prompt: "Lisez deux entiers et affichez leur somme.",
    language: "c",
    runtime: "backend",
    cooldown: "fixed",
    template: "",
    files: [],
    action: "run",
    compileArgs: "",
    limits: { timeMs: 2000, memoryMb: 64, outputKb: 64 },
    runsPerMinute: 10,
    allOrNothing: false,
    referenceSolution: "",
    tests: {
      mode: "io",
      compare: { trimTrailing: true, ignoreCase: false, numeric: null },
      cases: [{ name: "", args: [], stdin: "", expected: "", compareStdout: true, expectedExitCode: 0, visible: true, points: 1, timeMs: null }],
    },
  };

  beforeAll(async () => {
    const pool = (await call(owner, "POST", "/app/api/pools", { name: "Generate code" })).json<{ id: string }>().id;
    const created = await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type: "code", internalName: "sum" });
    codeId = created.json<{ meta: { id: string } }>().meta.id;
    next = () => ({
      proposal: {
        referenceSolution: "#include <stdio.h>\nint main(void){int a,b;scanf(\"%d %d\",&a,&b);printf(\"%d\\n\",a+b);}",
        cases: [
          { name: "petits", stdin: "1 2", args: [], visible: true },
          { name: "négatifs", stdin: "-3 1", args: [], visible: false },
        ],
      },
      explanation: "",
    });
  });

  it("merges the reference and the inputs, and says the outputs wait for a runner", async () => {
    const res = await call(owner, "POST", `/app/api/questions/${codeId}/generate`, { config: codeDraft, explanation: "" });
    const result = GenerateResult.parse(res.json());
    expect(result.incomplete).toBe("runner_unavailable");
    expect(result.config).toMatchObject({
      referenceSolution: expect.stringContaining("printf"),
      tests: { cases: [{ name: "petits", stdin: "1 2", expected: "" }, { name: "négatifs", expected: "" }] },
    });
  });

  it("writes the outputs the reference printed when there is a runner", async () => {
    const real = server.app.runner;
    server.app.runner = {
      run: async (req) => ({
        compile: { ok: true, stdout: "", stderr: "", ms: 1 },
        cases: req.cases.map((c) => ({
          exitCode: 0,
          stdout: `${c.stdin.split(" ").map(Number).reduce((a, b) => a + b, 0)}\n`,
          stderr: "",
          ms: 1,
          timedOut: false,
          oom: false,
          truncated: false,
        })),
      }),
      health: real.health.bind(real),
    };
    try {
      const res = await call(owner, "POST", `/app/api/questions/${codeId}/generate`, { config: codeDraft, explanation: "" });
      const result = GenerateResult.parse(res.json());
      expect(result.incomplete).toBeUndefined();
      expect(result.config).toMatchObject({ tests: { cases: [{ expected: "3\n" }, { expected: "-2\n" }] } });
    } finally {
      server.app.runner = real;
    }
  });

  it("runs nothing on a draft that does not validate, and says so instead of failing", async () => {
    const { language: _language, ...partial } = codeDraft;
    const res = await call(owner, "POST", `/app/api/questions/${codeId}/generate`, { config: partial, explanation: "" });
    expect(res.statusCode).toBe(200);
    const result = GenerateResult.parse(res.json());
    expect(result.incomplete).toBe("draft_invalid");
    expect(result.config).toMatchObject({ referenceSolution: expect.stringContaining("printf") });
  });
});
