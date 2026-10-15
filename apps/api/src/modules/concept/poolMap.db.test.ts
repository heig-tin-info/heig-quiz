/**
 * The pool's concept map (ADR-116): `GET /pools/:id/concept-map` and the
 * covered counts of `PoolDetail.concepts`, one computation. A concept's
 * number is what its click opens: the pool's filter on it, widened to its
 * narrower concepts (ADR-081 §4). Only `broader` edges count; the route is
 * read by whoever reads the pool, and by nobody else.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PoolConceptMap, PoolDetail, QuestionPage } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { conceptRelations, coursePools, courseStaff, courses } from "../../db/schema.js";
import { seedConcept } from "../../test/concepts.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let owner: Who;
const db = () => server.app.db;

const names = ["top", "root", "mid", "leaf", "other", "side", "lonely", "x"] as const;
type Name = (typeof names)[number];
const c = {} as Record<Name, string>;
const nameOf = (id: string) => names.find((n) => c[n] === id)!;
let poolId: string;
let otherPoolId: string;

const call = (who: Who | null, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, lang = "en") =>
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
  // top <- root <- mid <- leaf, root <- other; side under both leaf and other; lonely only related to root.
  const broader = (concept: Name, target: Name) => ({ conceptId: c[concept], targetId: c[target], kind: "broader" as const });
  await db().insert(conceptRelations).values([
    broader("root", "top"),
    broader("mid", "root"),
    broader("leaf", "mid"),
    broader("other", "root"),
    broader("side", "leaf"),
    broader("side", "other"),
  ]);
  const [a, b] = [c.root, c.lonely].sort();
  await db().insert(conceptRelations).values({ conceptId: a!, targetId: b!, kind: "related" });

  poolId = (await call(owner, "POST", "/app/api/pools", { name: "Map" })).json().id;
  otherPoolId = (await call(owner, "POST", "/app/api/pools", { name: "Elsewhere" })).json().id;
  await question(poolId, "q1", ["leaf"]);
  await question(poolId, "q2", ["mid", "other"]);
  await question(poolId, "q3", ["root", "x"]);
  await question(poolId, "q4", ["root", "mid"]);
  await question(poolId, "q5", ["side"]);
  await question(poolId, "q6", ["lonely"]);
  const q7 = await question(poolId, "q7", ["leaf"]);
  expect((await call(owner, "DELETE", `/app/api/questions/${q7}`)).statusCode).toBeLessThan(300);
  await question(otherPoolId, "q8", ["root"]);
  await question(poolId, "q9", []);
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("GET /pools/:id/concept-map", () => {
  it("counts each concept with its narrower ones, once each; own is what none of them has", async () => {
    expect(await counts()).toEqual({
      // Reached only from below: owns nothing, covers what root covers.
      top: [5, 0],
      // q3, q4 own; q1, q2, q5 below. q8 (another pool) is not counted.
      root: [5, 1],
      // q2 counts once in mid and once in other.
      mid: [4, 2],
      other: [2, 1],
      // q7 is deleted: never counted.
      leaf: [2, 1],
      // Under both leaf and other.
      side: [1, 1],
      // Related to root, not covered by it.
      lonely: [1, 1],
      x: [1, 1],
    });
  });

  it("answers the broader edges among the reached concepts, never a related one", async () => {
    const map = PoolConceptMap.parse((await conceptMapOf(owner)).json());
    const edges = map.broader.map((e) => `${nameOf(e.concept)}<${nameOf(e.target)}`).sort();
    expect(edges).toEqual(["leaf<mid", "mid<root", "other<root", "root<top", "side<leaf", "side<other"]);
  });

  it("labels the nodes in the reader's language, by label", async () => {
    const fr = PoolConceptMap.parse((await conceptMapOf(owner, poolId, "fr")).json());
    expect(fr.nodes.map((n) => n.concept.label)).toEqual(
      ["leaf", "lonely", "mid", "other", "root", "side", "top", "x"].map((n) => `fr ${n}`),
    );
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
    expect(Object.fromEntries(detail.concepts.map((p) => [nameOf(p.concept.id), p.count]))).toEqual({
      root: 5,
      mid: 4,
      other: 2,
      leaf: 2,
      side: 1,
      lonely: 1,
      x: 1,
    });
  });

  it("follows a merge: the merged concept is gone, the winner counts the union", async () => {
    const admin = await server.signIn("admin");
    const merged = await call(admin, "POST", `/app/api/admin/concepts/${c.x}/merge`, { into: c.leaf, keepAsAlias: false });
    expect(merged.statusCode, merged.body).toBe(200);
    const after = await counts();
    expect(after.x).toBeUndefined();
    // q3 now on leaf too: leaf q1, q3, q5; mid q1–q5.
    expect(after.leaf).toEqual([3, 2]);
    expect(after.mid).toEqual([5, 2]);
    // root now owns nothing: q3 and q4 are both under it.
    expect(after.root).toEqual([5, 0]);
  });
});

describe("who reads the concept map", () => {
  it("is read by whoever reads the pool: owner, members, the staff of a linked course, the admin with Super Powers", async () => {
    const contributor = await server.signIn("teacher");
    const reader = await server.signIn("teacher");
    const staff = await server.signIn("teacher");
    for (const [who, role] of [[contributor, "contributor"], [reader, "reader"]] as const) {
      const res = await call(owner, "POST", `/app/api/pools/${poolId}/members`, { userId: who.id, role });
      expect(res.statusCode, res.body).toBeLessThan(300);
    }
    const courseId = randomUUID();
    await db().insert(courses).values({ id: courseId, name: "Map course", code: "MAP" });
    await db().insert(courseStaff).values({ courseId, userId: staff.id, role: "assistant" });
    await db().insert(coursePools).values({ courseId, poolId, mode: "edit" });
    for (const who of [owner, contributor, reader, staff, await server.signInWithSuperPowers()]) {
      const res = await conceptMapOf(who);
      expect(res.statusCode, res.body).toBe(200);
    }
  });

  it("is read by any teacher on a public pool", async () => {
    const published = await call(owner, "PATCH", `/app/api/pools/${otherPoolId}`, { isPublic: true });
    expect(published.statusCode, published.body).toBe(200);
    const res = await conceptMapOf(await server.signIn("teacher"), otherPoolId);
    expect(res.statusCode, res.body).toBe(200);
    expect(PoolConceptMap.parse(res.json()).nodes.map((n) => nameOf(n.concept.id)).sort()).toEqual(["root", "top"]);
  });

  it("is the 404 of a missing pool for anyone else, a 403 for a student, a 401 without a session", async () => {
    const unknown = await conceptMapOf(owner, randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "not_found" });
    // An outsider on a private pool, the admin without Super Powers, and an id that is no id at all.
    for (const [who, id] of [[await server.signIn("teacher"), poolId], [await server.signIn("admin"), poolId], [owner, "not-a-uuid"]] as const) {
      const res = await conceptMapOf(who, id);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(unknown.json());
    }
    expect((await conceptMapOf(await server.signIn("student"))).statusCode).toBe(403);
    expect((await conceptMapOf(null)).statusCode).toBe(401);
  });
});
