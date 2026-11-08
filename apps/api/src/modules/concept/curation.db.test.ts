/**
 * `GET /admin/concepts`, the curation queue (ADR-081 fifth addendum): the
 * admin alone, `proposed` first, the instance-wide count of live questions
 * (a number, even for a pool the admin cannot reach) and what `deletable` says.
 */
import { randomUUID } from "node:crypto";

import { eq, inArray, and } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AdminConceptList,
  Concept,
  ConceptResolveResponse,
  ConceptCycle,
  ConceptList,
  ConceptRelationCandidates,
} from "@quiz/contracts";

import { concepts, pools, questionConcepts, questions, auditLog, conceptRelations } from "../../db/schema.js";
import { seedConcept, type ConceptSide } from "../../test/concepts.js";
import { testServer, type TestServer } from "../../test/http.js";
import * as poolService from "../pool/service.js";
import * as service from "./service.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let teacher: Who;
let admin: Who;
let poolId: string;
const db = () => server.app.db;

const concept = (fr: ConceptSide, en: ConceptSide = null, status: "proposed" | "validated" | "merged" = "validated", mergedInto: string | null = null) =>
  seedConcept(db(), teacher.id, fr, en, status, mergedInto);

async function link(conceptId: string, name: string, deleted = false) {
  const q = await poolService.createQuestion(db(), {
    poolId,
    type: "short",
    internalName: name,
    createdBy: teacher.id,
  });
  await db().insert(questionConcepts).values({ questionId: q.id, conceptId });
  if (deleted) await db().update(questions).set({ deletedAt: new Date() }).where(eq(questions.id, q.id));
}

const list = (who: Who) =>
  server.app.inject({ method: "GET", url: "/app/api/admin/concepts", headers: who.headers });
const read = async () => {
  const res = await list(admin);
  expect(res.statusCode, res.body).toBe(200);
  return AdminConceptList.parse(res.json());
};

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  admin = await server.signIn("admin");
  poolId = randomUUID();
  // The admin owns no seat on this pool: its questions are out of their reach.
  await db().insert(pools).values({ id: poolId, name: "Secret exam pool", ownerId: teacher.id });
});

beforeEach(async () => {
  await db().delete(questionConcepts);
  await db().delete(questions);
  await db().delete(concepts);
});

afterAll(async () => {
  await server.close();
});

describe("GET /admin/concepts", () => {
  it("lists proposed first, then by label, merged left out", async () => {
    const target = await concept(["Zèbre"], ["Zebra"]);
    await concept(["Ancien"], ["Old"], "merged", target);
    await concept(["Boucle"], ["Loop"]);
    await concept(["Récursivité"], null, "proposed");
    const res = await read();
    expect(res.concepts.map((c) => c.labels.fr)).toEqual(["Récursivité", "Boucle", "Zèbre"]);
    expect(res.concepts[0]?.creator).toMatch(/\S/);
  });

  it("counts the live questions of the whole instance, a deleted one apart", async () => {
    const pointer = await concept(["Pointeur"], ["Pointer"]);
    const unused = await concept(["Inutile"], ["Unused"]);
    const ghost = await concept(["Fantôme"], ["Ghost"]);
    await link(pointer, "p1");
    await link(pointer, "p2");
    await link(pointer, "p3", true);
    await link(ghost, "g1", true);
    const byId = new Map((await read()).concepts.map((c) => [c.id, c]));
    expect(byId.get(pointer)).toMatchObject({ questionCount: 2, deletable: false });
    expect(byId.get(unused)).toMatchObject({ questionCount: 0, deletable: true });
    // No live question, but the deleted one's link still refuses `DELETE`.
    expect(byId.get(ghost)).toMatchObject({ questionCount: 0, deletable: false });
    const refused = await server.app.inject({
      method: "DELETE",
      url: `/app/api/admin/concepts/${ghost}`,
      headers: admin.headers,
    });
    expect(refused.statusCode).toBe(409);
  });

  it("holds a concept a merge points at as not deletable", async () => {
    const target = await concept(["Cible"], ["Target"]);
    await concept(["Source"], ["Source"], "merged", target);
    expect((await read()).concepts[0]).toMatchObject({ questionCount: 0, deletable: false });
    const refused = await server.app.inject({
      method: "DELETE",
      url: `/app/api/admin/concepts/${target}`,
      headers: admin.headers,
    });
    expect(refused.statusCode).toBe(409);
  });

  it("exposes no pool name and no statement, only the number", async () => {
    const pointer = await concept(["Pointeur"], ["Pointer"]);
    await link(pointer, "Secret question name");
    const body = (await list(admin)).body;
    expect(body).not.toContain("Secret exam pool");
    expect(body).not.toContain("Secret question name");
    expect(body).not.toContain(poolId);
    expect(JSON.parse(body).concepts[0].questionCount).toBe(1);
  });
});

