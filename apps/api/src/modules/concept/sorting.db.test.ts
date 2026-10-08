/**
 * The sorting of the existing tags over the real application (ADR-081,
 * second addendum 2026-10-08): the list of every (pool, tag) pair with its
 * count, description and excerpts (never the internal name), the admin's
 * accept (new concepts validated, one per distinct label; an existing key
 * named with the items; re-accept), the validation and the deletion of a
 * concept, the admin role alone, and the audit rows.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  Concept as ConceptSchema,
  TagSortingAcceptResponse,
  TagSortingConflict,
  TagSortingItemsError,
  TagSortingList,
  type Concept,
  type TagSortingRow,
} from "@quiz/contracts";

import {
  auditLog,
  concepts,
  conceptTagSortings,
  pools,
  poolTags,
  questions,
  questionTags,
  questionVersions,
} from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { publishQuestion } from "../../test/live.js";
import * as poolService from "../pool/service.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let teacher: Who;
let admin: Who;
/** Alpha: `pointeur` ×3 (described), `boucle` ×2 (one never published); a deleted question wears `fantome`. */
let alpha: string;
/** Beta: `pointeurs` ×1, `semaine3` ×1. */
let beta: string;

const call = (who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

const accept = (items: Payload) => call(admin, "POST", "/app/api/admin/concept-sorting/accept", { items } as Payload);

async function accepted(items: Payload) {
  const res = await accept(items);
  expect(res.statusCode, res.body).toBe(200);
  return TagSortingAcceptResponse.parse(res.json());
}

async function list(poolIds = [alpha, beta]): Promise<TagSortingRow[]> {
  const res = await call(admin, "GET", "/app/api/admin/concept-sorting");
  expect(res.statusCode, res.body).toBe(200);
  return TagSortingList.parse(res.json()).rows.filter((r) => poolIds.includes(r.poolId));
}

async function propose(body: Payload): Promise<Concept> {
  const res = await call(teacher, "POST", "/app/api/concepts", body);
  expect(res.statusCode, res.body).toBe(201);
  return ConceptSchema.parse(res.json());
}

const pointer = { kind: "new", fr: { label: "Pointeur", description: "Une adresse typée." }, en: { label: "Pointer" } };

async function pool(name: string): Promise<string> {
  const id = randomUUID();
  await server.app.db.insert(pools).values({ id, name, ownerId: teacher.id });
  return id;
}

/** A real `short` question; its expected answer is a key the list must never show. */
const short = (name: string) => ({
  type: "short",
  config: {
    configVersion: 3,
    prompt: `Statement of ${name}: what does *p yield?`,
    kind: "text",
    matchers: [{ kind: "exact", value: `KEY-${name}` }],
  },
});

/**
 * A published question of `poolId` wearing `tags` (a `short` one by
 * default); its internal name is a secret the list must never show.
 */
async function question(
  poolId: string,
  name: string,
  tags: string[],
  publish = true,
  content: { type: string; config: unknown } = short(name),
): Promise<string> {
  const db = server.app.db;
  const id = publish
    ? await publishQuestion(db, poolId, teacher.id, `SECRET-${name}`, content)
    : (await poolService.createQuestion(db, { poolId, type: "short", internalName: `SECRET-${name}`, createdBy: teacher.id })).id;
  await db.insert(questionTags).values(tags.map((tag) => ({ questionId: id, tag })));
  await db
    .insert(poolTags)
    .values(tags.map((tag) => ({ poolId, tag })))
    .onConflictDoNothing();
  return id;
}

const audits = (action: "concept.sort" | "concept.validate" | "concept.delete", subjectIds: string[]) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), inArray(auditLog.subjectId, subjectIds)));

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  admin = await server.signIn("admin");
  alpha = await pool("Alpha");
  beta = await pool("Beta");
  await question(alpha, "one", ["pointeur", "boucle"]);
  await question(alpha, "two", ["pointeur"]);
  await question(alpha, "three", ["pointeur"]);
  await question(alpha, "draft", ["boucle"], false);
  const gone = await question(alpha, "gone", ["pointeur", "fantome"]);
  await server.app.db.update(questions).set({ deletedAt: new Date() }).where(eq(questions.id, gone));
  await server.app.db
    .update(poolTags)
    .set({ description: "Une variable qui contient une adresse." })
    .where(and(eq(poolTags.poolId, alpha), eq(poolTags.tag, "pointeur")));
  await question(beta, "four", ["pointeurs", "semaine3"]);
});

