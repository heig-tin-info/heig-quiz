/**
 * Favourite stars (F-POOL-10, ADR-039): `PUT`/`DELETE /questions/star`,
 * `DELETE /pools/:id/stars`, and the `starred` flag and filter of the list.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";

type Actor = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restoreShort: () => void;
let owner: Actor;
let reader: Actor;
let stranger: Actor;
let poolId: string;
let otherPoolId: string;

async function newPool(who: Actor, name: string): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: who.headers,
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function question(pool: string, name: string): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: `/app/api/pools/${pool}/questions`,
    headers: owner.headers,
    payload: { type: "short", internalName: name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().meta.id as string;
}

const star = (who: Actor, questionIds: string[], method: "PUT" | "DELETE" = "PUT") =>
  server.app.inject({
    method,
    url: "/app/api/questions/star",
    headers: who.headers,
    payload: { questionIds },
  });

/** The ids the caller sees starred in a pool, through the list's own filter. */
async function starredIn(who: Actor, pool: string): Promise<string[]> {
  const res = await server.app.inject({
    method: "GET",
    url: `/app/api/pools/${pool}/questions?starred=1&limit=200`,
    headers: who.headers,
  });
  expect(res.statusCode).toBe(200);
  const items = res.json().items as { id: string; starred: boolean }[];
  expect(items.every((q) => q.starred)).toBe(true);
  return items.map((q) => q.id).sort();
}

/** The `starred` flag of every row of a pool, for the caller. */
async function flags(who: Actor, pool: string): Promise<Record<string, boolean>> {
  const res = await server.app.inject({
    method: "GET",
    url: `/app/api/pools/${pool}/questions?limit=200`,
    headers: who.headers,
  });
  expect(res.statusCode).toBe(200);
  return Object.fromEntries(
    (res.json().items as { id: string; starred: boolean }[]).map((q) => [q.id, q.starred]),
  );
}

beforeAll(async () => {
  restoreShort = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  reader = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  poolId = await newPool(owner, "Stars");
  otherPoolId = await newPool(owner, "Stars, elsewhere");
  const invited = await server.app.inject({
    method: "POST",
    url: `/app/api/pools/${poolId}/members`,
    headers: owner.headers,
    payload: { userId: reader.id, role: "reader" },
  });
  expect(invited.statusCode).toBeLessThan(300);
});

afterAll(async () => {
  await server.close();
  restoreShort();
});

