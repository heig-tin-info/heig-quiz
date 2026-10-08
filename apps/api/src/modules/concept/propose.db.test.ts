/**
 * The model pass that proposes the sorting of the existing tags (ADR-081,
 * second addendum §3) over the real application, with a fake provider in
 * place of Anthropic: proposals for the undecided pairs only, an accepted
 * pair untouched, an unknown concept dropped, a later batch mapped onto an
 * earlier new concept, the run's failures, one run at a time, the admin
 * role alone, and what the prompt never carries.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ConceptSortRunStatus, TagSortingProposal, type ConceptSortRun } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import {
  auditLog,
  classrooms,
  concepts,
  conceptSortRuns,
  conceptTagSortings,
  coursePools,
  courses,
  llmCalls,
  pools,
  poolTags,
  questionTags,
  users,
} from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { publishQuestion } from "../../test/live.js";
import { LlmError, type LlmProvider, type ProviderRequest } from "../llm/provider.js";
import { LlmGateway, writeSettings } from "../llm/service.js";
import { SORT_BATCH, SORT_LEASE_MS } from "./propose.js";

const SECRET = "test-llm-master-key-0123456789abcdef";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;
type Reply = { pairs: Record<string, unknown>[]; newConcepts: Record<string, unknown>[] };

/** What the fake answers for one request; the prompts it was sent. */
let answer: (req: ProviderRequest<unknown>, call: number) => Reply | Promise<Reply>;
const seen: ProviderRequest<unknown>[] = [];
const fake: LlmProvider = {
  id: "anthropic",
  converse: () => Promise.reject(new Error("no conversation here")),
  async complete(req) {
    seen.push(req as ProviderRequest<unknown>);
    const value = await answer(req as ProviderRequest<unknown>, seen.length);
    return { value, model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } as never;
  },
};

let server: TestServer;
let teacher: Who;
let admin: Who;
let alpha: string;
let beta: string;

const call = (who: Who, method: "GET" | "POST", url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });
const start = (who: Who = admin) => call(who, "POST", "/app/api/admin/concept-sorting/propose");

async function run(): Promise<ConceptSortRun | null> {
  const res = await call(admin, "GET", "/app/api/admin/concept-sorting/run");
  expect(res.statusCode, res.body).toBe(200);
  return ConceptSortRunStatus.parse(res.json()).run;
}

/** The run, once it has stopped running. */
const finished = () =>
  vi.waitFor(
    async () => {
      const r = await run();
      if (r?.state === "running") throw new Error("still running");
      return r!;
    },
    { timeout: 5_000, interval: 10 },
  );

/** The tags of one prompt: `pool name/tag` → the handle the model must answer with. */
function handlesOf(prompt: string): Map<string, string> {
  const out = new Map<string, string>();
  const section = prompt.split("Tags to sort, by group:\n")[1] ?? "";
  for (const line of section.split("\n").filter(Boolean)) {
    const group = JSON.parse(line) as { tags: { handle: string; tag: string; pool: string }[] };
    for (const t of group.tags) out.set(`${t.pool}/${t.tag}`, t.handle);
  }
  return out;
}

/** The handle of the first concept line of the prompt whose JSON contains `label`. */
function conceptHandle(prompt: string, label: string): string | undefined {
  const line = prompt.split("\n").find((l) => l.startsWith('{"handle":"') && l.includes(`"label":"${label}"`));
  return line ? (JSON.parse(line) as { handle: string }).handle : undefined;
}

const verdict = (id: string, v: { concept?: string; drop?: string; note?: string }) => ({
  id,
  concept: v.concept ?? null,
  drop: v.drop ?? null,
  broader: null,
  note: v.note ?? null,
});

async function pool(name: string): Promise<string> {
  const id = randomUUID();
  await server.app.db.insert(pools).values({ id, name, ownerId: teacher.id });
  return id;
}

/** A real `short` question: its expected answer and internal name are what the prompt must never carry. */
async function question(poolId: string, name: string, tags: string[]): Promise<string> {
  const db = server.app.db;
  const id = await publishQuestion(db, poolId, teacher.id, `SECRET-${name}`, {
    type: "short",
    config: {
      configVersion: 3,
      prompt: `Statement of ${name}: what does *p yield?`,
      kind: "text",
      matchers: [{ kind: "exact", value: `KEY-${name}` }],
    },
  });
  await db.insert(questionTags).values(tags.map((tag) => ({ questionId: id, tag })));
  await db
    .insert(poolTags)
    .values(tags.map((tag) => ({ poolId, tag })))
    .onConflictDoNothing();
  return id;
}

