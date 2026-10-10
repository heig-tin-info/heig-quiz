/**
 * Relations between concepts (ADR-081 §4, sixth addendum 7c): the wiring
 * only, the rule matrix being `@quiz/domain`'s. One refusal per HTTP code,
 * the lock race, the cascade, the audit, a merge's rewrite, its drops and
 * its cycle, and the deletion that takes the same lock.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AdminConceptList, Concept, ConceptCycle, ConceptList } from "@quiz/contracts";

import { auditLog, conceptRelations, concepts } from "../../db/schema.js";
import { seedConcept } from "../../test/concepts.js";
import { testServer, type TestServer } from "../../test/http.js";

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