/**
 * `POST /admin/concepts/:id/merge` (ADR-081, fifth addendum §2): one
 * transaction that moves every link, soft-deleted questions included,
 * re-points earlier merges, audits the ids and refuses what it must.
 */
describe("merging concepts", () => {
  type Who = Awaited<ReturnType<TestServer["signIn"]>>;

  let server: TestServer;
  let teacher: Who;
  let admin: Who;
  let student: Who;
  let poolId: string;
  const db = () => server.app.db;

  const concept = (
    fr: string | null,
    en: string | null,
    status: "proposed" | "validated" | "merged" = "validated",
    mergedInto: string | null = null,
  ) => seedConcept(db(), teacher.id, fr === null ? null : [fr], en === null ? null : [en], status, mergedInto);

  async function question(name: string, conceptIds: string[], deleted = false): Promise<string> {
    const q = await poolService.createQuestion(db(), {
      poolId,
      type: "short",
      internalName: name,
      createdBy: teacher.id,
    });
    if (conceptIds.length > 0) {
      await db()
        .insert(questionConcepts)
        .values(conceptIds.map((conceptId) => ({ questionId: q.id, conceptId })));
    }
    if (deleted) await db().update(questions).set({ deletedAt: new Date() }).where(eq(questions.id, q.id));
    return q.id;
  }

  const none = { broader: [], related: [] };

  const linksOf = async (conceptId: string) =>
    (await db().select().from(questionConcepts).where(eq(questionConcepts.conceptId, conceptId)))
      .map((l) => l.questionId)
      .sort();

  const merge = (who: Who, id: string, into: string) =>
    server.app.inject({
      method: "POST",
      url: `/app/api/admin/concepts/${id}/merge`,
      headers: who.headers,
      payload: { into, keepAsAlias: false },
    });

  beforeAll(async () => {
    server = await testServer();
    teacher = await server.signIn("teacher");
    admin = await server.signIn("admin");
    student = await server.signIn("student");
    poolId = randomUUID();
    await db().insert(pools).values({ id: poolId, name: "Merge pool", ownerId: teacher.id });
  });

  beforeEach(async () => {
    await db().delete(questionConcepts);
    await db().delete(questions);
    await db().delete(concepts);
  });

  afterAll(async () => {
    await server.close();
  });

  describe("POST /admin/concepts/:id/merge", () => {
    it("moves the links, keeps one for a question linked to both, soft-deleted questions included", async () => {
      const loser = await concept("Pointage", "Pointing");
      const winner = await concept("Pointeur", "Pointer");
      const onlyLoser = await question("q-loser", [loser]);
      const both = await question("q-both", [loser, winner]);
      const onlyWinner = await question("q-winner", [winner]);
      const ghost = await question("q-ghost", [loser], true);

      const res = await merge(admin, loser, winner);
      expect(res.statusCode, res.body).toBe(200);
      expect(Concept.parse(res.json())).toMatchObject({ id: winner, status: "validated" });

      expect(await linksOf(loser)).toEqual([]);
      expect(await linksOf(winner)).toEqual([onlyLoser, both, onlyWinner, ghost].sort());
      // No link to a merged concept remains anywhere.
      const dangling = await db()
        .select({ q: questionConcepts.questionId })
        .from(questionConcepts)
        .innerJoin(concepts, eq(concepts.id, questionConcepts.conceptId))
        .where(eq(concepts.status, "merged"));
      expect(dangling).toEqual([]);
      const [row] = await db().select().from(concepts).where(eq(concepts.id, loser));
      expect(row).toMatchObject({ status: "merged", mergedInto: winner });
      // The winner keeps its labels and status.
      const [kept] = await db().select().from(concepts).where(eq(concepts.id, winner));
      expect(kept).toMatchObject({ status: "validated", labelFr: "Pointeur", labelEn: "Pointer" });
    });

    it("re-points the concepts merged earlier into the loser, so no chain remains", async () => {
      const old = await concept("Ancien", "Old");
      const loser = await concept("Pointage", "Pointing");
      const winner = await concept("Pointeur", "Pointer");
      await db().update(concepts).set({ status: "merged", mergedInto: loser }).where(eq(concepts.id, old));

      expect((await merge(admin, loser, winner)).statusCode).toBe(200);
      const merged = await db().select().from(concepts).where(inArray(concepts.id, [old, loser]));
      expect(merged.map((c) => c.mergedInto)).toEqual([winner, winner]);
      // The remaining merged concept's old id still resolves in one hop.
      const resolved = await service.resolveLabels(db(), [old, loser], "en", { role: "admin" });
      expect(resolved.map((r) => r.kind === "resolved" && r.concept.id)).toEqual([winner, winner]);
    });

    it("audits the loser, the winner and the question ids, for a reviewed undo", async () => {
      const loser = await concept("Pointage", "Pointing");
      const winner = await concept("Pointeur", "Pointer");
      const old = await concept("Ancien", null, "merged", loser);
      const a = await question("a", [loser]);
      const b = await question("b", [loser, winner]);
      await merge(admin, loser, winner);
      const [entry] = await db().select().from(auditLog).where(eq(auditLog.subjectId, loser));
      expect(entry).toMatchObject({ subjectType: "concept", subjectId: loser, actorUserId: admin.id });
      expect(entry?.payload).toEqual({
        loser: { id: loser, status: "validated", labels: { fr: "Pointage", en: "Pointing" }, qualifiers: { fr: "", en: "" } },
        winner: { id: winner, labels: { fr: "Pointeur", en: "Pointer" }, qualifiers: { fr: "", en: "" } },
        moved: [a],
        alreadyLinked: [b],
        coursesMoved: [],
        coursesAlreadyListed: [],
        repointed: [old],
        aliasesMoved: [],
        aliasesAdded: [],
        aliasesDropped: [],
        relationsOfLoser: none,
        relationsMoved: none,
        relationsDropped: { ...none, hierarchical: [] },
      });
    });

    it("frees the loser's key and stops resolving its label, while its id resolves to the winner", async () => {
      const loser = await concept("Pointage", "Pointing");
      const winner = await concept("Pointeur", "Pointer");
      await merge(admin, loser, winner);
      // A bare label matches the live concepts only: the loser's no longer designates anything.
      const res = await server.app.inject({
        method: "GET",
        url: "/app/api/concepts/resolve?input=Pointage&input=" + loser,
        headers: teacher.headers,
      });
      const [byLabel, byId] = ConceptResolveResponse.parse(res.json()).results;
      expect(byLabel?.kind).toBe("unknown");
      expect(byId).toMatchObject({ kind: "resolved", concept: { id: winner } });
      // Its key is free again.
      await expect(concept("Pointage", "Pointing")).resolves.toBeTypeOf("string");
    });

    it("refuses a target that is not validated, itself, a merged concept, a missing one", async () => {
      const loser = await concept("A", "A");
      const proposed = await concept("B", null, "proposed");
      const gone = await concept("C", "C", "merged", proposed);
      const winner = await concept("D", "D");
      await question("q", [loser]);

      const refusedProposed = await merge(admin, loser, proposed);
      expect(refusedProposed.statusCode).toBe(422);
      expect(refusedProposed.json().error).toBe("concept_merge_target_not_validated");
      const self = await merge(admin, loser, loser);
      expect([self.statusCode, self.json().error]).toEqual([422, "concept_merge_self"]);
      expect((await merge(admin, gone, winner)).json().error).toBe("concept_merged");
      expect((await merge(admin, loser, gone)).statusCode).toBe(409);
      expect((await merge(admin, loser, randomUUID())).statusCode).toBe(404);
      expect((await merge(admin, randomUUID(), winner)).statusCode).toBe(404);
      expect((await server.app.inject({ method: "POST", url: `/app/api/admin/concepts/${loser}/merge`, headers: admin.headers, payload: {} })).statusCode).toBe(400);
      // Nothing moved, nothing audited.
      expect(await linksOf(loser)).toHaveLength(1);
      expect(await db().select().from(auditLog).where(eq(auditLog.subjectId, loser))).toEqual([]);
    });

    it("merges a proposed concept into a validated one", async () => {
      const loser = await concept("Fuite", null, "proposed");
      const winner = await concept("Fuite mémoire", "Memory leak");
      await question("q", [loser]);
      const res = await merge(admin, loser, winner);
      expect(res.statusCode, res.body).toBe(200);
      const [entry] = await db().select().from(auditLog).where(eq(auditLog.subjectId, loser));
      expect(entry?.payload).toMatchObject({ loser: { status: "proposed" }, moved: [expect.any(String)], alreadyLinked: [] });
    });

    it("is the admin's alone", async () => {
      const loser = await concept("A", "A");
      const winner = await concept("B", "B");
      expect((await merge(teacher, loser, winner)).statusCode).toBe(403);
      expect((await merge(student, loser, winner)).statusCode).toBe(403);
      expect(
        (await server.app.inject({ method: "POST", url: `/app/api/admin/concepts/${loser}/merge`, payload: { into: winner, keepAsAlias: false } }))
          .statusCode,
      ).toBe(401);
      const [row] = await db().select().from(concepts).where(eq(concepts.id, loser));
      expect(row?.status).toBe("validated");
    });
  });

  describe("copyQuestionConcepts after a merge", () => {
    it("copies the winner, never a merged concept", async () => {
      const loser = await concept("A", "A");
      const winner = await concept("B", "B");
      const source = await question("source", [loser]);
      await merge(admin, loser, winner);
      // Even a link to a merged concept that a racing write left behind is not copied as such.
      await db().insert(questionConcepts).values({ questionId: source, conceptId: loser });
      const copy = await question("copy", []);
      await db().transaction((tx) => service.copyQuestionConcepts(tx, source, copy));
      expect((await db().select().from(questionConcepts).where(eq(questionConcepts.questionId, copy))).map((l) => l.conceptId)).toEqual([winner]);
    });
  });
});