describe("question stars", () => {
  it("stars and unstars idempotently, and the row says so", async () => {
    const a = await question(poolId, "star-a");
    const b = await question(poolId, "star-b");
    expect((await star(owner, [a, a, b])).statusCode).toBe(204);
    expect((await star(owner, [a])).statusCode).toBe(204);
    expect(await starredIn(owner, poolId)).toEqual([a, b].sort());
    expect(await flags(owner, poolId)).toMatchObject({ [a]: true, [b]: true });

    expect((await star(owner, [b], "DELETE")).statusCode).toBe(204);
    expect((await star(owner, [b], "DELETE")).statusCode).toBe(204);
    expect(await starredIn(owner, poolId)).toEqual([a]);
    expect((await flags(owner, poolId))[b]).toBe(false);
    await star(owner, [a], "DELETE");
  });

  it("lets a reader star, and neither sees the other's stars", async () => {
    const q = await question(poolId, "star-shared");
    const other = await question(poolId, "star-shared-2");
    expect((await star(reader, [q])).statusCode).toBe(204);
    expect((await star(owner, [other])).statusCode).toBe(204);
    expect(await starredIn(reader, poolId)).toEqual([q]);
    expect(await starredIn(owner, poolId)).toEqual([other]);
    expect((await flags(owner, poolId))[q]).toBe(false);
    expect((await flags(reader, poolId))[other]).toBe(false);
  });

  it("clears only the caller's stars, only in that pool, and counts them", async () => {
    const here = await question(poolId, "star-clear-here");
    const there = await question(otherPoolId, "star-clear-there");
    await star(owner, [here, there]);
    const before = await starredIn(reader, poolId);

    const res = await server.app.inject({
      method: "DELETE",
      url: `/app/api/pools/${poolId}/stars`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    // `here` and `star-shared-2` from the test above.
    expect(res.json()).toEqual({ cleared: 2 });
    expect(await starredIn(owner, poolId)).toEqual([]);
    expect(await starredIn(owner, otherPoolId)).toEqual([there]);
    expect(await starredIn(reader, poolId)).toEqual(before);
  });

  it("keeps the star of a moved question, and a copy starts without one", async () => {
    const q = await question(poolId, "star-moved");
    await star(owner, [q]);
    const moved = await server.app.inject({
      method: "POST",
      url: "/app/api/questions/move",
      headers: owner.headers,
      payload: { questionIds: [q], targetPoolId: otherPoolId },
    });
    expect(moved.statusCode).toBe(200);
    expect(await starredIn(owner, otherPoolId)).toContain(q);
    expect(await starredIn(owner, poolId)).not.toContain(q);

    const copied = await server.app.inject({
      method: "POST",
      url: `/app/api/questions/${q}/copy`,
      headers: owner.headers,
      payload: { targetPoolId: poolId },
    });
    expect(copied.statusCode).toBe(201);
    const copyId = copied.json().meta.id as string;
    expect((await flags(owner, poolId))[copyId]).toBe(false);
  });

  it("hides the star of a soft-deleted question, and brings it back with it", async () => {
    const q = await question(poolId, "star-deleted");
    await star(owner, [q]);
    const gone = await server.app.inject({
      method: "DELETE",
      url: `/app/api/questions/${q}`,
      headers: owner.headers,
    });
    expect(gone.statusCode).toBeLessThan(300);
    expect(await starredIn(owner, poolId)).not.toContain(q);
    const all = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${poolId}/questions?includeDeleted=1&limit=200`,
      headers: owner.headers,
    });
    const row = (all.json().items as { id: string; starred: boolean }[]).find((r) => r.id === q);
    expect(row?.starred).toBe(false);
    const cleared = await server.app.inject({
      method: "DELETE",
      url: `/app/api/pools/${poolId}/stars`,
      headers: owner.headers,
    });
    expect(cleared.json()).toEqual({ cleared: 0 });
  });

  it("answers 404 to an outsider, for the whole batch", async () => {
    const q = await question(poolId, "star-guarded");
    expect((await star(stranger, [q])).statusCode).toBe(404);
    expect((await star(stranger, [q], "DELETE")).statusCode).toBe(404);
    // One reachable id beside an unreachable one: nothing is starred at all.
    const theirPool = await newPool(stranger, "Stranger's");
    const own = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${theirPool}/questions`,
      headers: stranger.headers,
      payload: { type: "short", internalName: "theirs" },
    });
    const theirs = own.json().meta.id as string;
    const mixed = await star(stranger, [theirs, q]);
    expect(mixed.statusCode).toBe(404);
    expect(mixed.json()).toEqual({ error: "not_found" });
    expect(await starredIn(stranger, theirPool)).toEqual([]);
    const clear = await server.app.inject({
      method: "DELETE",
      url: `/app/api/pools/${poolId}/stars`,
      headers: stranger.headers,
    });
    expect(clear.statusCode).toBe(404);
    expect(clear.json()).toEqual({ error: "not_found" });
  });

  it("refuses a malformed batch", async () => {
    expect((await star(owner, [])).statusCode).toBe(400);
    expect((await star(owner, ["not-a-uuid"])).statusCode).toBe(400);
    const tooMany = Array.from({ length: 201 }, () => crypto.randomUUID());
    expect((await star(owner, tooMany)).statusCode).toBe(400);
  });
});
