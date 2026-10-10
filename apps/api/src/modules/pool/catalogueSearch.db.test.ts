/**
 * The public pool catalogue (issue #680, lot 2; ADR-095) on a real
 * application over PGlite, with a fake LLM provider: public pools only
 * whatever Super Powers, the search over name, description, domain and the
 * concept labels of published questions (normalised, no extension), the
 * ranking, and the bilingual domain inferred from concept labels alone — on
 * publication and by the night.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PoolSummary } from "@quiz/contracts";
import { conceptKey } from "@quiz/domain";

import { loadConfig } from "../../config.js";
import { concepts, llmCalls, pools, questionConcepts } from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import type { LlmProvider } from "../llm/provider.js";
import { LlmGateway, writeSettings } from "../llm/service.js";
import { conceptLabelsOf, refreshDomain, runNightDomains } from "./domain.js";

const SECRET = "test-llm-master-key-0123456789abcdef";

let reply: { fr: string; en: string } = { fr: "Résistance des matériaux", en: "Strength of materials" };
let prompts: string[] = [];
const fake: LlmProvider = {
  id: "anthropic",
  converse: () => Promise.reject(new Error("no conversation here")),
  async complete(req) {
    prompts.push(`${req.system}\n${req.prompt}`);
    return { value: reply, model: "claude-sonnet-5-5", inputTokens: 200, outputTokens: 30 } as never;
  },
};

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let owner: Actor;
let reader: Actor;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const call = (who: Actor, method: Method, url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

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
  await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { apiKey: "sk-ant-api03-test-0123456789" }, owner.id, server.clock.now());
});
afterAll(() => server.close());

async function newPool(name: string, extra: Record<string, unknown> = {}, who = owner): Promise<string> {
  const res = await call(who, "POST", "/app/api/pools", { name, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

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

/** A question of the pool, published or left as a draft. */
async function question(pool: string, name: string, publish = true): Promise<string> {
  const id = (await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type: "mcq", internalName: `${name}-${randomUUID().slice(0, 4)}` })).json<{
    meta: { id: string };
  }>().meta.id;
  expect((await call(owner, "PUT", `/app/api/questions/${id}/draft`, { config: mcq(`SECRET-STATEMENT ${name}`), explanation: "" })).statusCode).toBe(200);
  if (publish) expect((await call(owner, "POST", `/app/api/questions/${id}/publish`, {})).statusCode).toBe(201);
  return id;
}

/** A concept of the vocabulary, attached to a question. */
async function tag(questionId: string, labelFr: string | null, labelEn: string | null): Promise<void> {
  const id = randomUUID();
  await server.app.db.insert(concepts).values({
    id,
    status: "validated",
    labelFr,
    labelEn,
    keyFr: labelFr ? `${conceptKey(labelFr)}-${id.slice(0, 4)}` : null,
    keyEn: labelEn ? `${conceptKey(labelEn)}-${id.slice(0, 4)}` : null,
  });
  await server.app.db.insert(questionConcepts).values({ questionId, conceptId: id });
}

const search = async (who: Actor, q: string) =>
  PoolSummary.array().parse((await call(who, "GET", `/app/api/pools/catalogue?q=${encodeURIComponent(q)}`)).json());
const names = async (who: Actor, q: string) => (await search(who, q)).map((p) => p.name);

describe("the catalogue lists public pools only", () => {
  it("leaves out private and shared pools, even for an admin under Super Powers", async () => {
    const open = await newPool("Cat open", { isPublic: true });
    const hidden = await newPool("Cat hidden");
    const shared = await newPool("Cat shared");
    await call(owner, "POST", `/app/api/pools/${shared}/members`, { userId: reader.id, role: "contributor" });

    const everyone = (await search(reader, "")).map((p) => p.id);
    expect(everyone).toContain(open);
    expect(everyone).not.toContain(hidden);
    // Even a pool the reader sits on: the catalogue is public pools.
    expect(everyone).not.toContain(shared);

    const admin = await server.signInWithSuperPowers();
    const seen = (await search(admin, "")).map((p) => p.id);
    expect(seen).toContain(open);
    expect(seen).not.toContain(hidden);
  });

  it("answers a student with 403 and rejects an absurd query", async () => {
    const student = await server.signIn("student");
    expect((await call(student, "GET", "/app/api/pools/catalogue")).statusCode).toBe(403);
    expect((await call(owner, "GET", `/app/api/pools/catalogue?q=${"x".repeat(300)}`)).statusCode).toBe(400);
  });
});

