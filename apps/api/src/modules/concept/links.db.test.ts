/**
 * The links between questions and concepts, before the cut-over (ADR-081,
 * third addendum 2026-10-08): the resolution of a write naming concepts
 * (every branch, all or nothing, the stop list), the replacement of a
 * question's set, the labels in the reader's language, the cascade of a
 * question's deletion, the refusal to delete a linked concept, and the stop
 * list on `POST /concepts`. Nothing outside the `concept` module calls these
 * yet.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConceptNotFound, ConceptWriteRefusal } from "@quiz/contracts";
import { qualifiedConceptKey } from "@quiz/domain";

import type { AuditActor } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { auditLog, concepts, conceptTagSortings, pools, questionConcepts, questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { DomainError } from "../http.js";
import * as poolService from "../pool/service.js";
import * as service from "./service.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let teacher: Who;
let admin: Who;
let actor: AuditActor;
let poolId: string;

const now = new Date("2026-10-08T10:00:00Z");
const db = () => server.app.db;

/** A concept inserted as it is, both languages optional. */
async function concept(
  fr: [string, string?] | null,
  en: [string, string?] | null = null,
  extra: { status?: "proposed" | "validated" | "merged"; mergedInto?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const side = (s: [string, string?] | null) => ({
    label: s?.[0] ?? null,
    qualifier: s?.[1] ?? "",
  });
  const f = side(fr);
  const e = side(en);
  await db()
    .insert(concepts)
    .values({
      id,
      status: extra.status ?? "validated",
      mergedInto: extra.mergedInto ?? null,
      labelFr: f.label,
      qualifierFr: f.qualifier,
      keyFr: f.label === null ? null : qualifiedConceptKey(f.label, f.qualifier),
      labelEn: e.label,
      qualifierEn: e.qualifier,
      keyEn: e.label === null ? null : qualifiedConceptKey(e.label, e.qualifier),
    });
  return id;
}

/** The admin dropped `tag` in the sorting of the pool. */
async function drop(tag: string, reason: "organisational" | "task_kind" | "noise") {
  await db().insert(conceptTagSortings).values({
    poolId,
    tag,
    decision: "drop",
    dropReason: reason,
    decidedBy: admin.id,
    decidedAt: now,
  });
}

const resolve = (inputs: string[], create = false, lang: "fr" | "en" = "fr", on: Db | Tx = db()) =>
  service.resolveForWrite(on, inputs, { create, lang, createdBy: teacher.id, actor, now });

/** The 422 a refused write throws, checked against its contract. */
async function refusal(inputs: string[], create = false, lang: "fr" | "en" = "fr") {
  const error = await resolve(inputs, create, lang).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  const e = error as DomainError;
  expect(e.status).toBe(422);
  return ConceptWriteRefusal.parse({ error: e.code, message: e.message, ...e.details });
}

/** A draft question of the pool: a link needs a question, not a published version. */
const question = async (name: string) =>
  (await poolService.createQuestion(db(), { poolId, type: "short", internalName: name, createdBy: teacher.id })).id;

let pointer: string;
let memory: string;
let postal: string;
let merged: string;
let recursion: string;

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  admin = await server.signIn("admin");
  actor = { actorUserId: teacher.id, actorType: "user" };
  poolId = randomUUID();
  await db().insert(pools).values({ id: poolId, name: "Links", ownerId: teacher.id });
});

beforeEach(async () => {
  await db().delete(questionConcepts);
  await db().delete(conceptTagSortings);
  await db().delete(concepts);
  pointer = await concept(["pointeur"], ["pointer"]);
  memory = await concept(["adresse", "mémoire"], ["address", "memory"]);
  postal = await concept(["adresse", "postale"]);
  merged = await concept(["pointeur ancien"], null, { status: "merged", mergedInto: pointer });
  recursion = await concept(null, ["recursion"], { status: "proposed" });
  await drop("c01", "organisational");
  await drop("lecture-de-code", "task_kind");
});

afterAll(async () => {
  await server?.close();
});

/**
 * The resolution rules themselves are `planConceptWrite`'s, unit-tested in
 * `@quiz/domain`; here, what the service adds: the rows it loads (the stop
 * list from the sortings), the candidates it labels, what it writes.
 */