beforeEach(async () => {
  await server.app.db.delete(conceptTagSortings);
  await server.app.db.delete(concepts);
});

afterAll(async () => {
  await server?.close();
});

describe("the list of pairs to sort", () => {
  it("gives each live pair its count, description and excerpts, by conceptKey group", async () => {
    const rows = await list();
    const at = (poolId: string, tag: string) => rows.find((r) => r.poolId === poolId && r.tag === tag);
    expect(rows.map((r) => r.tag).sort()).toEqual(["boucle", "pointeur", "pointeurs", "semaine3"]);
    expect(at(alpha, "pointeur")).toMatchObject({
      poolName: "Alpha",
      count: 3,
      description: "Une variable qui contient une adresse.",
      group: "pointeur",
      sorting: null,
    });
    // Two of the three statements, as the type reads the content.
    const excerpts = at(alpha, "pointeur")!.excerpts;
    expect(excerpts).toHaveLength(2);
    for (const e of excerpts) expect(e).toMatch(/^Statement of (one|two|three): what does \*p yield\?$/);
    // The draft-only question counts, but has no published statement to show.
    expect(at(alpha, "boucle")).toMatchObject({ count: 2, description: "", excerpts: ["Statement of one: what does *p yield?"] });
    expect(at(beta, "pointeurs")).toMatchObject({ poolName: "Beta", count: 1, group: "pointeur" });
    // The pointeur group (4 questions) comes first, its two spellings side by side.
    expect(rows.slice(0, 2).map((r) => r.tag)).toEqual(["pointeur", "pointeurs"]);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    expect(JSON.stringify(rows)).not.toContain("KEY-");
  });

  it("is the admin's alone, without Super Powers", async () => {
    expect((await call(teacher, "GET", "/app/api/admin/concept-sorting")).statusCode).toBe(403);
    expect((await call(teacher, "POST", "/app/api/admin/concept-sorting/accept", { items: [] })).statusCode).toBe(403);
    const concept = await propose({ lang: "fr", label: "tableau" });
    expect((await call(teacher, "POST", `/app/api/admin/concepts/${concept.id}/validate`)).statusCode).toBe(403);
    expect((await call(teacher, "DELETE", `/app/api/admin/concepts/${concept.id}`)).statusCode).toBe(403);
  });
});