/**
 * Relations between concepts (ADR-081 §4, sixth addendum 7c): the wiring
 * only, the rule matrix being `@quiz/domain`'s. One refusal per HTTP code,
 * the lock race, the cascade, the audit, a merge's rewrite, its drops and
 * its cycle, and the deletion that takes the same lock.
 */
describe("relations between concepts", () => {
  type Who = Awaited<ReturnType<TestServer["signIn"]>>;

  let server: TestServer;
  let teacher: Who;
  let admin: Who;
  let student: Who;
  const db = () => server.app.db;

  const concept = (fr: string, en: string, status: "proposed" | "validated" | "merged" = "validated", into: string | null = null) =>
    seedConcept(db(), teacher.id, [fr], [en], status, into);
  const three = async () => [await concept("A", "A"), await concept("B", "B"), await concept("C", "C")] as [string, string, string];

  const add = (who: Who, id: string, kind: string, target: string) =>
    server.app.inject({ method: "POST", url: `/app/api/admin/concepts/${id}/relations`, headers: who.headers, payload: { kind, target } });
  const remove = (who: Who, id: string, kind: string, target: string) =>
    server.app.inject({ method: "DELETE", url: `/app/api/admin/concepts/${id}/relations/${kind}/${target}`, headers: who.headers });
  const merge = (id: string, into: string) =>
    server.app.inject({ method: "POST", url: `/app/api/admin/concepts/${id}/merge`, headers: admin.headers, payload: { into, keepAsAlias: false } });
  const edges = async () => (await db().select().from(conceptRelations)).map((r) => `${r.kind}:${r.conceptId}>${r.targetId}`).sort();
  const mergeAudit = async (loser: string) => {
    const [entry] = await db().select().from(auditLog).where(and(eq(auditLog.subjectId, loser), eq(auditLog.action, "concept.merge")));
    return entry?.payload as Record<string, { broader: unknown[]; related: unknown[]; hierarchical?: unknown[] }>;
  };

  beforeAll(async () => {
    server = await testServer();
    teacher = await server.signIn("teacher");
    admin = await server.signIn("admin");
    student = await server.signIn("student");
  });

  beforeEach(async () => {
    await db().delete(concepts);
  });

  afterAll(async () => {
    await server.close();
  });

  describe("relations routes", () => {
    it("are the admin's: a teacher and a student get a 403", async () => {
      const [a, b] = await three();
      for (const who of [teacher, student]) {
        expect((await add(who, a, "broader", b)).statusCode).toBe(403);
        expect((await remove(who, a, "broader", b)).statusCode).toBe(403);
      }
      expect(await edges()).toEqual([]);
    });

    it("add broader (several parents) and related, answer the concept, and read back on both sides", async () => {
      const [a, b, c] = await three();
      expect(Concept.parse((await add(admin, a, "broader", b)).json()).broader).toEqual([b]);
      expect(Concept.parse((await add(admin, a, "broader", c)).json()).broader).toEqual([b, c].sort());
      const [lo, hi] = [b, c].sort() as [string, string];
      expect((await add(admin, hi, "related", lo)).statusCode).toBe(200);
      expect(await edges()).toContain(`related:${lo}>${hi}`);
      const list = ConceptList.parse((await server.app.inject({ method: "GET", url: "/app/api/concepts", headers: teacher.headers })).json());
      expect(list.concepts.find((x) => x.id === lo)?.related).toEqual([hi]);
      expect(list.concepts.find((x) => x.id === hi)?.related).toEqual([lo]);
      const queue = AdminConceptList.parse((await server.app.inject({ method: "GET", url: "/app/api/admin/concepts", headers: admin.headers })).json());
      expect(queue.concepts.find((x) => x.id === a)?.broader).toEqual([b, c].sort());
    });

    it("refuse with one code each: self 422, exists 409, redundant 409, cycle 409 with its path, missing target 422, merged 409, unknown 404, bad kind 400", async () => {
      const [a, b, c] = await three();
      const gone = await concept("Gone", "Gone", "merged", b);
      expect((await add(admin, a, "related", a)).json()).toMatchObject({ error: "relation_self" });
      await add(admin, a, "broader", b);
      expect((await add(admin, a, "broader", b)).json()).toMatchObject({ error: "relation_exists" });
      expect((await add(admin, b, "related", a)).json()).toMatchObject({ error: "relation_redundant" });
      await add(admin, b, "broader", c);
      const res = await add(admin, c, "broader", a);
      expect(res.statusCode).toBe(409);
      const cycle = ConceptCycle.parse(res.json());
      expect(cycle.error).toBe("concept_cycle");
      expect(cycle.path.map((p) => p.label)).toEqual(["C", "A", "B", "C"]);
      expect((await add(admin, a, "broader", randomUUID())).json()).toMatchObject({ error: "concept_not_found" });
      expect((await add(admin, a, "related", gone)).json()).toMatchObject({ error: "concept_not_found" });
      expect((await add(admin, gone, "related", a)).json()).toMatchObject({ error: "concept_merged" });
      expect((await add(admin, randomUUID(), "related", a)).statusCode).toBe(404);
      expect((await add(admin, a, "nope", b)).statusCode).toBe(400);
      expect(await edges()).toHaveLength(2);
    });

    it("serialize two opposite edges sent together: exactly one gets in", async () => {
      const [a, b] = await three();
      const [one, two] = await Promise.all([add(admin, a, "broader", b), add(admin, b, "broader", a)]);
      expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
      expect(await edges()).toHaveLength(1);
    });

    it("remove an edge (a related pair from either side) and audit both writes", async () => {
      const [a, b, c] = await three();
      await add(admin, a, "broader", b);
      await add(admin, a, "related", c);
      expect((await remove(admin, b, "broader", a)).statusCode).toBe(404);
      expect(Concept.parse((await remove(admin, a, "broader", b)).json()).broader).toEqual([]);
      expect(Concept.parse((await remove(admin, c, "related", a)).json()).related).toEqual([]);
      expect((await remove(admin, c, "related", a)).statusCode).toBe(404);
      const entries = await db().select().from(auditLog).where(eq(auditLog.subjectId, a));
      expect(entries.find((e) => e.action === "concept.relation_add")?.payload).toEqual({ kind: "broader", target: b, labels: { fr: "B", en: "B" } });
      expect(entries.find((e) => e.action === "concept.relation_remove" && (e.payload as { kind: string }).kind === "broader")?.payload).toEqual({
        kind: "broader",
        target: b,
      });
    });
  });

  describe("deletion", () => {
    it("is not blocked by relations, which go with the concept", async () => {
      const [a, b] = await three();
      await add(admin, a, "broader", b);
      const queue = AdminConceptList.parse((await server.app.inject({ method: "GET", url: "/app/api/admin/concepts", headers: admin.headers })).json());
      expect(queue.concepts.find((x) => x.id === b)?.deletable).toBe(true);
      expect((await server.app.inject({ method: "DELETE", url: `/app/api/admin/concepts/${b}`, headers: admin.headers })).statusCode).toBe(204);
      expect(await edges()).toEqual([]);
    });

    it("takes turns with a merge that is rewriting a relation to the deleted concept", async () => {
      const [loser, winner, x] = await three();
      await add(admin, loser, "broader", x);
      const [merged, deleted] = await Promise.all([
        merge(loser, winner),
        server.app.inject({ method: "DELETE", url: `/app/api/admin/concepts/${x}`, headers: admin.headers }),
      ]);
      expect([merged.statusCode, deleted.statusCode]).toEqual([200, 204]);
      expect(await edges()).toEqual([]);
    });
  });

  describe("merge", () => {
    it("rewrites the loser's edges onto the winner and audits them", async () => {
      const [loser, winner, up] = await three();
      const down = await concept("Down", "Down");
      const side = await concept("Side", "Side");
      await add(admin, loser, "broader", up);
      await add(admin, down, "broader", loser);
      await add(admin, loser, "related", side);
      const res = await merge(loser, winner);
      expect(res.statusCode, res.body).toBe(200);
      expect(Concept.parse(res.json())).toMatchObject({ broader: [up], related: [side] });
      const [lo, hi] = [winner, side].sort();
      expect(await edges()).toEqual([`broader:${winner}>${up}`, `broader:${down}>${winner}`, `related:${lo}>${hi}`].sort());
      const audit = await mergeAudit(loser);
      expect(audit.relationsOfLoser?.broader).toHaveLength(2);
      expect(audit.relationsMoved?.broader).toHaveLength(2);
    });

    it("drops the edges between the two, and a related edge whose pair becomes a broader pair, and lists them", async () => {
      const [loser, winner, x] = await three();
      await add(admin, loser, "broader", winner);
      await add(admin, loser, "related", x);
      await add(admin, winner, "broader", x);
      expect((await merge(loser, winner)).statusCode).toBe(200);
      expect(await edges()).toEqual([`broader:${winner}>${x}`]);
      const dropped = (await mergeAudit(loser)).relationsDropped!;
      expect(dropped.broader).toEqual([{ concept: loser, target: winner }]);
      expect(dropped.hierarchical).toEqual([expect.objectContaining({})]);
    });

    it("refuses a longer cycle with the path and writes nothing", async () => {
      const [loser, winner, mid] = await three();
      await add(admin, loser, "broader", mid);
      await add(admin, mid, "broader", winner);
      const before = await edges();
      const res = await merge(loser, winner);
      expect(res.statusCode).toBe(409);
      const body = ConceptCycle.parse(res.json());
      expect(body.error).toBe("concept_merge_cycle");
      expect(body.path.map((p) => p.id)).toEqual([winner, mid, winner]);
      expect(await edges()).toEqual(before);
      expect((await db().select().from(concepts).where(eq(concepts.id, loser)))[0]?.status).toBe("validated");
    });
  });
});

