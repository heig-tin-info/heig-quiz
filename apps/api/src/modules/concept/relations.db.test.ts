/**
 * Relations between concepts (ADR-081 §4, sixth addendum 7c): the admin's
 * `POST /admin/concepts/:id/relations` and `DELETE .../relations/:kind/:target`,
 * the cycle refusal, the canonical order of `related`, the cascade and the
 * rewrite by a merge.
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

const add = (who: Who, id: string, kind: string, target: string) =>
  server.app.inject({ method: "POST", url: `/app/api/admin/concepts/${id}/relations`, headers: who.headers, payload: { kind, target } });
const remove = (who: Who, id: string, kind: string, target: string) =>
  server.app.inject({ method: "DELETE", url: `/app/api/admin/concepts/${id}/relations/${kind}/${target}`, headers: who.headers });
const merge = (id: string, into: string) =>
  server.app.inject({
    method: "POST",
    url: `/app/api/admin/concepts/${id}/merge`,
    headers: admin.headers,
    payload: { into, keepAsAlias: false },
  });
const edges = async () =>
  (await db().select().from(conceptRelations)).map((r) => `${r.kind}:${r.conceptId}>${r.targetId}`).sort();

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

describe("POST /admin/concepts/:id/relations", () => {
  it("is the admin's: a teacher gets a 403, a student too", async () => {
    const [a, b] = [await concept("A", "A"), await concept("B", "B")];
    expect((await add(teacher, a, "broader", b)).statusCode).toBe(403);
    expect((await add(student, a, "broader", b)).statusCode).toBe(403);
    expect((await remove(teacher, a, "broader", b)).statusCode).toBe(403);
    expect(await edges()).toEqual([]);
  });

  it("adds a broader edge, several parents allowed, and answers the concept", async () => {
    const [child, p1, p2] = [await concept("Arithmétique de pointeurs", "Pointer arithmetic"), await concept("Pointeur", "Pointer"), await concept("C", "C")];
    expect(Concept.parse((await add(admin, child, "broader", p1)).json()).broader).toEqual([p1]);
    const res = await add(admin, child, "broader", p2);
    expect(res.statusCode, res.body).toBe(200);
    expect(Concept.parse(res.json()).broader).toEqual([p1, p2].sort());
    expect(await edges()).toEqual([`broader:${child}>${p1}`, `broader:${child}>${p2}`].sort());
  });

  it("reads back in the lists, on both sides of a related edge", async () => {
    const [a, b, c] = [await concept("A", "A"), await concept("B", "B"), await concept("C", "C")];
    await add(admin, a, "broader", c);
    await add(admin, b, "related", a);
    const list = ConceptList.parse((await server.app.inject({ method: "GET", url: "/app/api/concepts", headers: teacher.headers })).json());
    expect(list.concepts.find((x) => x.id === a)).toMatchObject({ broader: [c], related: [b] });
    expect(list.concepts.find((x) => x.id === b)).toMatchObject({ broader: [], related: [a] });
    const queue = AdminConceptList.parse((await server.app.inject({ method: "GET", url: "/app/api/admin/concepts", headers: admin.headers })).json());
    expect(queue.concepts.find((x) => x.id === c)).toMatchObject({ broader: [], related: [] });
  });

  it("stores a related pair once, in canonical order, whichever side is asked", async () => {
    const [a, b] = [await concept("A", "A"), await concept("B", "B")];
    const [lo, hi] = [a, b].sort() as [string, string];
    expect((await add(admin, hi, "related", lo)).statusCode).toBe(200);
    expect(await edges()).toEqual([`related:${lo}>${hi}`]);
    const again = await add(admin, lo, "related", hi);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "relation_exists" });
  });

  it("refuses itself (422), a duplicate (409), a missing or merged target (422) and a merged concept (409)", async () => {
    const [a, b] = [await concept("A", "A"), await concept("B", "B")];
    const gone = await concept("Gone", "Gone", "merged", b);
    for (const kind of ["broader", "related"]) {
      expect((await add(admin, a, kind, a)).json()).toMatchObject({ error: "relation_self" });
    }
    await add(admin, a, "broader", b);
    expect((await add(admin, a, "broader", b)).json()).toMatchObject({ error: "relation_exists" });
    expect((await add(admin, a, "broader", randomUUID())).json()).toMatchObject({ error: "concept_not_found" });
    expect((await add(admin, a, "related", gone)).json()).toMatchObject({ error: "concept_not_found" });
    expect((await add(admin, gone, "related", a)).json()).toMatchObject({ error: "concept_merged" });
    expect((await add(admin, randomUUID(), "related", a)).statusCode).toBe(404);
    expect((await server.app.inject({ method: "POST", url: `/app/api/admin/concepts/${a}/relations`, headers: admin.headers, payload: { kind: "nope", target: b } })).statusCode).toBe(400);
  });

  it("refuses the opposite broader edge and a long cycle with 409 naming the path", async () => {
    const [a, b, c] = [await concept("A", "A"), await concept("B", "B"), await concept("C", "C")];
    await add(admin, a, "broader", b);
    await add(admin, b, "broader", c);
    const res = await add(admin, c, "broader", a);
    expect(res.statusCode).toBe(409);
    const body = ConceptCycle.parse(res.json());
    expect(body.error).toBe("concept_cycle");
    expect(body.path.map((p) => p.id)).toEqual([c, a, b, c]);
    expect(body.path.map((p) => p.label)).toEqual(["C", "A", "B", "C"]);
    expect(await edges()).toHaveLength(2);
  });

  it("refuses related for two concepts of one broader chain, and broader for a related pair", async () => {
    const [a, b, c] = [await concept("A", "A"), await concept("B", "B"), await concept("C", "C")];
    await add(admin, a, "broader", b);
    await add(admin, b, "broader", c);
    expect((await add(admin, c, "related", a)).json()).toMatchObject({ error: "relation_redundant" });
    expect((await add(admin, a, "related", b)).json()).toMatchObject({ error: "relation_redundant" });
    const [x, y] = [await concept("X", "X"), await concept("Y", "Y")];
    await add(admin, x, "related", y);
    expect((await add(admin, y, "broader", x)).json()).toMatchObject({ error: "relation_redundant" });
  });

  it("serializes two opposite edges sent together: exactly one gets in", async () => {
    const [a, b] = [await concept("A", "A"), await concept("B", "B")];
    const [one, two] = await Promise.all([add(admin, a, "broader", b), add(admin, b, "broader", a)]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    expect(await edges()).toHaveLength(1);
  });

  it("audits an add and a removal", async () => {
    const [a, b] = [await concept("A", "A"), await concept("B", "B")];
    await add(admin, a, "broader", b);
    await remove(admin, a, "broader", b);
    const entries = await db().select().from(auditLog).where(eq(auditLog.subjectId, a));
    const added = entries.find((e) => e.action === "concept.relation_add");
    const removed = entries.find((e) => e.action === "concept.relation_remove");
    expect(added).toMatchObject({ subjectType: "concept", actorUserId: admin.id });
    expect(added?.payload).toEqual({ kind: "broader", target: b, labels: { fr: "B", en: "B" } });
    expect(removed?.payload).toEqual({ kind: "broader", target: b });
  });
});

describe("DELETE /admin/concepts/:id/relations/:kind/:target", () => {
  it("removes a broader edge only in its direction, and a related pair from either side", async () => {
    const [a, b, c] = [await concept("A", "A"), await concept("B", "B"), await concept("C", "C")];
    await add(admin, a, "broader", b);
    await add(admin, a, "related", c);
    expect((await remove(admin, b, "broader", a)).statusCode).toBe(404);
    expect(Concept.parse((await remove(admin, a, "broader", b)).json()).broader).toEqual([]);
    expect(Concept.parse((await remove(admin, c, "related", a)).json()).related).toEqual([]);
    expect(await edges()).toEqual([]);
    expect((await remove(admin, c, "related", a)).statusCode).toBe(404);
    expect((await remove(admin, randomUUID(), "related", a)).statusCode).toBe(404);
  });
});

describe("deletion", () => {
  it("is not blocked by relations, which go with the concept", async () => {
    const [a, b] = [await concept("A", "A"), await concept("B", "B")];
    await add(admin, a, "broader", b);
    const queue = AdminConceptList.parse((await server.app.inject({ method: "GET", url: "/app/api/admin/concepts", headers: admin.headers })).json());
    expect(queue.concepts.find((x) => x.id === b)?.deletable).toBe(true);
    const res = await server.app.inject({ method: "DELETE", url: `/app/api/admin/concepts/${b}`, headers: admin.headers });
    expect(res.statusCode).toBe(204);
    expect(await edges()).toEqual([]);
  });
});

describe("merge", () => {
  it("rewrites the loser's edges onto the winner, both directions and both kinds", async () => {
    const [loser, winner, up, down, side] = [
      await concept("Pointage", "Pointing"),
      await concept("Pointeur", "Pointer"),
      await concept("Mémoire", "Memory"),
      await concept("Arithmétique", "Arithmetic"),
      await concept("Référence", "Reference"),
    ];
    await add(admin, loser, "broader", up);
    await add(admin, down, "broader", loser);
    await add(admin, loser, "related", side);
    const res = await merge(loser, winner);
    expect(res.statusCode, res.body).toBe(200);
    expect(Concept.parse(res.json())).toMatchObject({ broader: [up], related: [side] });
    const [lo, hi] = [winner, side].sort();
    expect(await edges()).toEqual([`broader:${winner}>${up}`, `broader:${down}>${winner}`, `related:${lo}>${hi}`].sort());
  });

  it("drops the edges between the loser and the winner, and lists them in the audit", async () => {
    const [loser, winner] = [await concept("Pointage", "Pointing"), await concept("Pointeur", "Pointer")];
    await add(admin, loser, "broader", winner);
    expect((await merge(loser, winner)).statusCode).toBe(200);
    expect(await edges()).toEqual([]);
    const [entry] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, loser), eq(auditLog.action, "concept.merge")));
    const payload = entry?.payload as Record<string, { broader: unknown[]; related: unknown[] }>;
    expect(payload.relationsDropped).toEqual({ broader: [{ concept: loser, target: winner }], related: [] });
    expect(payload.relationsMoved).toEqual({ broader: [], related: [] });
    expect(payload.relationsOfLoser?.broader).toHaveLength(1);
  });

  it("does not write twice an edge the winner has", async () => {
    const [loser, winner, up] = [await concept("Pointage", "Pointing"), await concept("Pointeur", "Pointer"), await concept("Mémoire", "Memory")];
    await add(admin, loser, "broader", up);
    await add(admin, winner, "broader", up);
    expect((await merge(loser, winner)).statusCode).toBe(200);
    expect(await edges()).toEqual([`broader:${winner}>${up}`]);
    const [entry] = await db().select().from(auditLog).where(and(eq(auditLog.subjectId, loser), eq(auditLog.action, "concept.merge")));
    expect((entry?.payload as { relationsDuplicate: unknown }).relationsDuplicate).toEqual({
      broader: [{ concept: winner, target: up }],
      related: [],
    });
  });

  it("refuses a merge that would close a longer cycle, naming the path, and writes nothing", async () => {
    // loser is below mid, mid is below winner: the merge would make winner below mid below winner.
    const [loser, winner, mid] = [await concept("Pointage", "Pointing"), await concept("Pointeur", "Pointer"), await concept("Milieu", "Middle")];
    await add(admin, loser, "broader", mid);
    await add(admin, mid, "broader", winner);
    const before = await edges();
    const res = await merge(loser, winner);
    expect(res.statusCode).toBe(409);
    const body = ConceptCycle.parse(res.json());
    expect(body.error).toBe("concept_merge_cycle");
    expect(body.path.map((p) => p.id)).toEqual([winner, mid, winner]);
    expect(await edges()).toEqual(before);
    const [row] = await db().select().from(concepts).where(eq(concepts.id, loser));
    expect(row?.status).toBe("validated");
  });
});