describe("the search", () => {
  it("finds a pool by name, description, domain and concept labels, accents and plurals aside", async () => {
    await newPool("Thermodynamique appliquée", { isPublic: true });
    const byDescription = await newPool("Pool B", { isPublic: true });
    expect((await call(owner, "PATCH", `/app/api/pools/${byDescription}`, { description: "Cycles frigorifiques et pompes à chaleur" })).statusCode).toBe(200);
    const byDomain = await newPool("Pool C", { isPublic: true });
    await server.app.db.update(pools).set({ domainFr: "Électrochimie", domainEn: "Electrochemistry" }).where(eq(pools.id, byDomain));
    const byConcept = await newPool("Pool D", { isPublic: true });
    await tag(await question(byConcept, "q"), "Intégrale de Riemann", "Riemann integral");

    expect(await names(reader, "THERMODYNAMIQUE")).toContain("Thermodynamique appliquée");
    expect(await names(reader, "thermodynamique appliquee")).toContain("Thermodynamique appliquée");
    expect(await names(reader, "pompes chaleur")).toContain("Pool B");
    expect(await names(reader, "electrochimie")).toContain("Pool C");
    expect(await names(reader, "electrochemistry")).toContain("Pool C");
    // The concept's French label, plural query; and its English label.
    expect(await names(reader, "intégrales")).toContain("Pool D");
    expect(await names(reader, "riemann integral")).toContain("Pool D");
    // Every word must be found, anywhere.
    expect(await names(reader, "riemann electrochimie")).toEqual([]);
    expect(await names(reader, "zzzz")).toEqual([]);
  });

  it("folds the ligatures in the stored text as in the query: Cœur, cœur, coeur", async () => {
    await newPool("Cœur et Œuvre", { isPublic: true });
    await newPool("Straße", { isPublic: true });
    await newPool("Cæsar", { isPublic: true });
    for (const q of ["cœur", "coeur", "COEUR", "œuvre"]) expect(await names(reader, q)).toContain("Cœur et Œuvre");
    expect(await names(reader, "strasse")).toEqual(["Straße"]);
    expect(await names(reader, "caesar")).toEqual(["Cæsar"]);
  });

  it("reads published, non-deleted questions only", async () => {
    const pool = await newPool("Pool E", { isPublic: true });
    await tag(await question(pool, "draft", false), "Concept brouillon", "Draft concept");
    const gone = await question(pool, "gone");
    await tag(gone, "Concept supprimé", "Deleted concept");
    expect((await call(owner, "DELETE", `/app/api/questions/${gone}`)).statusCode).toBeLessThan(300);

    expect(await names(reader, "brouillon")).toEqual([]);
    expect(await names(reader, "supprimé")).toEqual([]);
    await tag(await question(pool, "kept"), "Concept conservé", null);
    expect(await names(reader, "conservé")).toEqual(["Pool E"]);
  });

  it("treats a wildcard as text and a short query whole", async () => {
    await newPool("Rate 100% sure", { isPublic: true });
    expect(await names(reader, "100%")).toEqual(["Rate 100% sure"]);
    expect(await names(reader, "%")).toEqual(["Rate 100% sure"]);
  });
});

describe("the ranking", () => {
  it("puts the most followed first: subscribers plus members, then name", async () => {
    const quiet = await newPool("Rank quiet", { isPublic: true });
    const liked = await newPool("Rank liked", { isPublic: true });
    const shared = await newPool("Rank shared", { isPublic: true });
    await call(reader, "PUT", `/app/api/pools/${liked}/subscription`);
    await call(owner, "POST", `/app/api/pools/${shared}/members`, { userId: reader.id, role: "contributor" });
    const third = await server.signIn("teacher");
    await call(third, "PUT", `/app/api/pools/${liked}/subscription`);

    const ranked = (await search(reader, "rank")).map((p) => p.id);
    expect(ranked).toEqual([liked, shared, quiet]);
    const likedRow = (await search(reader, "rank liked"))[0]!;
    expect(likedRow).toMatchObject({ subscriberCount: 2, memberCount: 0, subscription: "subscribed", visibility: "public" });
  });
});

