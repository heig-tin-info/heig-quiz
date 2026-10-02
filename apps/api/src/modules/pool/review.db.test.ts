/**
 * The LLM review (ADR-060) on a real application over PGlite, with a fake
 * provider in place of Anthropic: Review now, the findings kept, the pill,
 * Fix and its Undo, Ignore, the owner's switch, the night within its share
 * of the cap, access (invariant 6), and that a finding never reaches the
 * student preview (invariant 4).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { QuestionDetail, QuestionPage, QuestionReview, ReviewList } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import { llmCalls } from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { LlmError, type LlmProvider } from "../llm/provider.js";
import { LlmGateway, writeSettings } from "../llm/service.js";
import { runNightReview } from "./review.js";

const SECRET = "test-llm-master-key-0123456789abcdef";
const MESSAGE = "Faute d'orthographe dans l'énoncé : « resultat ».";

let next: () => unknown;
let calls = 0;
const fake: LlmProvider = {
  id: "anthropic",
  async complete() {
    calls += 1;
    return { value: next(), model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 200 } as never;
  },
};

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let owner: Actor;
let reader: Actor;
let stranger: Actor;
let poolId: string;

const call = (who: Actor, method: "GET" | "POST" | "PUT", url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

const mcq = (prompt: string) => ({
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

/** A published MCQ of the pool. */
async function published(name: string, prompt = "Quel est le resultat de 2 + 2 ?", pool = poolId): Promise<string> {
  const id = (await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type: "mcq", internalName: name })).json<{
    meta: { id: string };
  }>().meta.id;
  expect((await call(owner, "PUT", `/app/api/questions/${id}/draft`, { config: mcq(prompt), explanation: "" })).statusCode).toBe(200);
  expect((await call(owner, "POST", `/app/api/questions/${id}/publish`, {})).statusCode).toBe(201);
  return id;
}

const typo = () => ({
  findings: [
    { severity: "notice", path: "prompt", message: MESSAGE, fix: { from: "resultat", to: "résultat" } },
    // A field the version does not have: dropped.
    { severity: "warn", path: "choices.9.text", message: "nope", fix: null },
    // A fix that does not even apply to the reviewed version: kept, without its fix.
    { severity: "warn", path: "choices.1.text", message: "Distracteur faible.", fix: { from: "six", to: "sept" } },
  ],
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
  reader = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { apiKey: "sk-ant-api03-test-0123456789" }, owner.id, server.clock.now());
  poolId = (await call(owner, "POST", "/app/api/pools", { name: "Review" })).json<{ id: string }>().id;
  expect(
    (await call(owner, "POST", `/app/api/pools/${poolId}/members`, { userId: reader.id, role: "reader" })).statusCode,
  ).toBe(201);
});

afterAll(() => server.close());

beforeEach(() => {
  server.clock.advance(61_000);
  calls = 0;
});

