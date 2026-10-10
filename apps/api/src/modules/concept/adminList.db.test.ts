/**
 * `GET /admin/concepts`, the curation queue (ADR-081 fifth addendum): the
 * admin alone, `proposed` first, the instance-wide count of live questions
 * (a number, even for a pool the admin cannot reach), what `deletable` says,
 * the filters and the paging.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AdminConceptList } from "@quiz/contracts";
import { qualifiedConceptKey } from "@quiz/domain";

import { concepts, pools, questionConcepts, questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import * as poolService from "../pool/service.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let teacher: Who;
let admin: Who;
let student: Who;
let poolId: string;
const db = () => server.app.db;

async function concept(
  fr: [string, string?] | null,
  en: [string, string?] | null = null,
  status: "proposed" | "validated" | "merged" = "validated",
  mergedInto: string | null = null,
): Promise<string> {
  const id = randomUUID();
  const side = (s: [string, string?] | null) => ({ label: s?.[0] ?? null, qualifier: s?.[1] ?? "" });
  const f = side(fr);
  const e = side(en);
  await db()
    .insert(concepts)
    .values({
      id,
      status,
      mergedInto,
      createdBy: teacher.id,
      labelFr: f.label,
      qualifierFr: f.qualifier,
      keyFr: f.label === null ? null : qualifiedConceptKey(f.label, f.qualifier),
      labelEn: e.label,
      qualifierEn: e.qualifier,
      keyEn: e.label === null ? null : qualifiedConceptKey(e.label, e.qualifier),
    });
  return id;
}

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
  student = await server.signIn("student");
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
  it("is the admin's alone", async () => {
    expect((await list(teacher)).statusCode).toBe(403);
    expect((await list(student)).statusCode).toBe(403);
    expect((await server.app.inject({ method: "GET", url: "/app/api/admin/concepts" })).statusCode).toBe(401);
  });

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