describe("accepting decisions", () => {
  it("creates one validated concept for the items that share new labels, audited", async () => {
    const result = await accepted([
      { poolId: alpha, tag: "pointeur", decision: pointer },
      { poolId: beta, tag: "pointeurs", decision: { ...pointer, fr: { label: "pointeurs" } } },
    ]);
    expect(result.created).toHaveLength(1);
    const [created] = result.created;
    expect(created).toMatchObject({
      status: "validated",
      labels: { fr: "Pointeur", en: "Pointer" },
      descriptions: { fr: "Une adresse typée.", en: "" },
      createdBy: admin.id,
    });
    for (const row of result.rows) {
      expect(row.sorting).toMatchObject({
        decision: "concept",
        concept: { id: created!.id },
        dropReason: null,
        decidedBy: admin.id,
        decidedAt: server.clock.now().toISOString(),
      });
    }
    expect(await audits("concept.validate", [created!.id])).toHaveLength(1);
    const sorts = await audits("concept.sort", [alpha, beta]);
    expect(sorts.map((a) => a.payload)).toEqual(
      expect.arrayContaining([
        { decisions: [{ tag: "pointeur", decision: "concept", conceptId: created!.id, reason: null }] },
        { decisions: [{ tag: "pointeurs", decision: "concept", conceptId: created!.id, reason: null }] },
      ]),
    );
    const listed = (await list()).find((r) => r.poolId === alpha && r.tag === "pointeur");
    expect(listed!.sorting).toMatchObject({ decision: "concept", concept: { id: created!.id } });
  });

  it("maps onto an existing concept and drops with a reason", async () => {
    const loop = await propose({ lang: "fr", label: "boucle" });
    const result = await accepted([
      { poolId: alpha, tag: "boucle", decision: { kind: "concept", conceptId: loop.id } },
      { poolId: beta, tag: "semaine3", decision: { kind: "drop", reason: "organisational" } },
    ]);
    expect(result.created).toEqual([]);
    expect(result.rows[0]!.sorting).toMatchObject({ decision: "concept", concept: { id: loop.id, status: "proposed" } });
    expect(result.rows[1]!.sorting).toMatchObject({ decision: "drop", concept: null, dropReason: "organisational" });
  });

  it("names the concept that holds a key and the items that asked for it, writing nothing", async () => {
    const holder = await propose({ lang: "fr", label: "pointeurs" });
    const res = await accept([
      { poolId: alpha, tag: "pointeur", decision: pointer },
      { poolId: beta, tag: "pointeurs", decision: pointer },
      { poolId: beta, tag: "semaine3", decision: { kind: "drop", reason: "organisational" } },
    ]);
    expect(res.statusCode).toBe(409);
    const body = TagSortingConflict.parse(res.json());
    expect(body.conflicts).toEqual([
      {
        concept: expect.objectContaining({ id: holder.id }),
        items: [
          { poolId: alpha, tag: "pointeur" },
          { poolId: beta, tag: "pointeurs" },
        ],
      },
    ]);
    expect(await server.app.db.select().from(conceptTagSortings)).toEqual([]);
    expect(await server.app.db.select().from(concepts)).toHaveLength(1);
  });

  it("refuses a pair no live question wears, a missing concept and two clashing new concepts", async () => {
    const unknown = await accept([{ poolId: alpha, tag: "fantome", decision: { kind: "drop", reason: "noise" } }]);
    expect(unknown.statusCode).toBe(422);
    expect(TagSortingItemsError.parse(unknown.json())).toEqual({
      error: "tag_unknown",
      items: [{ poolId: alpha, tag: "fantome" }],
    });

    const missing = await accept([{ poolId: alpha, tag: "boucle", decision: { kind: "concept", conceptId: randomUUID() } }]);
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ error: "concept_not_found", items: [{ poolId: alpha, tag: "boucle" }] });

    const clash = await accept([
      { poolId: alpha, tag: "pointeur", decision: pointer },
      { poolId: beta, tag: "pointeurs", decision: { ...pointer, en: { label: "Address" } } },
    ]);
    expect(clash.statusCode).toBe(422);
    expect(clash.json()).toMatchObject({ error: "concept_batch_conflict" });
    expect(clash.json().items).toHaveLength(2);

    const twice = await accept([
      { poolId: alpha, tag: "boucle", decision: { kind: "drop", reason: "noise" } },
      { poolId: alpha, tag: "boucle", decision: { kind: "drop", reason: "task_kind" } },
    ]);
    expect(twice.statusCode).toBe(400);
  });

  it("changes an accepted decision, keeps the model's proposal, and accepts the same decision again", async () => {
    const proposal = { kind: "drop", dropReason: "task_kind", model: "test-model" } as const;
    await server.app.db.insert(conceptTagSortings).values({ poolId: alpha, tag: "boucle", proposal });
    expect((await list()).find((r) => r.tag === "boucle")!.sorting).toMatchObject({ decision: null, decidedAt: null, proposal });

    await accepted([{ poolId: alpha, tag: "boucle", decision: { kind: "drop", reason: "task_kind" } }]);
    const loop = await propose({ lang: "fr", label: "boucle" });
    server.clock.advance(60_000);
    const changed = await accepted([{ poolId: alpha, tag: "boucle", decision: { kind: "concept", conceptId: loop.id } }]);
    expect(changed.rows[0]!.sorting).toMatchObject({
      decision: "concept",
      concept: { id: loop.id },
      dropReason: null,
      proposal,
      decidedAt: server.clock.now().toISOString(),
    });
    const again = await accepted([{ poolId: alpha, tag: "boucle", decision: { kind: "concept", conceptId: loop.id } }]);
    expect(again.rows[0]!.sorting).toMatchObject({ decision: "concept", concept: { id: loop.id } });
    expect(await server.app.db.select().from(conceptTagSortings)).toHaveLength(1);
  });

  it("goes with its pool", async () => {
    const gamma = await pool("Gamma");
    await question(gamma, "five", ["exam2024"]);
    await accepted([{ poolId: gamma, tag: "exam2024", decision: { kind: "drop", reason: "organisational" } }]);
    await server.app.db.delete(pools).where(eq(pools.id, gamma));
    expect(await server.app.db.select().from(conceptTagSortings).where(eq(conceptTagSortings.poolId, gamma))).toEqual([]);
  });

  it("keeps a row's decision consistent in the database", async () => {
    const insert = (values: Partial<typeof conceptTagSortings.$inferInsert>) =>
      server.app.db.insert(conceptTagSortings).values({ poolId: alpha, tag: "boucle", ...values });
    const now = new Date();
    await expect(insert({ decision: "concept", decidedAt: now })).rejects.toThrow();
    await expect(insert({ decision: "drop", decidedAt: now })).rejects.toThrow();
    await expect(insert({ decision: "drop", dropReason: "noise" })).rejects.toThrow();
    await expect(insert({ proposal: { model: "m", kind: "drop", dropReason: "noise" }, decidedBy: admin.id })).rejects.toThrow();
    await expect(insert({})).rejects.toThrow();
    await insert({ proposal: { model: "m", kind: "drop", dropReason: "noise" } });
    await server.app.db.delete(conceptTagSortings);
    await insert({ decision: "drop", dropReason: "noise", decidedAt: now });
  });
});

