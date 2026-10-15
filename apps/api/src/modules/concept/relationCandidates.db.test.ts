/**
 * `GET /admin/concepts/relations/candidates` (#897 step A1, ADR-114): the
 * wiring on real rows, the rule matrix being `@quiz/domain`'s. The admin's
 * alone; containment skips an existing edge and a would-be cycle;
 * co-occurrence counts live questions only, under both thresholds; counts
 * only leave; nothing is written.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConceptRelationCandidates } from "@quiz/contracts";

import { auditLog, conceptRelations, concepts, pools, questionConcepts, questions } from "../../db/schema.js";
import { seedConcept, type ConceptSide } from "../../test/concepts.js";
import { testServer, type TestServer } from "../../test/http.js";
import * as poolService from "../pool/service.js";

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
  it("is the admin's alone", async () => {
    expect((await get(teacher)).statusCode).toBe(403);
    expect((await get()).statusCode).toBe(401);
  });

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
    expect((await read()).contained).toEqual([{ concept: arith, target: pointer }]);
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
    const pair = (x: string, y: string) => (x < y ? { a: x, b: y } : { a: y, b: x });
    expect((await read()).together).toEqual([
      { ...pair(c!, d!), questions: 4 },
      { ...pair(a!, b!), questions: 3 },
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
    expect(res.json().together).toEqual([{ ...(x < y ? { a: x, b: y } : { a: y, b: x }), questions: 3 }]);
    for (const secret of [...ids, "Secret question", "Secret exam pool", poolId, teacher.id]) expect(res.body).not.toContain(secret);
    expect(await db().select().from(concepts)).toEqual(before.concepts);
    expect(await db().select().from(conceptRelations)).toEqual(before.relations);
    expect((await db().select().from(auditLog)).length).toBe(before.audit);
  });
});