const sortingOf = async (poolId: string, tag: string) =>
  (
    await server.app.db
      .select()
      .from(conceptTagSortings)
      .where(and(eq(conceptTagSortings.poolId, poolId), eq(conceptTagSortings.tag, tag)))
  )[0];

beforeAll(async () => {
  const env = { LLM_KEY_SECRET: SECRET };
  server = await testServer(env);
  server.app.llmGateway = new LlmGateway({
    db: server.app.db,
    clock: server.clock,
    config: loadConfig({ NODE_ENV: "test", ...env }),
    provider: fake,
  });
  teacher = await server.signIn("teacher");
  admin = await server.signIn("admin");
  const db = server.app.db;
  await db.update(users).set({ givenName: "AUTHORGIVEN", familyName: "AUTHORFAMILY" }).where(eq(users.id, teacher.id));
  alpha = await pool("Alpha");
  beta = await pool("Beta");
  await question(alpha, "one", ["pointeur", "boucle"]);
  await question(alpha, "two", ["pointeur", "semaine3"]);
  await question(beta, "three", ["pointeurs", "recursion", "typo-xyz"]);
  // A course and a classroom that use the pools: their names must never leave.
  const course = randomUUID();
  await db.insert(courses).values({ id: course, name: "COURSENAME", code: "CRS-SECRET" });
  await db.insert(classrooms).values({ id: randomUUID(), courseId: course, name: "CLASSROOMNAME" });
  await db.insert(coursePools).values([
    { courseId: course, poolId: alpha },
    { courseId: course, poolId: beta },
  ]);
});

beforeEach(async () => {
  server.clock.advance(SORT_LEASE_MS + 1_000);
  seen.length = 0;
  await server.app.db.delete(conceptTagSortings);
  await server.app.db.delete(concepts);
});

afterAll(async () => {
  await server?.close();
});