describe("Review now", () => {
  it("reviews the latest version, keeps what is real, and shows it on the question and in the list", async () => {
    const id = await published("typo");
    next = typo;
    const res = await call(owner, "POST", `/app/api/questions/${id}/review`);
    expect(res.statusCode).toBe(200);
    const review = QuestionReview.parse(res.json());
    expect(review).toMatchObject({ versionNumber: 1, state: "findings" });
    expect(review.findings).toEqual([
      { severity: "notice", path: "prompt", message: MESSAGE, fix: { from: "resultat", to: "résultat" } },
      { severity: "warn", path: "choices.1.text", message: "Distracteur faible.", fix: null },
    ]);

    const detail = QuestionDetail.parse((await call(reader, "GET", `/app/api/questions/${id}`)).json());
    expect(detail.review?.findings).toHaveLength(2);
    const page = QuestionPage.parse((await call(reader, "GET", `/app/api/pools/${poolId}/questions`)).json());
    expect(page.items.find((q) => q.id === id)?.review).toEqual({ state: "findings", count: 2, worst: "warn" });
  });

  it("is silent on a fine question", async () => {
    const id = await published("fine", "Combien font 2 + 2 ?");
    next = () => ({ findings: [] });
    expect(QuestionReview.parse((await call(owner, "POST", `/app/api/questions/${id}/review`)).json()).state).toBe("clean");
  });

  it("is a contributor's: a reader is refused, a stranger meets a 404, and no model is asked", async () => {
    const id = await published("access");
    expect((await call(reader, "POST", `/app/api/questions/${id}/review`)).statusCode).toBe(403);
    expect((await call(stranger, "POST", `/app/api/questions/${id}/review`)).statusCode).toBe(404);
    expect((await call(stranger, "GET", `/app/api/pools/${poolId}/reviews`)).statusCode).toBe(404);
    expect(calls).toBe(0);
  });

  it("lets only a contributor fix or ignore, and only the owner switch the night (invariant 6)", async () => {
    const id = await published("access-write");
    next = typo;
    await call(owner, "POST", `/app/api/questions/${id}/review`);
    const before = (await call(owner, "GET", `/app/api/questions/${id}`)).json<{ draft: unknown }>().draft;
    for (const [who, status] of [
      [reader, 403],
      [stranger, 404],
    ] as const) {
      expect((await call(who, "POST", `/app/api/questions/${id}/review/fix`, { finding: 0 })).statusCode).toBe(status);
      expect((await call(who, "POST", `/app/api/questions/${id}/review/ignore`)).statusCode).toBe(status);
      expect((await call(who, "PUT", `/app/api/pools/${poolId}/review`, { enabled: true })).statusCode).toBe(status);
    }
    expect((await call(owner, "GET", `/app/api/questions/${id}`)).json<{ draft: unknown }>().draft).toEqual(before);
    const review = QuestionDetail.parse((await call(owner, "GET", `/app/api/questions/${id}`)).json()).review;
    expect(review?.state).toBe("findings");
  });

  it("answers the gateway's failures by their code", async () => {
    const id = await published("failing");
    next = () => {
      throw new LlmError("budget_exhausted");
    };
    const res = await call(owner, "POST", `/app/api/questions/${id}/review`);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "llm_budget_exhausted", reason: "budget_exhausted" });
  });
});

describe("Fix, Undo and Ignore", () => {
  it("applies the exact fix to the draft, undoes it, and refuses it once the draft moved on", async () => {
    const id = await published("fix");
    next = typo;
    await call(owner, "POST", `/app/api/questions/${id}/review`);
    const draftPrompt = async () =>
      ((QuestionDetail.parse((await call(owner, "GET", `/app/api/questions/${id}`)).json()).draft.config as { prompt: string })
        .prompt);

    const fixed = QuestionReview.parse((await call(owner, "POST", `/app/api/questions/${id}/review/fix`, { finding: 0 })).json());
    expect(fixed.findings[0]!.applied).toBe(true);
    expect(await draftPrompt()).toBe("Quel est le résultat de 2 + 2 ?");

    // Applied once: a second Fix is refused, whatever the draft holds.
    expect((await call(owner, "POST", `/app/api/questions/${id}/review/fix`, { finding: 0 })).json()).toEqual({
      error: "fix_stale",
    });

    await call(owner, "POST", `/app/api/questions/${id}/review/fix`, { finding: 0, undo: true });
    expect(await draftPrompt()).toBe("Quel est le resultat de 2 + 2 ?");
    // Undone once: an Undo of a fix that is not in the draft is refused.
    expect((await call(owner, "POST", `/app/api/questions/${id}/review/fix`, { finding: 0, undo: true })).json()).toEqual({
      error: "fix_stale",
    });

    await call(owner, "PUT", `/app/api/questions/${id}/draft`, { config: mcq("Tout autre énoncé"), explanation: "" });
    const stale = await call(owner, "POST", `/app/api/questions/${id}/review/fix`, { finding: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "fix_stale" });
    expect((await call(owner, "POST", `/app/api/questions/${id}/review/fix`, { finding: 1 })).json()).toEqual({
      error: "no_fix",
    });
  });

  it("ignores a review: it leaves the tab and the pill keeps 'reviewed'", async () => {
    const id = await published("ignore");
    next = typo;
    await call(owner, "POST", `/app/api/questions/${id}/review`);
    const ignored = QuestionReview.parse((await call(owner, "POST", `/app/api/questions/${id}/review/ignore`)).json());
    expect(ignored.state).toBe("ignored");
    const list = ReviewList.parse((await call(reader, "GET", `/app/api/pools/${poolId}/reviews`)).json());
    expect(list.items.map((i) => i.questionId)).not.toContain(id);
    const page = QuestionPage.parse((await call(owner, "GET", `/app/api/pools/${poolId}/questions`)).json());
    expect(page.items.find((q) => q.id === id)?.review).toEqual({ state: "ignored", count: 0, worst: null });
  });

  it("never shows a finding in the student preview (invariant 4)", async () => {
    const id = await published("preview");
    next = typo;
    await call(owner, "POST", `/app/api/questions/${id}/review`);
    const preview = await call(owner, "POST", `/app/api/questions/${id}/preview`, { source: 1 });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).not.toContain("Faute d'orthographe");
    expect(preview.body).not.toContain("findings");
  });
});

