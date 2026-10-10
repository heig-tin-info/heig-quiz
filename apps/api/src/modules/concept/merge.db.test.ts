/**
 * `POST /admin/concepts/:id/merge` (ADR-081, fifth addendum §2): one
 * transaction that moves every link, soft-deleted questions included,
 * re-points earlier merges, audits the ids and refuses what it must.
 */
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Concept, ConceptResolveResponse } from "@quiz/contracts";
import { qualifiedConceptKey } from "@quiz/domain";

import { auditLog, concepts, pools, questionConcepts, questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import * as poolService from "../pool/service.js";
import * as service from "./service.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let teacher: Who;
let admin: Who;
let student: Who;
let poolId: string;
const db = () => server.app.db;

async function concept(
  fr: string | null,
  en: string | null,
  status: "proposed" | "validated" | "merged" = "validated",
  mergedInto: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await db()
    .insert(concepts)
    .values({
      id,
      status,
      mergedInto,
      createdBy: teacher.id,
      labelFr: fr,
      keyFr: fr === null ? null : qualifiedConceptKey(fr, ""),
      labelEn: en,
      keyEn: en === null ? null : qualifiedConceptKey(en, ""),
    });
  return id;
}

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

const linksOf = async (conceptId: string) =>
  (await db().select().from(questionConcepts).where(eq(questionConcepts.conceptId, conceptId)))
    .map((l) => l.questionId)
    .sort();

const merge = (who: Who, id: string, into: string) =>
  server.app.inject({
    method: "POST",
    url: `/app/api/admin/concepts/${id}/merge`,
    headers: who.headers,
    payload: { into },
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
      repointed: [old],
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
      (await server.app.inject({ method: "POST", url: `/app/api/admin/concepts/${loser}/merge`, payload: { into: winner } }))
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