describe("starting a run", () => {
  it("is refused 409 llm_not_configured without a key, and is the admin's alone", async () => {
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "llm_not_configured" });
    expect(await run()).toBeNull();

    await writeSettings(
      server.app.db,
      { LLM_KEY_SECRET: SECRET },
      { apiKey: "sk-ant-api03-test-0123456789" },
      admin.id,
      server.clock.now(),
    );
    expect((await start(teacher)).statusCode).toBe(403);
    expect((await call(teacher, "GET", "/app/api/admin/concept-sorting/run")).statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe("the pass", () => {
  it("proposes for the undecided pairs only, drops an unknown concept, never touches an accepted row", async () => {
    const res = await call(teacher, "POST", "/app/api/concepts", {
      lang: "fr",
      label: "Pointeur",
      description: "Une adresse typée.",
    });
    expect(res.statusCode, res.body).toBe(201);
    const pointer = res.json<{ id: string }>().id;
    // An accepted pair: decided by hand, not to be touched.
    const decidedAt = new Date("2026-10-01T10:00:00Z");
    await server.app.db
      .insert(conceptTagSortings)
      .values({ poolId: alpha, tag: "boucle", decision: "drop", dropReason: "noise", decidedBy: admin.id, decidedAt });
    // A proposal of an earlier run, replaced by this one.
    await server.app.db
      .insert(conceptTagSortings)
      .values({ poolId: alpha, tag: "semaine3", proposal: { model: "old", kind: "drop", dropReason: "noise" } });

    answer = (req) => {
      const h = handlesOf(req.prompt);
      const c = conceptHandle(req.prompt, "Pointeur")!;
      return {
        pairs: [
          verdict(h.get("Alpha/pointeur")!, { concept: c, note: "same word" }),
          verdict(h.get("Beta/pointeurs")!, { concept: c }),
          verdict(h.get("Alpha/semaine3")!, { drop: "organisational" }),
          verdict(h.get("Beta/recursion")!, { concept: "x1" }),
          verdict(h.get("Beta/typo-xyz")!, { concept: "c99" }),
        ],
        newConcepts: [
          {
            id: "x1",
            fr: { label: "Récursivité", qualifier: "", description: "Une fonction qui s'appelle." },
            en: { label: "Recursion", qualifier: "", description: "A function calling itself." },
          },
        ],
      };
    };
    const started = await start();
    expect(started.statusCode, started.body).toBe(202);
    expect(ConceptSortRunStatus.parse(started.json()).run).toMatchObject({ state: "running" });
    const done = await finished();
    expect(done).toMatchObject({ state: "done", error: null, groupsTotal: 4, groupsDone: 4, batchesFailed: 0 });
    expect(done.finishedAt).not.toBeNull();

    expect(seen).toHaveLength(1);
    expect(handlesOf(seen[0]!.prompt).has("Alpha/boucle")).toBe(false);

    const proposal = async (poolId: string, tag: string) =>
      TagSortingProposal.parse((await sortingOf(poolId, tag))!.proposal);
    expect(await proposal(alpha, "pointeur")).toEqual({
      model: "claude-sonnet-5-5",
      kind: "concept",
      conceptId: pointer,
      note: "same word",
    });
    expect(await proposal(beta, "pointeurs")).toMatchObject({ kind: "concept", conceptId: pointer });
    expect(await proposal(alpha, "semaine3")).toEqual({
      model: "claude-sonnet-5-5",
      kind: "drop",
      dropReason: "organisational",
    });
    expect(await proposal(beta, "recursion")).toMatchObject({
      kind: "new",
      newConcept: {
        fr: { label: "Récursivité" },
        en: { label: "Recursion", description: "A function calling itself." },
      },
    });
    expect(await sortingOf(beta, "typo-xyz")).toBeUndefined();
    const boucle = (await sortingOf(alpha, "boucle"))!;
    expect(boucle).toMatchObject({ decision: "drop", dropReason: "noise", proposal: null, decidedBy: admin.id });
    expect(boucle.decidedAt).toEqual(decidedAt);
    for (const row of await server.app.db.select().from(conceptTagSortings)) {
      if (row.decision === null) expect(row.decidedBy).toBeNull();
    }

    // Billed to the admin, under its own purpose; the start audited.
    const calls = await server.app.db.select().from(llmCalls).where(eq(llmCalls.purpose, "sort"));
    expect(calls.every((c) => c.userId === admin.id && c.status === "ok")).toBe(true);
    const audits = await server.app.db.select().from(auditLog).where(eq(auditLog.action, "concept.sort_propose"));
    expect(audits.at(-1)).toMatchObject({
      actorUserId: admin.id,
      subjectType: "concept_sort_run",
      subjectId: "default",
    });
  });

  it("sends excerpts and the registry, never a key, an internal name, an id, an author, a course or a classroom", async () => {
    await call(teacher, "POST", "/app/api/concepts", { lang: "fr", label: "Pointeur" });
    answer = () => ({ pairs: [], newConcepts: [] });
    expect((await start()).statusCode).toBe(202);
    await finished();
    const sent = seen.map((r) => `${r.system}\n${r.prompt}`).join("\n");
    expect(sent).toContain("Statement of one: what does *p yield?");
    expect(sent).toContain('"pool":"Alpha"');
    expect(sent).toContain('"label":"Pointeur"');
    for (const secret of [
      "KEY-",
      "SECRET-",
      "AUTHORGIVEN",
      "AUTHORFAMILY",
      "COURSENAME",
      "CRS-SECRET",
      "CLASSROOMNAME",
      alpha,
      beta,
      teacher.id,
    ]) {
      expect(sent).not.toContain(secret);
    }
    const [concept] = await server.app.db.select().from(concepts);
    expect(sent).not.toContain(concept!.id);
  });

  it("maps a later batch onto a new concept proposed by an earlier one, with the same labels", async () => {
    const gamma = await pool("Gamma");
    // More groups than one batch takes: the stack tag worn twice comes first, the other one last.
    const fillers = Array.from({ length: SORT_BATCH.groups }, (_, i) => `filler-${String(i).padStart(2, "0")}`);
    await question(gamma, "g1", ["stack-early", ...fillers]);
    await question(gamma, "g2", ["stack-early", "zz-stack-late"]);
    const stack = {
      fr: { label: "Pile", qualifier: "", description: "" },
      en: { label: "Stack", qualifier: "", description: "" },
    };
    answer = (req) => {
      const h = handlesOf(req.prompt);
      const early = h.get("Gamma/stack-early");
      const late = h.get("Gamma/zz-stack-late");
      if (early) return { pairs: [verdict(early, { concept: "x1" })], newConcepts: [{ id: "x1", ...stack }] };
      if (late) {
        // The earlier proposal is offered under its run handle.
        const n = conceptHandle(req.prompt, "Pile");
        expect(n).toBe("n1");
        return { pairs: [verdict(late, { concept: n! })], newConcepts: [] };
      }
      return { pairs: [], newConcepts: [] };
    };
    expect((await start()).statusCode).toBe(202);
    expect(await finished()).toMatchObject({ state: "done" });
    expect(seen.length).toBeGreaterThan(1);
    const early = TagSortingProposal.parse((await sortingOf(gamma, "stack-early"))!.proposal);
    const late = TagSortingProposal.parse((await sortingOf(gamma, "zz-stack-late"))!.proposal);
    expect(early).toMatchObject({ kind: "new", newConcept: stack });
    if (early.kind !== "new" || late.kind !== "new") throw new Error("expected two new-concept proposals");
    expect(late.newConcept).toEqual(early.newConcept);

    // Accepting both creates ONE concept.
    const res = await call(admin, "POST", "/app/api/admin/concept-sorting/accept", {
      items: [
        { poolId: gamma, tag: "stack-early", decision: { kind: "new", ...early.newConcept } },
        { poolId: gamma, tag: "zz-stack-late", decision: { kind: "new", ...late.newConcept } },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ created: unknown[] }>().created).toHaveLength(1);
    await server.app.db.delete(pools).where(eq(pools.id, gamma));
  });

  it("leaves a failed batch's pairs as they were and goes on", async () => {
    await server.app.db
      .insert(conceptTagSortings)
      .values({ poolId: alpha, tag: "semaine3", proposal: { model: "old", kind: "drop", dropReason: "noise" } });
    answer = () => {
      throw new LlmError("timeout");
    };
    expect((await start()).statusCode).toBe(202);
    expect(await finished()).toMatchObject({ state: "done", error: null, batchesFailed: 1 });
    expect((await sortingOf(alpha, "semaine3"))!.proposal).toMatchObject({ model: "old" });
  });

  it("drops a proposal whose concept was merged during the call", async () => {
    const make = async (label: string) => {
      const res = await call(teacher, "POST", "/app/api/concepts", { lang: "fr", label });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    };
    const merged = await make("Pointeur");
    const survivor = await make("Adresse");
    answer = async (req) => {
      await server.app.db
        .update(concepts)
        .set({ status: "merged", mergedInto: survivor })
        .where(eq(concepts.id, merged));
      const h = handlesOf(req.prompt);
      return {
        pairs: [
          verdict(h.get("Alpha/pointeur")!, { concept: conceptHandle(req.prompt, "Pointeur")! }),
          verdict(h.get("Alpha/semaine3")!, { drop: "organisational" }),
        ],
        newConcepts: [],
      };
    };
    expect((await start()).statusCode).toBe(202);
    expect(await finished()).toMatchObject({ state: "done" });
    expect(await sortingOf(alpha, "pointeur")).toBeUndefined();
    expect((await sortingOf(alpha, "semaine3"))!.proposal).toMatchObject({ kind: "drop" });
  });

  it("stops as failed on budget_exhausted", async () => {
    answer = () => {
      throw new LlmError("budget_exhausted");
    };
    expect((await start()).statusCode).toBe(202);
    expect(await finished()).toMatchObject({ state: "failed", error: "budget_exhausted", groupsDone: 0 });
    expect(await server.app.db.select().from(conceptTagSortings)).toEqual([]);
  });
});

describe("one run at a time", () => {
  it("refuses a second start while a run is alive, and lets a silent one be replaced", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // The old pass's answer, once it wakes up: a proposal it must not write.
    answer = async (req) => {
      await gate;
      return { pairs: [verdict(handlesOf(req.prompt).get("Alpha/semaine3")!, { drop: "noise" })], newConcepts: [] };
    };
    expect((await start()).statusCode).toBe(202);
    await vi.waitFor(() => expect(seen.length).toBe(1));
    const second = await start();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "concept_sort_running" });
    expect(await run()).toMatchObject({ state: "running" });

    // Its process died, say: once its heartbeat is old enough, it reads as interrupted and a start replaces it.
    server.clock.advance(SORT_LEASE_MS + 1_000);
    expect(await run()).toMatchObject({ state: "failed", error: "interrupted" });
    answer = () => ({ pairs: [], newConcepts: [] });
    expect((await start()).statusCode).toBe(202);
    const replaced = await finished();
    expect(replaced).toMatchObject({ state: "done" });
    // The old pass wakes up, finds its lease gone, and writes nothing more.
    release();
    await new Promise((r) => setTimeout(r, 50));
    const [row] = await server.app.db.select().from(conceptSortRuns);
    expect(row!.startedAt.toISOString()).toBe(replaced.startedAt);
    expect(await run()).toEqual(replaced);
    expect(await sortingOf(alpha, "semaine3")).toBeUndefined();
  });
});