describe("validating and deleting a concept", () => {
  it("validates a concept once it has both labels", async () => {
    const concept = await propose({ lang: "fr", label: "récursivité" });
    const url = `/app/api/admin/concepts/${concept.id}/validate`;
    const missing = await call(admin, "POST", url);
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ error: "concept_label_missing", lang: "en" });

    expect((await call(admin, "PATCH", `/app/api/concepts/${concept.id}`, { en: { label: "recursion" } })).statusCode).toBe(200);
    const res = await call(admin, "POST", url);
    expect(res.statusCode, res.body).toBe(200);
    expect(ConceptSchema.parse(res.json())).toMatchObject({ status: "validated", labels: { fr: "récursivité", en: "recursion" } });
    expect((await call(admin, "POST", url)).statusCode).toBe(200);
    expect(await audits("concept.validate", [concept.id])).toHaveLength(1);
    expect((await call(admin, "POST", `/app/api/admin/concepts/${randomUUID()}/validate`)).statusCode).toBe(404);
  });

  it("deletes a concept nothing refers to, and refuses one a decision or a merge refers to", async () => {
    const unused = await propose({ lang: "fr", label: "tas" });
    const del = await call(admin, "DELETE", `/app/api/admin/concepts/${unused.id}`);
    expect(del.statusCode).toBe(204);
    expect(await server.app.db.select().from(concepts).where(eq(concepts.id, unused.id))).toEqual([]);
    expect(await audits("concept.delete", [unused.id])).toHaveLength(1);
    expect((await call(admin, "DELETE", `/app/api/admin/concepts/${unused.id}`)).statusCode).toBe(404);

    const mapped = await propose({ lang: "fr", label: "boucle" });
    await accepted([{ poolId: alpha, tag: "boucle", decision: { kind: "concept", conceptId: mapped.id } }]);
    const inUse = await call(admin, "DELETE", `/app/api/admin/concepts/${mapped.id}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toMatchObject({ error: "concept_in_use" });

    const survivor = await propose({ lang: "fr", label: "pile" });
    const merged = await propose({ lang: "fr", label: "stack" });
    await server.app.db.update(concepts).set({ status: "merged", mergedInto: survivor.id }).where(eq(concepts.id, merged.id));
    expect((await call(admin, "DELETE", `/app/api/admin/concepts/${survivor.id}`)).statusCode).toBe(409);
  });
});

describe("the excerpts of real question types", () => {
  it("show what a student reads, never a key, and nothing for a parameterized version", async () => {
    const gamma = await pool("Excerpts");
    // An LLM matcher cannot be published without a model: it is written into the published version afterwards.
    const shortConfig = {
      configVersion: 3,
      prompt: "Who formulated the laws of motion?",
      kind: "text",
      matchers: [{ kind: "exact", value: "Isaac Newton" }],
    };
    const shortId = await question(gamma, "short", ["x-short"], true, { type: "short", config: shortConfig });
    await server.app.db
      .update(questionVersions)
      .set({
        config: {
          ...shortConfig,
          matchers: [
            ...shortConfig.matchers,
            { kind: "llm", rubric: "RUBRIC-MARKER three laws", reference: "REFERENCE-MARKER", points: 0.5 },
          ],
        },
      })
      .where(eq(questionVersions.questionId, shortId));
    await question(gamma, "cloze", ["x-cloze"], true, {
      type: "cloze",
      config: {
        configVersion: 2,
        text: "The force is measured in {{=newton|joule|watt}}, whose symbol is {{N}}; it loops {{#10:0}} times.",
      },
    });
    await question(gamma, "rich", ["x-rich"], true, {
      type: "rich",
      config: {
        configVersion: 1,
        prompt: "Explain why a stack overflow crashes a C program.",
        rubric: "- 2 pts: RUBRIC-MARKER guard page",
        reference: "REFERENCE-MARKER the stack meets the guard page",
        maxChars: 3000,
        format: "markdown",
      },
    });
    await question(gamma, "mcq", ["x-mcq"], true, {
      type: "mcq",
      config: {
        configVersion: 2,
        prompt: "Let `int *p` point at `0x1000`. What is `p + 1`?",
        choices: [
          { text: "0x1001", correct: false },
          { text: "0x1004", correct: true },
        ],
        mode: "single",
        policy: "discordance",
        shuffleChoices: true,
      },
    });
    const drawn = await question(gamma, "param", ["x-param"]);
    await server.app.db
      .update(questionVersions)
      .set({ variables: { rows: [{ name: "n", formula: "1" }] } as never })
      .where(eq(questionVersions.questionId, drawn));

    const rows = await list([gamma]);
    const excerpt = (tag: string) => rows.find((r) => r.tag === tag)!.excerpts;
    expect(excerpt("x-short")).toEqual(["Who formulated the laws of motion?"]);
    expect(excerpt("x-cloze")).toEqual(["The force is measured in ___, whose symbol is ___; it loops ___ times."]);
    expect(excerpt("x-rich")).toEqual(["Explain why a stack overflow crashes a C program."]);
    expect(excerpt("x-mcq")).toEqual(["Let `int *p` point at `0x1000`. What is `p + 1`? 0x1001 0x1004"]);
    expect(excerpt("x-param")).toEqual([]);
    const all = JSON.stringify(rows);
    for (const secret of ["Newton", "newton", "joule", "RUBRIC-MARKER", "REFERENCE-MARKER", "#10", "correct", "discordance"]) {
      expect(all).not.toContain(secret);
    }
  });
});
