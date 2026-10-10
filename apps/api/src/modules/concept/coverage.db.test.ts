/**
 * Coverage (ADR-081 §4, sixth addendum 7d): a concept selected anywhere covers
 * its narrower ones. `coverage` is the one place that widens; the pool's
 * concept filter, the poll launcher's search and a course's filter follow.
 * Only `broader` edges widen it: a `related` concept is not covered.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { QuestionPage } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { conceptRelations, courseConcepts, coursePools, courseStaff, courses } from "../../db/schema.js";
import { seedConcept } from "../../test/concepts.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { conceptsCoveredByCourse, coverage } from "./service.js";

let server: TestServer;
let restore: () => void;
let owner: Awaited<ReturnType<TestServer["signIn"]>>;
const db = () => server.app.db;

const names = ["root", "mid", "leaf", "other", "side", "lonely"] as const;
type Name = (typeof names)[number];
const c = {} as Record<Name, string>;
const q = {} as Record<Name, string>;
let poolId: string;
let courseId: string;

const broader = (concept: string, target: string) =>
  db().insert(conceptRelations).values({ conceptId: concept, targetId: target, kind: "broader" });

const list = (query: string) =>
  server.app.inject({ method: "GET", url: `/app/api/pools/${poolId}/questions?${query}`, headers: owner.headers });
const idsOf = (res: { json: () => unknown }) => QuestionPage.parse(res.json()).items.map((x) => x.id).sort();
const questions = (...keys: Name[]) => keys.map((k) => q[k]).sort();

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  for (const n of names) c[n] = await seedConcept(db(), owner.id, [n], [n]);
  // root <- mid <- leaf (a deep chain), root <- other; side has two parents (leaf and other).
  await broader(c.mid, c.root);
  await broader(c.leaf, c.mid);
  await broader(c.other, c.root);
  await broader(c.side, c.leaf);
  await broader(c.side, c.other);
  // lonely is only related to root: never covered by it.
  const [a, b] = c.root < c.lonely ? [c.root, c.lonely] : [c.lonely, c.root];
  await db().insert(conceptRelations).values({ conceptId: a, targetId: b, kind: "related" });

  poolId = (
    await server.app.inject({ method: "POST", url: "/app/api/pools", headers: owner.headers, payload: { name: "Cov" } })
  ).json().id;
  for (const n of names) {
    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${poolId}/questions`,
      headers: owner.headers,
      payload: { type: "short", internalName: n, concepts: [c[n]] },
    });
    expect(res.statusCode, res.body).toBe(201);
    q[n] = res.json().meta.id;
  }
  courseId = randomUUID();
  await db().insert(courses).values({ id: courseId, name: "Cov course", code: "COV" });
  await db().insert(courseStaff).values({ courseId, userId: owner.id, role: "owner" });
  await db().insert(coursePools).values({ courseId, poolId, mode: "edit" });
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("coverage", () => {
  it("covers a concept itself and every narrower one, near or far, through several parents", async () => {
    const got = await coverage(db(), [c.root, c.leaf, c.lonely]);
    expect(got.get(c.root)![0]).toBe(c.root);
    expect([...got.get(c.root)!].sort()).toEqual([c.root, c.mid, c.leaf, c.other, c.side].sort());
    expect([...got.get(c.leaf)!].sort()).toEqual([c.leaf, c.side].sort());
    // A related concept is not covered, and covers nothing else.
    expect(got.get(c.lonely)).toEqual([c.lonely]);
    expect(await coverage(db(), [])).toEqual(new Map());
  });
});

describe("the concept filters follow coverage", () => {
  it("the pool filter on a broader concept returns the questions of the narrower ones", async () => {
    expect(idsOf(await list(`concept=${c.root}`))).toEqual(questions("root", "mid", "leaf", "other", "side"));
    expect(idsOf(await list(`concept=${c.mid}`))).toEqual(questions("mid", "leaf", "side"));
    expect(idsOf(await list(`concept=${c.leaf},${c.lonely}`))).toEqual(questions("leaf", "side", "lonely"));
    // A leaf matches its own questions only.
    expect(idsOf(await list(`concept=${c.side}`))).toEqual(questions("side"));
  });

  it("the poll launcher's search across pools widens the same way", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/polls/pool-questions?concept=${c.mid}`,
      headers: owner.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().items as { id: string }[]).map((x) => x.id).sort();
    expect(ids).toEqual(questions("mid", "leaf", "side"));
  });

  it("a course listing a broader concept covers the narrower ones, in its filter too", async () => {
    await db().insert(courseConcepts).values({ courseId, conceptId: c.mid, addedBy: owner.id });
    expect([...(await conceptsCoveredByCourse(db(), [courseId]))].sort()).toEqual([c.mid, c.leaf, c.side].sort());
    expect(idsOf(await list(`course=${courseId}`))).toEqual(questions("mid", "leaf", "side"));
  });
});
