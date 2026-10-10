/**
 * `POST /admin/concepts/duplicates/ai` (ADR-081 fifth addendum §4, PR4b), on
 * PGlite with a fake LLM provider: admin only, labels and qualifiers alone
 * leave, the reply is validated strictly, nothing is written, the gateway's
 * refusals are worded like every other purpose's.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConceptDuplicatesAi } from "@quiz/contracts";
import { qualifiedConceptKey } from "@quiz/domain";

import { loadConfig } from "../../config.js";
import { auditLog, conceptAliases, concepts, llmCalls } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { LlmError, type LlmProvider } from "../llm/provider.js";
import { LlmGateway, writeSettings } from "../llm/service.js";

const SECRET = "test-llm-master-key-0123456789abcdef";
const URL = "/app/api/admin/concepts/duplicates/ai";

let reply: unknown = { pairs: [] };
let failure: LlmError | null = null;
let seen: { system: string; prompt: string; model: string }[] = [];
const fake: LlmProvider = {
  id: "anthropic",
  converse: () => Promise.reject(new Error("no conversation here")),
  async complete(req) {
    seen.push({ system: req.system, prompt: req.prompt, model: req.model });
    if (failure) throw failure;
    const parsed = req.schema.safeParse(reply);
    return { value: parsed.success ? parsed.data : null, model: req.model, inputTokens: 900, outputTokens: 80 } as never;
  },
};

let server: TestServer;
type Who = Awaited<ReturnType<TestServer["signIn"]>>;
let admin: Who;
let teacher: Who;
const db = () => server.app.db;
const ask = (who: Who) => server.app.inject({ method: "POST", url: URL, headers: who.headers });

async function concept(
  fr: string | null,
  en: string | null,
  extra: { qualifierFr?: string; description?: string; status?: "proposed" | "validated" | "merged"; mergedInto?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db()
    .insert(concepts)
    .values({
      id,
      status: extra.status ?? "validated",
      mergedInto: extra.mergedInto ?? null,
      createdBy: teacher.id,
      labelFr: fr,
      keyFr: fr === null ? null : qualifiedConceptKey(fr, extra.qualifierFr ?? ""),
      qualifierFr: extra.qualifierFr ?? "",
      labelEn: en,
      keyEn: en === null ? null : qualifiedConceptKey(en, ""),
      descriptionFr: extra.description ?? "",
      descriptionEn: extra.description ?? "",
    });
  return id;
}

beforeAll(async () => {
  const env = { LLM_KEY_SECRET: SECRET };
  server = await testServer(env);
  server.app.llmGateway = new LlmGateway({
    db: db(),
    clock: server.clock,
    config: loadConfig({ NODE_ENV: "test", ...env }),
    provider: fake,
  });
  admin = await server.signIn("admin");
  teacher = await server.signIn("teacher");
  await writeSettings(db(), { LLM_KEY_SECRET: SECRET }, { apiKey: "sk-ant-api03-test-0123456789" }, admin.id, server.clock.now());
});

beforeEach(async () => {
  await db().delete(conceptAliases);
  await db().delete(concepts);
  reply = { pairs: [] };
  failure = null;
  seen = [];
  server.clock.advance(61_000);
});

afterAll(() => server.close());

describe("POST /admin/concepts/duplicates/ai", () => {
  it("is the admin's alone", async () => {
    expect((await ask(teacher)).statusCode).toBe(403);
    expect((await server.app.inject({ method: "POST", url: URL })).statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("sends labels and qualifiers only, never a description, an alias, an id or a name", async () => {
    const a = await concept("Adresse", "Address", { qualifierFr: "mémoire", description: "SECRET-DESCRIPTION" });
    await concept("Pointeur", "Pointer");
    await concept("Fusionné", "Merged away", { status: "merged", mergedInto: a });
    await db().insert(conceptAliases).values({ conceptId: a, key: "secretalias", text: "SECRET-ALIAS" });

    const res = await ask(admin);
    expect(res.statusCode, res.body).toBe(200);
    const prompt = seen[0]!.prompt;
    expect(prompt.split("\n")).toEqual(["c1 | fr: Adresse (mémoire) | en: Address", "c2 | fr: Pointeur | en: Pointer"]);
    for (const secret of ["SECRET", "Merged away", a, teacher.id, admin.id]) expect(prompt).not.toContain(secret);
    expect(seen[0]!.system).not.toContain("SECRET");
  });

  it("answers the validated pairs, once each, and writes nothing but the call's log", async () => {
    const a = await concept("Pointeur", "Pointer");
    const b = await concept("Référence", "Reference");
    const c = await concept("Tableau", "Array");
    reply = {
      pairs: [
        { a: "c1", b: "c2", reason: "  Both name a\n variable that points elsewhere. " },
        { a: "c2", b: "c1", reason: "the same pair reversed" },
        { a: "c3", b: "c3", reason: "itself" },
        { a: "c4", b: "c1", reason: "an index never sent" },
        { a: "x1", b: "c1", reason: "not an index" },
        { a: "c3", b: "c1", reason: "" },
        { a: "c3", b: "c2", reason: "r".repeat(500) },
      ],
    };
    const before = await db().select().from(concepts);
    const callsBefore = (await db().select().from(llmCalls).where(eq(llmCalls.purpose, "concepts"))).length;
    const res = await ask(admin);
    expect(res.statusCode, res.body).toBe(200);
    const { pairs } = ConceptDuplicatesAi.parse(res.json());
    // The prompt orders by creation then id: map each index back to its id.
    const order = [...before].sort((x, y) => (x.createdAt.getTime() - y.createdAt.getTime()) || (x.id < y.id ? -1 : 1)).map((r) => r.id);
    expect([a, b, c].sort()).toEqual([...order].sort());
    const [i1, i2, i3] = order as [string, string, string];
    expect(pairs).toEqual([
      { a: i1, b: i2, reason: "Both name a variable that points elsewhere." },
      { a: i2, b: i3, reason: "r".repeat(200) },
    ]);
    expect(await db().select().from(concepts)).toEqual(before);
    expect(await db().select().from(auditLog).where(eq(auditLog.action, "concept.merge"))).toHaveLength(0);
    const calls = await db().select().from(llmCalls).where(eq(llmCalls.purpose, "concepts"));
    expect(calls).toHaveLength(callsBefore + 1);
    expect(calls.at(-1)).toMatchObject({ userId: admin.id });
  });

  it("makes no call for a vocabulary of fewer than two concepts", async () => {
    await concept("Seul", "Alone");
    const res = await ask(admin);
    expect(res.json()).toEqual({ pairs: [] });
    expect(seen).toHaveLength(0);
  });

  it("treats an unreadable reply as a failed call", async () => {
    await concept("Un", "One");
    await concept("Deux", "Two");
    reply = { nonsense: true };
    const res = await ask(admin);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "llm_failed" });
  });

  it("is refused like every purpose when the budget is spent or the gateway is not configured", async () => {
    await concept("Un", "One");
    await concept("Deux", "Two");
    failure = new LlmError("budget_exhausted");
    const spent = await ask(admin);
    expect(spent.statusCode).toBe(429);
    expect(spent.json()).toMatchObject({ error: "llm_budget_exhausted" });

    const gateway = server.app.llmGateway;
    server.app.llmGateway = new LlmGateway({
      db: db(),
      clock: server.clock,
      config: loadConfig({ NODE_ENV: "test" }),
      provider: fake,
    });
    try {
      server.clock.advance(61_000);
      const off = await ask(admin);
      expect(off.statusCode).toBe(409);
      expect(off.json()).toMatchObject({ error: "llm_not_configured" });
    } finally {
      server.app.llmGateway = gateway;
    }
  });

  it("uses the default model (no purpose of its own in the settings)", async () => {
    await concept("Un", "One");
    await concept("Deux", "Two");
    await ask(admin);
    expect(seen[0]!.model).toBe("claude-sonnet-5-5");
  });
});
