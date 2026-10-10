/**
 * Derived visibility, publication and the pool description (issue #680,
 * lot 1; ADR-013, amendment of 2026-10-10), on a real application over
 * PGlite with a fake LLM provider: each branch of the derivation, publish
 * and unpublish with their audit rows, the personal pool refused, the role a
 * public pool no longer offers, and the description (owner only, 280
 * characters, the AI's proposal written only when the owner accepts it).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PoolMembers, PoolSummary, type ParametersDraft } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import { auditLog, coursePools, courses, courseStaff, llmCalls, pools } from "../../db/schema.js";
import { EXPLANATION, PARAMETERIZED, VARIABLES } from "../../test/parameterized.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import type { LlmProvider } from "../llm/provider.js";
import { LlmGateway, writeSettings } from "../llm/service.js";

const SECRET = "test-llm-master-key-0123456789abcdef";

let proposal = "Trois notions de pointeurs en C.";
let prompts: string[] = [];
const fake: LlmProvider = {
  id: "anthropic",
  converse: () => Promise.reject(new Error("no conversation here")),
  async complete(req) {
    prompts.push(req.prompt);
    return { value: { description: proposal }, model: "claude-sonnet-5-5", inputTokens: 500, outputTokens: 60 } as never;
  },
};

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let owner: Actor;
let colleague: Actor;
let stranger: Actor;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const call = (who: Actor, method: Method, url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

async function newPool(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call(owner, "POST", "/app/api/pools", { name, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

const visibilityOf = async (id: string, who = owner) =>
  PoolSummary.array()
    .parse((await call(who, "GET", "/app/api/pools")).json())
    .find((p) => p.id === id)?.visibility;

async function linkedCourse(pool: string, staff: string[]): Promise<string> {
  const db = server.app.db;
  const courseId = crypto.randomUUID();
  await db.insert(courses).values({ id: courseId, name: "Linked", code: `V${courseId.slice(0, 8)}` });
  await db.insert(courseStaff).values(staff.map((userId) => ({ courseId, userId })));
  await db.insert(coursePools).values({ courseId, poolId: pool });
  return courseId;
}

const auditActions = async (pool: string) =>
  (await server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectType, "pool"), eq(auditLog.subjectId, pool)))).map(
    (r) => r.action,
  );

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

async function publishedOf(
  pool: string,
  type: string,
  config: unknown,
  extra: { explanation?: string; variables?: ParametersDraft | null } = {},
): Promise<void> {
  const id = (await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type, internalName: `SECRET-INTERNAL-NAME-${Math.random()}` })).json<{
    meta: { id: string };
  }>().meta.id;
  const draft = await call(owner, "PUT", `/app/api/questions/${id}/draft`, { config, explanation: "", ...extra });
  expect(draft.statusCode).toBe(200);
  expect((await call(owner, "POST", `/app/api/questions/${id}/publish`, {})).statusCode).toBe(201);
}

const publishedQuestion = (pool: string, prompt: string) => publishedOf(pool, "mcq", mcq(prompt));

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
  colleague = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { apiKey: "sk-ant-api03-test-0123456789" }, owner.id, server.clock.now());
});

afterAll(() => server.close());

describe("derived visibility", () => {
  it("is private for a pool nobody else reaches", async () => {
    expect(await visibilityOf(await newPool("Alone"))).toBe("private");
  });

  it("is shared once a member holds a seat, private again when the seat goes", async () => {
    const id = await newPool("Seated");
    expect((await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: colleague.id, role: "contributor" })).statusCode).toBe(201);
    expect(await visibilityOf(id)).toBe("shared");
    expect((await call(owner, "DELETE", `/app/api/pools/${id}/members/${colleague.id}`)).statusCode).toBe(204);
    expect(await visibilityOf(id)).toBe("private");
  });

  it("is shared through a linked course with staff other than the owner", async () => {
    const id = await newPool("Course shared");
    await linkedCourse(id, [owner.id, colleague.id]);
    expect(await visibilityOf(id)).toBe("shared");
  });

  it("stays private when linked only to the owner's own course", async () => {
    const id = await newPool("Own course");
    await linkedCourse(id, [owner.id]);
    expect(await visibilityOf(id)).toBe("private");
  });

  it("is public when published, whatever the roster", async () => {
    const id = await newPool("Open", { isPublic: true });
    expect(await visibilityOf(id)).toBe("public");
    expect(await visibilityOf(id, stranger)).toBe("public");
  });

  it("sorts and lists the same derived value in the pool detail", async () => {
    const id = await newPool("Detail");
    await linkedCourse(id, [owner.id, colleague.id]);
    expect((await call(owner, "GET", `/app/api/pools/${id}`)).json().pool.visibility).toBe("shared");
  });
});

describe("publishing", () => {
  it("publishes and unpublishes, audited as such, without touching the roster", async () => {
    const id = await newPool("Toggle");
    expect((await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: colleague.id, role: "contributor" })).statusCode).toBe(201);
    const on = await call(owner, "PATCH", `/app/api/pools/${id}`, { isPublic: true });
    expect(on.json()).toMatchObject({ isPublic: true, visibility: "public" });
    // Publishing again is not a second publication.
    await call(owner, "PATCH", `/app/api/pools/${id}`, { isPublic: true });
    const off = await call(owner, "PATCH", `/app/api/pools/${id}`, { isPublic: false });
    expect(off.json()).toMatchObject({ isPublic: false, visibility: "shared" });
    const actions = await auditActions(id);
    expect(actions.filter((a) => a === "pool.publish")).toHaveLength(1);
    expect(actions.filter((a) => a === "pool.unpublish")).toHaveLength(1);
    const members = PoolMembers.parse((await call(owner, "GET", `/app/api/pools/${id}/members`)).json());
    expect(members.members.map((m) => m.userId)).toContain(colleague.id);
  });

  it("is the owner's: a contributor is refused", async () => {
    const id = await newPool("Owner only");
    await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: colleague.id, role: "contributor" });
    expect((await call(colleague, "PATCH", `/app/api/pools/${id}`, { isPublic: true })).statusCode).toBe(403);
  });

  it("refuses to publish the personal pool", async () => {
    const db = server.app.db;
    const id = crypto.randomUUID();
    await db.insert(pools).values({ id, name: "Polls", ownerId: owner.id, isPersonal: true });
    const res = await call(owner, "PATCH", `/app/api/pools/${id}`, { isPublic: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "personal_pool_not_publishable" });
  });

  it("offers contributor and owner only on a public pool, and keeps the reader rows", async () => {
    const id = await newPool("Public roles");
    await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: colleague.id, role: "reader" });
    await call(owner, "PATCH", `/app/api/pools/${id}`, { isPublic: true });
    const refused = await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: stranger.id, role: "reader" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "role_covered_by_public" });
    expect((await call(owner, "PATCH", `/app/api/pools/${id}/members/${colleague.id}`, { role: "reader" })).statusCode).toBe(409);
    expect((await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: stranger.id, role: "contributor" })).statusCode).toBe(201);
    const members = PoolMembers.parse((await call(owner, "GET", `/app/api/pools/${id}/members`)).json());
    expect(members.members.find((m) => m.userId === colleague.id)?.role).toBe("reader");
  });

  it("lists the linked courses to an owner of the pool only", async () => {
    const id = await newPool("Courses shown");
    await linkedCourse(id, [owner.id, colleague.id]);
    await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: stranger.id, role: "reader" });
    expect(PoolMembers.parse((await call(owner, "GET", `/app/api/pools/${id}/members`)).json()).courses).toHaveLength(1);
    expect(PoolMembers.parse((await call(stranger, "GET", `/app/api/pools/${id}/members`)).json()).courses).toHaveLength(0);
  });
});

describe("description", () => {
  it("is the owner's, at most 280 characters", async () => {
    const id = await newPool("Described");
    await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: colleague.id, role: "contributor" });
    expect((await call(colleague, "PATCH", `/app/api/pools/${id}`, { description: "Mine now" })).statusCode).toBe(403);
    expect((await call(owner, "PATCH", `/app/api/pools/${id}`, { description: "x".repeat(281) })).statusCode).toBe(400);
    const ok = await call(owner, "PATCH", `/app/api/pools/${id}`, { description: "x".repeat(280) });
    expect(ok.json()).toMatchObject({ descriptionSource: "owner" });
    expect(ok.json().description).toHaveLength(280);
  });

  it("writes nothing when the AI proposes, and sends only the name, concepts and two excerpts", async () => {
    const id = await newPool("Pointeurs");
    for (const n of [1, 2, 3]) await publishedQuestion(id, `Énoncé numéro ${n} sur les pointeurs ?`);
    prompts = [];
    server.clock.advance(61_000);
    const res = await call(owner, "POST", `/app/api/pools/${id}/description/propose`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ description: proposal });
    expect(prompts[0]).toContain("Pointeurs");
    expect(prompts[0]).not.toContain("SECRET-INTERNAL-NAME");
    expect(prompts[0]!.match(/Énoncé numéro/g)).toHaveLength(2);
    const [row] = await server.app.db.select().from(pools).where(eq(pools.id, id));
    expect(row).toMatchObject({ description: "", descriptionSource: "owner" });
    const [call1] = await server.app.db.select().from(llmCalls).where(eq(llmCalls.purpose, "describe")).limit(1);
    expect(call1).toBeDefined();
  });

  it("never sends an answer key, an explanation, an internal name or a parameterized template", async () => {
    const id = await newPool("Clés");
    await publishedOf(id, "short", {
      configVersion: 3,
      prompt: "Quelle est la couleur du ciel ?",
      kind: "text",
      matchers: [{ kind: "exact", value: "SECRET-KEY-ANSWER" }],
    }, { explanation: "SECRET-EXPLANATION" });
    await publishedOf(id, "cloze", { configVersion: 2, text: "Le ciel est {{SECRET-BLANK}} par temps clair." });
    await publishedOf(id, "short", PARAMETERIZED.short, { explanation: EXPLANATION, variables: VARIABLES });
    prompts = [];
    server.clock.advance(61_000);
    expect((await call(owner, "POST", `/app/api/pools/${id}/description/propose`)).statusCode).toBe(200);
    const prompt = prompts[0]!;
    expect(prompt).toContain("couleur du ciel");
    for (const forbidden of ["SECRET-KEY-ANSWER", "SECRET-EXPLANATION", "SECRET-BLANK", "SECRET-INTERNAL-NAME", "[[", "randint", "sqrt("]) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it("has no excerpt for a parameterized question: a pool of only those is refused", async () => {
    const id = await newPool("Paramétrées");
    await publishedOf(id, "short", PARAMETERIZED.short, { explanation: EXPLANATION, variables: VARIABLES });
    prompts = [];
    server.clock.advance(61_000);
    const res = await call(owner, "POST", `/app/api/pools/${id}/description/propose`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "pool_empty" });
    expect(prompts).toHaveLength(0);
  });

  it("is written, as an AI description, only by the owner's acceptance", async () => {
    const id = await newPool("Accepted");
    await publishedQuestion(id, "Combien font 2 + 2 ?");
    server.clock.advance(61_000);
    const text = (await call(owner, "POST", `/app/api/pools/${id}/description/propose`)).json<{ description: string }>().description;
    const accepted = await call(owner, "PATCH", `/app/api/pools/${id}`, { description: text, descriptionFromAi: true });
    expect(accepted.json()).toMatchObject({ description: text, descriptionSource: "ai" });
    expect(await auditActions(id)).toContain("pool.update");
    // The owner editing it by hand makes it theirs.
    const edited = await call(owner, "PATCH", `/app/api/pools/${id}`, { description: "Mes mots." });
    expect(edited.json()).toMatchObject({ descriptionSource: "owner" });
  });

  it("never proposes over the owner's own text, and asks no model", async () => {
    const id = await newPool("Owned");
    await publishedQuestion(id, "Combien font 2 + 2 ?");
    await call(owner, "PATCH", `/app/api/pools/${id}`, { description: "Écrit à la main." });
    prompts = [];
    server.clock.advance(61_000);
    const res = await call(owner, "POST", `/app/api/pools/${id}/description/propose`);
    expect(res.statusCode).toBe(409);
    expect(prompts).toHaveLength(0);
    expect(res.json()).toMatchObject({ error: "description_owned" });
    const [row] = await server.app.db.select().from(pools).where(eq(pools.id, id));
    expect(row!.description).toBe("Écrit à la main.");
  });

  it("refuses to propose for an empty pool and for a non-owner", async () => {
    const id = await newPool("Empty");
    server.clock.advance(61_000);
    expect((await call(owner, "POST", `/app/api/pools/${id}/description/propose`)).statusCode).toBe(409);
    await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: colleague.id, role: "contributor" });
    expect((await call(colleague, "POST", `/app/api/pools/${id}/description/propose`)).statusCode).toBe(403);
    expect((await call(stranger, "POST", `/app/api/pools/${id}/description/propose`)).statusCode).toBe(404);
  });
});
