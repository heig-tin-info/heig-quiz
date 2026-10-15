/**
 * The pool's concept map (ADR-116): `GET /pools/:id/concept-map` and the
 * covered counts of `PoolDetail.concepts`, one computation. A concept's
 * number is what its click opens: the pool's filter on it, widened to its
 * narrower concepts (ADR-081 §4). The counting rule itself is
 * `conceptMap.test.ts`'s (`@quiz/domain`); this file proves what the database
 * adds: live questions of this pool only, labels, a merge, and the pool's
 * loader in front of the route.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PoolConceptMap, PoolDetail, QuestionPage } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { conceptRelations } from "../../db/schema.js";
import { seedConcept } from "../../test/concepts.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let owner: Who;
const db = () => server.app.db;

const names = ["top", "root", "leaf", "x"] as const;
type Name = (typeof names)[number];
const c = {} as Record<Name, string>;
const nameOf = (id: string) => names.find((n) => c[n] === id)!;
let poolId: string;

const call = (who: Who | null, method: "GET" | "POST" | "DELETE", url: string, payload?: object, lang = "en") =>
  server.app.inject({
    method,
    url,
    headers: { ...(who?.headers ?? {}), "accept-language": lang },
    ...(payload ? { payload } : {}),
  });
const conceptMapOf = (who: Who | null, id = poolId, lang = "en") => call(who, "GET", `/app/api/pools/${id}/concept-map`, undefined, lang);

async function question(pool: string, name: string, concepts: Name[]): Promise<string> {
  const res = await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type: "short", internalName: name, concepts: concepts.map((n) => c[n]) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().meta.id;
}

/** Every node by concept name: `[covered, own]`. */
async function counts(): Promise<Record<string, [number, number]>> {
  const res = await conceptMapOf(owner);
  expect(res.statusCode, res.body).toBe(200);
  return Object.fromEntries(PoolConceptMap.parse(res.json()).nodes.map((n) => [nameOf(n.concept.id), [n.covered, n.own]]));
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  for (const n of names) c[n] = await seedConcept(db(), owner.id, [`fr ${n}`], [`en ${n}`]);
  // top <- root <- leaf; x stands alone.
  await db().insert(conceptRelations).values([
    { conceptId: c.root, targetId: c.top, kind: "broader" },
    { conceptId: c.leaf, targetId: c.root, kind: "broader" },
  ]);

  poolId = (await call(owner, "POST", "/app/api/pools", { name: "Map" })).json().id;
  const elsewhere = (await call(owner, "POST", "/app/api/pools", { name: "Elsewhere" })).json().id;
  await question(poolId, "q1", ["leaf"]);
  await question(poolId, "q3", ["root", "x"]);
  const q7 = await question(poolId, "q7", ["leaf"]);
  expect((await call(owner, "DELETE", `/app/api/questions/${q7}`)).statusCode).toBeLessThan(300);
  await question(elsewhere, "q8", ["root"]);
  await question(poolId, "q9", []);
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("GET /pools/:id/concept-map", () => {
  it("counts the pool's live questions only, and answers the broader edges among the reached concepts", async () => {
    // q7 (deleted) and q8 (another pool) are never counted; top is reached only from below.
    expect(await counts()).toEqual({ top: [2, 0], root: [2, 1], leaf: [1, 1], x: [1, 1] });
    const map = PoolConceptMap.parse((await conceptMapOf(owner)).json());
    expect(map.broader.map((e) => `${nameOf(e.concept)}<${nameOf(e.target)}`).sort()).toEqual(["leaf<root", "root<top"]);
  });

  it("labels the nodes in the reader's language, by label", async () => {
    const fr = PoolConceptMap.parse((await conceptMapOf(owner, poolId, "fr")).json());
    expect(fr.nodes.map((n) => n.concept.label)).toEqual(["fr leaf", "fr root", "fr top", "fr x"]);
  });

  it("gives each node the number its click opens: the pool's filter on that concept", async () => {
    const map = PoolConceptMap.parse((await conceptMapOf(owner)).json());
    for (const node of map.nodes) {
      const res = await call(owner, "GET", `/app/api/pools/${poolId}/questions?concept=${node.concept.id}`);
      expect(QuestionPage.parse(res.json()).total, node.concept.label).toBe(node.covered);
    }
  });

  it("lists in the pool's detail the linked concepts only, each with its covered count", async () => {
    const detail = PoolDetail.parse((await call(owner, "GET", `/app/api/pools/${poolId}`)).json());
    expect(Object.fromEntries(detail.concepts.map((p) => [nameOf(p.concept.id), p.count]))).toEqual({ root: 2, leaf: 1, x: 1 });
  });

  it("follows a merge: the merged concept is gone, the winner counts the union", async () => {
    const admin = await server.signIn("admin");
    const merged = await call(admin, "POST", `/app/api/admin/concepts/${c.x}/merge`, { into: c.leaf, keepAsAlias: false });
    expect(merged.statusCode, merged.body).toBe(200);
    // q3 is on leaf now: root owns nothing of its own.
    expect(await counts()).toEqual({ top: [2, 0], root: [2, 0], leaf: [2, 2] });
  });
});

describe("who reads the concept map: the pool's loader", () => {
  it("is read by a reader of the pool", async () => {
    const reader = await server.signIn("teacher");
    const added = await call(owner, "POST", `/app/api/pools/${poolId}/members`, { userId: reader.id, role: "reader" });
    expect(added.statusCode, added.body).toBeLessThan(300);
    expect((await conceptMapOf(reader)).statusCode).toBe(200);
  });

  it("is the 404 of a missing pool for an outsider, and a 403 for a student", async () => {
    const missing = await conceptMapOf(owner, randomUUID());
    expect(missing.statusCode).toBe(404);
    const outsider = await conceptMapOf(await server.signIn("teacher"));
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toEqual(missing.json());
    expect((await conceptMapOf(await server.signIn("student"))).statusCode).toBe(403);
  });
});