describe("resolveForWrite", () => {
  it("creates a proposed concept in the asked language, credited and audited, once per key", async () => {
    const out = await resolve(["Boucle", "boucles", "pile (structure)", pointer, merged], true, "fr");
    expect(out.created).toHaveLength(2);
    const [loop, stack] = out.created;
    expect(out.ids).toEqual([loop!.id, loop!.id, stack!.id, pointer, pointer]);
    expect(loop).toMatchObject({ status: "proposed", labels: { fr: "Boucle", en: null }, createdBy: teacher.id });
    expect(stack).toMatchObject({ labels: { fr: "pile", en: null }, qualifiers: { fr: "structure", en: "" } });
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "concept.propose"), eq(auditLog.subjectId, loop!.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: teacher.id, payload: { lang: "fr", label: "Boucle" } });
  });

  it("is all or nothing: every error listed, candidates labelled in the asked language, the stop list from the sortings", async () => {
    const before = (await db().select().from(concepts)).length;
    const body = await refusal(["nouveau", "adresse", "Lecture de code", pointer], true, "en");
    expect(body).toEqual({
      error: "concept_ambiguous",
      message: expect.any(String),
      errors: [
        {
          input: "adresse",
          error: "concept_ambiguous",
          candidates: expect.arrayContaining([
            { id: memory, label: "address", qualifier: "memory", status: "validated" },
            // No English label: the French one, with its qualifier.
            { id: postal, label: "adresse", qualifier: "postale", status: "validated" },
          ]),
        },
        { input: "Lecture de code", error: "concept_dropped", reason: "task_kind" },
      ],
    });
    expect(await db().select().from(concepts)).toHaveLength(before);
  });

  it("answers a key taken meanwhile with 409 concept_exists naming its holder", async () => {
    // A stored key the resolver does not see (stale, as a concurrent insert would be): the insert hits the index.
    const holder = randomUUID();
    await db().insert(concepts).values({ id: holder, status: "validated", labelFr: "zzz", keyFr: "tri" });
    await expect(resolve(["tri"], true)).rejects.toMatchObject({
      code: "concept_exists",
      status: 409,
      details: { concept: { id: holder } },
    });
    expect(await db().select().from(concepts).where(eq(concepts.labelFr, "tri"))).toEqual([]);
  });

  it("creates inside the caller's transaction: its rollback leaves nothing", async () => {
    let created = "";
    await expect(
      db().transaction(async (tx) => {
        created = (await resolve(["nouveau"], true, "fr", tx)).created[0]!.id;
        throw new Error("the caller's write failed");
      }),
    ).rejects.toThrow("the caller's write failed");
    expect(created).not.toBe("");
    expect(await db().select().from(concepts).where(eq(concepts.id, created))).toEqual([]);
    expect(await db().select().from(auditLog).where(eq(auditLog.subjectId, created))).toEqual([]);
  });
});

describe("setQuestionConcepts and conceptsOf", () => {
  it("replaces a question's set and reads it in the reader's language, with the fallback", async () => {
    const q = await question("q1");
    const other = await question("q2");
    await db().transaction((tx) => service.setQuestionConcepts(tx, q, [pointer, memory, pointer]));
    await db().transaction((tx) => service.setQuestionConcepts(tx, q, [memory, recursion]));
    const fr = await service.conceptsOf(db(), [q, other], "fr");
    expect(fr.get(q)).toEqual([
      { id: memory, label: "adresse", qualifier: "mémoire", status: "validated" },
      { id: recursion, label: "recursion", qualifier: "", status: "proposed" },
    ]);
    expect(fr.get(other)).toEqual([]);
    const en = await service.conceptsOf(db(), [q], "en");
    expect(en.get(q)!.map((r) => r.label)).toEqual(["address", "recursion"]);
    expect(await service.conceptsOf(db(), [], "fr")).toEqual(new Map());

    await service.setQuestionConcepts(db(), q, []);
    expect((await service.conceptsOf(db(), [q], "fr")).get(q)).toEqual([]);
  });

  it("refuses a merged or missing concept and keeps the set as it was", async () => {
    const q = await question("q3");
    await service.setQuestionConcepts(db(), q, [pointer]);
    const missing = randomUUID();
    const error = await db()
      .transaction((tx) => service.setQuestionConcepts(tx, q, [memory, merged, missing]))
      .then(
        () => null,
        (e: unknown) => e as DomainError,
      );
    expect(error?.status).toBe(422);
    expect(ConceptNotFound.parse({ error: error?.code, ...error?.details })).toMatchObject({ ids: [merged, missing] });
    expect((await service.conceptsOf(db(), [q], "fr")).get(q)!.map((r) => r.id)).toEqual([pointer]);
  });
});

