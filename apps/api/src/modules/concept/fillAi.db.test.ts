/**
 * `POST /admin/concepts/:id/fill` (ADR-081 §7, amendment of 2026-10-13,
 * #817), on PGlite with a fake LLM provider: admin only, the form's own
 * fields alone leave, only empty fields are proposed, a label that names
 * another concept comes back as `taken`, and nothing is written.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConceptFill, type ConceptFillRequest } from "@quiz/contracts";
import { CONCEPT_DESCRIPTION_MAX, qualifiedConceptKey } from "@quiz/domain";

import { loadConfig } from "../../config.js";
import { auditLog, concepts, llmCalls } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { LlmError, type LlmProvider } from "../llm/provider.js";
import { LlmGateway, writeSettings } from "../llm/service.js";

const SECRET = "test-llm-master-key-0123456789abcdef";

const empty = { label: "", qualifier: "", description: "" };
let reply: unknown = { fr: empty, en: empty };
let failure: LlmError | null = null;
let seen: { system: string; prompt: string }[] = [];
const fake: LlmProvider = {
  id: "anthropic",
  converse: () => Promise.reject(new Error("no conversation here")),
  async complete(req) {
    seen.push({ system: req.system, prompt: req.prompt });
    if (failure) throw failure;
    const parsed = req.schema.safeParse(reply);
    return { value: parsed.success ? parsed.data : null, model: req.model, inputTokens: 300, outputTokens: 80 } as never;
  },
};

let server: TestServer;
type Who = Awaited<ReturnType<TestServer["signIn"]>>;
let admin: Who;
let teacher: Who;
const db = () => server.app.db;
const fill = (who: Who, id: string, form: ConceptFillRequest) =>
  server.app.inject({ method: "POST", url: `/app/api/admin/concepts/${id}/fill`, headers: who.headers, payload: form });
const form = (fr: Partial<typeof empty>, en: Partial<typeof empty> = {}): ConceptFillRequest => ({
  fr: { ...empty, ...fr },
  en: { ...empty, ...en },
});

async function concept(fr: string | null, en: string | null, extra: { status?: "proposed" | "validated" | "merged"; mergedInto?: string; description?: string } = {}) {
  const id = randomUUID();
  await db()
    .insert(concepts)
    .values({
      id,
      status: extra.status ?? "proposed",
      mergedInto: extra.mergedInto ?? null,
      createdBy: teacher.id,
      labelFr: fr,
      keyFr: fr === null ? null : qualifiedConceptKey(fr, ""),
      labelEn: en,
      keyEn: en === null ? null : qualifiedConceptKey(en, ""),
      descriptionFr: extra.description ?? "",
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
  await db().delete(concepts);
  reply = { fr: empty, en: empty };
  failure = null;
  seen = [];
  server.clock.advance(61_000);
});

afterAll(() => server.close());

describe("POST /admin/concepts/:id/fill", () => {
  it("is the admin's alone", async () => {
    const id = await concept("Pointeur", null);
    expect((await fill(teacher, id, form({ label: "Pointeur" }))).statusCode).toBe(403);
    expect(
      (await server.app.inject({ method: "POST", url: `/app/api/admin/concepts/${id}/fill`, payload: form({ label: "Pointeur" }) })).statusCode,
    ).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("sends the form's fields only, and proposes only the empty ones, clamped, writing nothing but the call's log", async () => {
    const id = await concept("Pointeur", null, { description: "SECRET-STORED" });
    await concept("Tableau", "Array");
    reply = {
      fr: { label: "Ignored", qualifier: "", description: "Ignored too." },
      en: { label: " Pointer\n", qualifier: "", description: `A variable  holding\nan address. ${"x".repeat(600)}` },
    };
    const res = await fill(admin, id, form({ label: "Pointeur", description: "Variable qui contient une adresse." }));
    expect(res.statusCode, res.body).toBe(200);
    const body = ConceptFill.parse(res.json());
    expect(body.fr).toEqual({ label: null, taken: null, close: [], description: null });
    expect(body.en.label).toEqual({ label: "Pointer", qualifier: "" });
    expect(body.en.taken).toBeNull();
    expect(body.en.description).toMatch(/^A variable holding an address\. x+$/);
    expect(body.en.description).toHaveLength(CONCEPT_DESCRIPTION_MAX);

    const { prompt, system } = seen[0]!;
    expect(prompt).toContain("French label: Pointeur");
    expect(prompt).toContain("French description: Variable qui contient une adresse.");
    expect(prompt).toContain("Fields to fill: en.label, en.description");
    // Only the form leaves: neither what is stored, nor another concept, nor an id or a person.
    for (const secret of ["SECRET", "Tableau", "Array", id, teacher.id, admin.id]) {
      expect(prompt).not.toContain(secret);
      expect(system).not.toContain(secret);
    }

    const [row] = await db().select().from(concepts).where(eq(concepts.id, id));
    expect(row).toMatchObject({ labelEn: null, descriptionEn: "" });
    expect(await db().select().from(auditLog).where(eq(auditLog.subjectId, id))).toEqual([]);
    const calls = await db().select().from(llmCalls).where(eq(llmCalls.userId, admin.id));
    expect(calls.at(-1)).toMatchObject({ purpose: "concepts" });
  });

  it("answers a label that names another concept as taken, one only close as close", async () => {
    const id = await concept("Pointeur", null);
    const other = await concept("Zeiger", "Pointer", { status: "validated" });
    const near = await concept("Récursivité", "Recursion", { status: "validated" });
    reply = { fr: empty, en: { label: "Pointer", qualifier: "", description: "" } };
    const taken = ConceptFill.parse((await fill(admin, id, form({ label: "Pointeur", description: "d" }, { description: "d" }))).json());
    expect(taken.en.label).toEqual({ label: "Pointer", qualifier: "" });
    expect(taken.en.taken).toMatchObject({ id: other, label: "Pointer" });

    server.clock.advance(61_000);
    reply = { fr: empty, en: { label: "Recurson", qualifier: "", description: "" } };
    const close = ConceptFill.parse((await fill(admin, id, form({ label: "Pointeur", description: "d" }, { description: "d" }))).json());
    expect(close.en.taken).toBeNull();
    expect(close.en.close.map((c) => c.id)).toEqual([near]);
  });

  it("makes no call when nothing is empty, and refuses a form without a label or a merged concept", async () => {
    const id = await concept("Pointeur", "Pointer");
    const full = form({ label: "Pointeur", description: "a" }, { label: "Pointer", description: "b" });
    const res = await fill(admin, id, full);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fr: { label: null, description: null }, en: { label: null, description: null } });
    expect(seen).toHaveLength(0);

    expect((await fill(admin, id, form({}))).json()).toMatchObject({ error: "concept_label_missing" });
    const merged = await concept("Ancien", null, { status: "merged", mergedInto: id });
    expect((await fill(admin, merged, form({ label: "Ancien" }))).statusCode).toBe(409);
    expect((await fill(admin, randomUUID(), form({ label: "X" }))).statusCode).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("words the gateway's refusals like every other purpose's", async () => {
    const id = await concept("Pointeur", null);
    failure = new LlmError("budget_exhausted");
    const res = await fill(admin, id, form({ label: "Pointeur" }));
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "llm_budget_exhausted" });
  });
});