describe("the night", () => {
  it("is the owner's to turn on, and reviews only the pools that asked, within its share", async () => {
    expect((await call(reader, "PUT", `/app/api/pools/${poolId}/review`, { enabled: true })).statusCode).toBe(403);
    const other = (await call(owner, "POST", "/app/api/pools", { name: "Not asked" })).json<{ id: string }>().id;
    const outside = await published("outside", "Une question hors du pool qui a demandé.", other);
    const inside = await published("inside", "Une question du pool qui a demandé.");

    // Outside the night, nothing.
    server.clock.set("2026-07-01T12:00:00Z");
    next = () => ({ findings: [] });
    expect(await runNightReview(server.app.db, server.app.llmGateway, server.clock.now())).toMatch(/outside the night/);

    const on = ReviewList.parse((await call(owner, "PUT", `/app/api/pools/${poolId}/review`, { enabled: true })).json());
    expect(on.enabled).toBe(true);
    expect(on.pending).toBeGreaterThan(0);

    // 02:30 in Zurich: every pending version of the pool, none of the other.
    server.clock.set("2026-07-02T00:30:00Z");
    const summary = await runNightReview(server.app.db, server.app.llmGateway, server.clock.now());
    expect(summary).toMatch(/reviewed/);
    const after = ReviewList.parse((await call(owner, "GET", `/app/api/pools/${poolId}/reviews`)).json());
    expect(after.pending).toBe(0);
    const outsideDetail = QuestionDetail.parse((await call(owner, "GET", `/app/api/questions/${outside}`)).json());
    expect(outsideDetail.review).toBeNull();
    expect(QuestionDetail.parse((await call(owner, "GET", `/app/api/questions/${inside}`)).json()).review?.state).toBe("clean");
    // Made by no person, under the purpose `review`.
    const night = await server.app.db.select().from(llmCalls).where(eq(llmCalls.purpose, "review"));
    expect(night.some((c) => c.userId === null)).toBe(true);
  });

  it("stops before its share of the cap, never on the gateway's refusal", async () => {
    // A cap of 10 cents: a share of 2.5 cents, less than one call's worst case (4 000 output tokens).
    await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { dailyCapUsd: 0.1 }, owner.id, server.clock.now());
    await published("late", "Encore une question à relire.");
    await call(owner, "PUT", `/app/api/pools/${poolId}/review`, { enabled: true });
    server.clock.set("2026-07-03T00:30:00Z");
    const refusals = async () =>
      (await server.app.db.select().from(llmCalls).where(eq(llmCalls.error, "budget_exhausted"))).length;
    const before = await refusals();
    const summary = await runNightReview(server.app.db, server.app.llmGateway, server.clock.now());
    expect(summary).toMatch(/share of the cap is spent/);
    expect(calls).toBe(0);
    expect(await refusals()).toBe(before);
    await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { dailyCapUsd: 20 }, owner.id, server.clock.now());
  });
});