describe("deleting what a link refers to", () => {
  it("cascades a question's deletion to its links", async () => {
    const q = await question("gone");
    await service.setQuestionConcepts(db(), q, [pointer]);
    await db().delete(questions).where(eq(questions.id, q));
    expect(await db().select().from(questionConcepts).where(eq(questionConcepts.questionId, q))).toEqual([]);
  });

  it("refuses to delete a concept a question uses: 409 concept_in_use", async () => {
    const q = await question("keeps");
    await service.setQuestionConcepts(db(), q, [recursion]);
    const res = await server.app.inject({
      method: "DELETE",
      url: `/app/api/admin/concepts/${recursion}`,
      headers: admin.headers,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "concept_in_use" });
    expect(await db().select().from(concepts).where(eq(concepts.id, recursion))).toHaveLength(1);
  });
});

describe("POST /concepts and the stop list", () => {
  it("refuses a dropped tag's key with 422 concept_dropped, creates anything else", async () => {
    const refused = await server.app.inject({
      method: "POST",
      url: "/app/api/concepts",
      headers: teacher.headers,
      payload: { lang: "fr", label: "#C01" },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(ConceptWriteRefusal.parse(refused.json())).toMatchObject({
      error: "concept_dropped",
      errors: [{ input: "#C01", error: "concept_dropped", reason: "organisational" }],
    });
    expect(await db().select().from(concepts).where(eq(concepts.labelFr, "C01"))).toEqual([]);

    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/concepts",
      headers: teacher.headers,
      payload: { lang: "fr", label: "C02 bis" },
    });
    expect(created.statusCode, created.body).toBe(201);
  });

  it("lets a qualifier tell a concept apart from a dropped tag, and the admin curate onto it", async () => {
    const post = (who: Who, payload: Record<string, unknown>) =>
      server.app.inject({ method: "POST", url: "/app/api/concepts", headers: who.headers, payload });
    const qualified = await post(teacher, { lang: "fr", label: "C01", qualifier: "langage" });
    expect(qualified.statusCode, qualified.body).toBe(201);
    const byAdmin = await post(admin, { lang: "fr", label: "Lecture de code" });
    expect(byAdmin.statusCode, byAdmin.body).toBe(201);
  });
});

describe("PATCH /concepts and the stop list", () => {
  const patch = (who: Who, id: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: "PATCH", url: `/app/api/concepts/${id}`, headers: who.headers, payload });

  it("refuses the creator a rename onto a dropped tag's key, not the admin", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/concepts",
      headers: teacher.headers,
      payload: { lang: "fr", label: "chapitre" },
    });
    const id = created.json().id as string;
    const res = await patch(teacher, id, { en: { label: "Lecture de code" } });
    expect(res.statusCode, res.body).toBe(422);
    expect(ConceptWriteRefusal.parse(res.json())).toEqual({
      error: "concept_dropped",
      message: expect.any(String),
      errors: [{ input: "Lecture de code", error: "concept_dropped", reason: "task_kind" }],
    });
    expect((await db().select().from(concepts).where(eq(concepts.id, id)))[0]).toMatchObject({ labelEn: null });
    const ok = await patch(teacher, id, { fr: { description: "Un chapitre." }, en: { label: "chapter" } });
    expect(ok.statusCode, ok.body).toBe(200);
    const byAdmin = await patch(admin, id, { en: { label: "Lecture de code" } });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    // Already on the list, the side may not move to another dropped key for the creator.
    const moved = await patch(teacher, id, { en: { label: "C01" } });
    expect(moved.statusCode, moved.body).toBe(422);
    expect(moved.json()).toMatchObject({ error: "concept_dropped" });
  });

  it("lets a qualifier-only edit pass on a concept whose label is dropped elsewhere", async () => {
    // `boucle` mapped to a concept in one pool, dropped in another: the concept keeps being edited.
    const loop = await concept(["boucle"]);
    await drop("boucle", "noise");
    const ok = await patch(admin, loop, { fr: { qualifier: "itération" } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ labels: { fr: "boucle" }, qualifiers: { fr: "itération" } });
  });
});