describe("the domain", () => {
  it("is inferred from the concept labels alone, in both languages, and only redone when they change", async () => {
    const pool = await newPool("Secret pool name for the domain", { isPublic: true });
    const first = await question(pool, "first");
    await tag(first, "Contrainte normale", "Normal stress");
    await tag(first, "Moment fléchissant", null);
    prompts = [];
    reply = { fr: "« Résistance des matériaux »", en: "Strength of materials" };

    expect(await refreshDomain(server.app.db, server.app.llmGateway, pool, await conceptLabelsOf(server.app.db, pool), { userId: owner.id, now: server.clock.now() })).toBe("updated");
    expect(prompts).toHaveLength(1);
    // What leaves: the concept labels; never the pool's name, a statement or an internal name.
    expect(prompts[0]).toContain("Contrainte normale / Normal stress");
    expect(prompts[0]).toContain("Moment fléchissant / ?");
    expect(prompts[0]).not.toContain("Secret pool name");
    expect(prompts[0]).not.toContain("SECRET-STATEMENT");
    expect(prompts[0]).not.toContain(first);
    const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
    expect(row).toMatchObject({ domainFr: "Résistance des matériaux", domainEn: "Strength of materials" });

    // The catalogue finds it by the domain, and carries it on the card.
    expect(await names(reader, "resistance materiaux")).toContain("Secret pool name for the domain");
    expect((await search(reader, "resistance materiaux"))[0]).toMatchObject({ domainFr: "Résistance des matériaux", domainEn: "Strength of materials" });

    // Unchanged concepts: the night asks nothing again; a new concept makes it ask once more.
    server.clock.set("2026-07-05T00:30:00Z");
    const about = (word: string) => prompts.filter((p) => p.includes(word)).length;
    await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now());
    expect(about("Contrainte normale")).toBe(1);
    await tag(await question(pool, "second"), "Flexion", "Bending");
    await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now());
    expect(about("Flexion")).toBe(1);
    expect(about("Contrainte normale")).toBe(2);
  });

  it("is inferred when the pool is published, in the background", async () => {
    const pool = await newPool("Published later");
    await tag(await question(pool, "p"), "Oxydation", "Oxidation");
    reply = { fr: "Chimie", en: "Chemistry" };
    prompts = [];
    expect((await call(owner, "PATCH", `/app/api/pools/${pool}`, { isPublic: true })).statusCode).toBe(200);
    for (let i = 0; i < 100 && prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(prompts).toHaveLength(1);
    for (let i = 0; i < 100; i++) {
      const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
      if (row?.domainFr === "Chimie") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
    expect(row).toMatchObject({ domainFr: "Chimie", domainEn: "Chemistry" });
    // Made on behalf of the owner who published, under the purpose `domain`.
    const calls = await server.app.db.select().from(llmCalls).where(eq(llmCalls.purpose, "domain"));
    expect(calls.some((c) => c.userId === owner.id)).toBe(true);
  });

  it("is cleared, without a call, when the pool has no concept to read", async () => {
    const pool = await newPool("No concept", { isPublic: true });
    await server.app.db.update(pools).set({ domainFr: "Ancien", domainEn: "Old", domainKey: "x" }).where(eq(pools.id, pool));
    prompts = [];
    expect(await refreshDomain(server.app.db, server.app.llmGateway, pool, [], { userId: null, now: server.clock.now() })).toBe("empty");
    expect(prompts).toEqual([]);
    const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
    expect(row).toMatchObject({ domainFr: "", domainEn: "", domainKey: "" });
  });

  it("is redone by the night for the public pools whose concepts changed, and only at night", async () => {
    const pool = await newPool("Night pool", { isPublic: true });
    await tag(await question(pool, "n"), "Optique géométrique", "Geometric optics");
    const private_ = await newPool("Night private");
    await tag(await question(private_, "n"), "Jamais envoyé", "Never sent");
    reply = { fr: "Optique", en: "Optics" };

    server.clock.set("2026-07-01T12:00:00Z");
    expect(await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now())).toMatch(/outside the night/);

    prompts = [];
    server.clock.set("2026-07-02T00:30:00Z");
    expect(await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now())).toMatch(/inferred/);
    expect(prompts.some((p) => p.includes("Optique géométrique"))).toBe(true);
    expect(prompts.some((p) => p.includes("Jamais envoyé"))).toBe(false);
    const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
    expect(row).toMatchObject({ domainFr: "Optique", domainEn: "Optics" });
    // Made by no person, under the purpose `domain`.
    expect((await server.app.db.select().from(llmCalls).where(eq(llmCalls.purpose, "domain"))).some((c) => c.userId === null)).toBe(true);

    // The next night finds nothing to redo.
    prompts = [];
    server.clock.set("2026-07-03T00:30:00Z");
    await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now());
    expect(prompts.some((p) => p.includes("Optique géométrique"))).toBe(false);
  });

  it("stops before its share of the cap", async () => {
    await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { dailyCapUsd: 0.001 }, owner.id, server.clock.now());
    const pool = await newPool("Cap pool", { isPublic: true });
    await tag(await question(pool, "c"), "Plafond", "Cap");
    server.clock.set("2026-07-04T00:30:00Z");
    prompts = [];
    expect(await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now())).toMatch(/share of the cap is spent/);
    expect(prompts).toEqual([]);
    await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { dailyCapUsd: 20 }, owner.id, server.clock.now());
  });
});