/**
 * `GET /admin/concepts/relations/candidates` (#897 step A1, ADR-114): the
 * wiring on real rows, the rule matrix being `@quiz/domain`'s. The admin's
 * alone; containment skips an existing edge and a would-be cycle;
 * co-occurrence counts live questions only, under both thresholds; counts
 * only leave; nothing is written.
 */
describe("relation candidates", () => {
  type Who = Awaited<ReturnType<TestServer["signIn"]>>;

  let server: TestServer;
  let teacher: Who;
  let admin: Who;
  let poolId: string;
  const db = () => server.app.db;

  const concept = (fr: ConceptSide, en: ConceptSide = null, status: "proposed" | "validated" | "merged" = "validated", into: string | null = null) =>
    seedConcept(db(), teacher.id, fr, en, status, into);

  /** A question named `name` carrying `conceptIds`, soft-deleted when asked. */
  async function question(name: string, conceptIds: readonly string[], deleted = false) {
    const q = await poolService.createQuestion(db(), { poolId, type: "short", internalName: name, createdBy: teacher.id });
    await db().insert(questionConcepts).values(conceptIds.map((conceptId) => ({ questionId: q.id, conceptId })));
    if (deleted) await db().update(questions).set({ deletedAt: new Date() }).where(eq(questions.id, q.id));
    return q.id;
  }

  const get = (who?: Who) =>
    server.app.inject({ method: "GET", url: "/app/api/admin/concepts/relations/candidates", ...(who && { headers: who.headers }) });
  const read = async () => {
    const res = await get(admin);
    expect(res.statusCode, res.body).toBe(200);
    return ConceptRelationCandidates.parse(res.json());
  };
  /** A related candidate's two ids, in canonical order. */
  const pair = (x: string, y: string) => (x < y ? { concept: x, target: y } : { concept: y, target: x });
  const broader = (concept: string, target: string) =>
    db().insert(conceptRelations).values({ conceptId: concept, targetId: target, kind: "broader", createdBy: admin.id });

  beforeAll(async () => {
    server = await testServer();
    teacher = await server.signIn("teacher");
    admin = await server.signIn("admin");
    poolId = randomUUID();
    await db().insert(pools).values({ id: poolId, name: "Secret exam pool", ownerId: teacher.id });
  });

  beforeEach(async () => {
    await db().delete(questionConcepts);
    await db().delete(questions);
    await db().delete(conceptRelations);
    await db().delete(concepts);
  });

  afterAll(async () => {
    await server.close();
  });

  describe("GET /admin/concepts/relations/candidates", () => {
    it("proposes a contained label as broader, skipping an existing edge and a would-be cycle", async () => {
      const pointer = await concept(["Pointeur"], ["Pointer"]);
      const arith = await concept(["Arithmétique des pointeurs"], ["Pointer arithmetic"], "proposed");
      const tree = await concept(["Arbre"], ["Tree"]);
      const binary = await concept(["Arbre binaire"], ["Binary tree"]);
      const stack = await concept(["Pile"], ["Stack"]);
      const callStack = await concept(["Pile d'appels"], ["Call stack"]);
      await concept(["Arithmétique"], ["Arithmetic"], "merged", pointer);
      await broader(binary, tree);
      await broader(stack, callStack);
      expect((await read()).candidates).toEqual([{ kind: "broader", concept: arith, target: pointer, questions: null }]);
    });

    it("counts live questions only, under both thresholds, most shared first", async () => {
      const [a, b, c, d, e] = await Promise.all(["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((l) => concept([l])));
      // a + b on three live questions (and a deleted fourth): 3 of 3.
      for (const n of [1, 2, 3]) await question(`ab${n}`, [a!, b!]);
      await question("ab-deleted", [a!, b!], true);
      // c + d on four live questions of four: the most shared.
      for (const n of [1, 2, 3, 4]) await question(`cd${n}`, [c!, d!]);
      // a + e on three, but the less used, `e`, is on seven: 3 of 7 is under half.
      for (const n of [1, 2, 3]) await question(`ae${n}`, [a!, e!]);
      for (const n of [1, 2, 3, 4]) await question(`e${n}`, [e!]);
      for (const n of [1, 2, 3, 4]) await question(`a${n}`, [a!]);
      // b + c on two live questions and two deleted ones: under the minimum.
      for (const n of [1, 2]) await question(`bc${n}`, [b!, c!]);
      for (const n of [3, 4]) await question(`bc${n}`, [b!, c!], true);
      expect((await read()).candidates).toEqual([
        { kind: "related", ...pair(c!, d!), questions: 4 },
        { kind: "related", ...pair(a!, b!), questions: 3 },
      ]);
    });

    it("names concepts by id and counts only, merged concepts left out, and writes nothing", async () => {
      const x = await concept(["Xylophone"]);
      const y = await concept(["Yacht"]);
      const z = await concept(["Zèbre"]);
      const ids = [];
      for (const n of [1, 2, 3]) ids.push(await question(`Secret question ${n}`, [x, y]));
      await db().update(concepts).set({ status: "merged", mergedInto: x }).where(eq(concepts.id, z));
      for (const n of [4, 5, 6]) ids.push(await question(`Secret question ${n}`, [x, z]));
      const before = {
        concepts: await db().select().from(concepts),
        relations: await db().select().from(conceptRelations),
        audit: (await db().select().from(auditLog)).length,
      };
      const res = await get(admin);
      expect(res.statusCode).toBe(200);
      expect(res.json().candidates).toEqual([{ kind: "related", ...pair(x, y), questions: 3 }]);
      for (const secret of [...ids, "Secret question", "Secret exam pool", poolId, teacher.id]) expect(res.body).not.toContain(secret);
      expect(await db().select().from(concepts)).toEqual(before.concepts);
      expect(await db().select().from(conceptRelations)).toEqual(before.relations);
      expect((await db().select().from(auditLog)).length).toBe(before.audit);
    });
  });
});
