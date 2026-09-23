import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CategoryCountNode, PoolCategories } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { auditLog } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";

/**
 * The categories page of a pool: the tree with its question counts
 * (`GET /pools/:id/categories`), and the one call that moves and reorders
 * folders (`PUT /pools/:id/categories/order`), held to a layout of THIS pool.
 */

let server: TestServer;
let owner: Awaited<ReturnType<TestServer["signIn"]>>;
let stranger: Awaited<ReturnType<TestServer["signIn"]>>;
let poolId: string;
let otherPoolId: string;
let restoreShort: () => void;

async function newPool(name: string): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: owner.headers,
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function newCategory(pool: string, name: string, parentId: string | null = null) {
  const res = await server.app.inject({
    method: "POST",
    url: `/app/api/pools/${pool}/categories`,
    headers: owner.headers,
    payload: { name, parentId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function newQuestion(name: string, categoryId: string | null) {
  const res = await server.app.inject({
    method: "POST",
    url: `/app/api/pools/${poolId}/questions`,
    headers: owner.headers,
    payload: { type: "short", internalName: name, categoryId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().meta.id as string;
}

const read = (headers: Record<string, string>, pool = poolId) =>
  server.app.inject({ method: "GET", url: `/app/api/pools/${pool}/categories`, headers });

const order = (items: { id: string; parentId: string | null; position: number }[]) =>
  server.app.inject({
    method: "PUT",
    url: `/app/api/pools/${poolId}/categories/order`,
    headers: owner.headers,
    payload: { items },
  });

/** name → [count, children names], the shape a reader of the page sees. */
function shape(nodes: CategoryCountNode[]): unknown[] {
  return nodes.map((n) =>
    n.children.length ? [n.name, n.questionCount, shape(n.children)] : [n.name, n.questionCount],
  );
}

let chapter: string;
let section: string;
let other: string;

beforeAll(async () => {
  restoreShort = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  poolId = await newPool("Categories pool");
  otherPoolId = await newPool("Another pool");
  chapter = await newCategory(poolId, "Chapter 1");
  section = await newCategory(poolId, "Section 1.1", chapter);
  other = await newCategory(poolId, "Chapter 2");
  await newQuestion("in chapter", chapter);
  await newQuestion("in section a", section);
  await newQuestion("in section b", section);
  await newQuestion("at the root", null);
  const gone = await newQuestion("deleted", section);
  const del = await server.app.inject({
    method: "DELETE",
    url: `/app/api/questions/${gone}`,
    headers: owner.headers,
  });
  expect(del.statusCode).toBeLessThan(300);
});

afterAll(async () => {
  await server.close();
  restoreShort();
});

describe("GET /pools/:id/categories", () => {
  it("counts the live questions filed directly in each folder, and the root's", async () => {
    const res = await read(owner.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json() as PoolCategories;
    expect(shape(body.categories)).toEqual([
      ["Chapter 1", 1, [["Section 1.1", 2]]],
      ["Chapter 2", 0],
    ]);
    expect(body.rootQuestionCount).toBe(1);
  });

  it("answers 404 to a teacher without a seat, like a missing pool", async () => {
    const res = await read(stranger.headers);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

describe("PUT /pools/:id/categories/order", () => {
  it("moves a folder under another and renumbers both sibling lists, audited", async () => {
    const res = await order([
      { id: other, parentId: chapter, position: 0 },
      { id: section, parentId: chapter, position: 1 },
    ]);
    expect(res.statusCode).toBe(200);
    const after = (await read(owner.headers)).json() as PoolCategories;
    expect(shape(after.categories)).toEqual([
      ["Chapter 1", 1, [["Chapter 2", 0], ["Section 1.1", 2]]],
    ]);
    const entries = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "category.reorder"), eq(auditLog.subjectId, poolId)));
    expect(entries.length).toBeGreaterThan(0);

    // And back to the root, where it came from.
    expect((await order([{ id: other, parentId: null, position: 1 }])).statusCode).toBe(200);
  });

  it("refuses a cycle made of two moves that are each fine alone", async () => {
    const res = await order([
      { id: chapter, parentId: other, position: 0 },
      { id: other, parentId: chapter, position: 0 },
    ]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("cycle");
    const tree = (await read(owner.headers)).json() as PoolCategories;
    expect(tree.categories.map((c) => c.name)).toEqual(["Chapter 1", "Chapter 2"]);
  });

  it("refuses a folder under itself or under its own descendant", async () => {
    expect((await order([{ id: chapter, parentId: chapter, position: 0 }])).statusCode).toBe(409);
    expect((await order([{ id: chapter, parentId: section, position: 0 }])).statusCode).toBe(409);
  });

  it("refuses a parent, or a folder, of another pool", async () => {
    const foreign = await newCategory(otherPoolId, "Foreign");
    const underForeign = await order([{ id: other, parentId: foreign, position: 0 }]);
    expect(underForeign.statusCode).toBe(404);
    const foreignMoved = await order([{ id: foreign, parentId: chapter, position: 0 }]);
    expect(foreignMoved.statusCode).toBe(404);
    const theirs = (await read(owner.headers, otherPoolId)).json() as PoolCategories;
    expect(shape(theirs.categories)).toEqual([["Foreign", 0]]);
  });
});
