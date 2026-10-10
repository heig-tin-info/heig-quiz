/**
 * The question routes past their happy path: what each refusal answers, on
 * a real application. The list's cursor that belongs to another order, a
 * draft that cannot be published, a version that does not exist, a note
 * that is empty, a copy into a pool the caller cannot write — and the
 * version life (restore, deprecate), the statistics reset on the server's
 * clock and the two deletes.
 *
 * Access follows invariant 6: a question or a pool out of reach is the 404
 * of a missing one, never a 403.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { auditLog, questionVersions, questions } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let owner: Actor;
let stranger: Actor;
let poolId: string;
let restoreShort: () => void;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
function call(who: Actor, method: Method, url: string, payload?: Payload) {
  return server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });
}

async function newPool(who: Actor, name: string): Promise<string> {
  const res = await call(who, "POST", "/app/api/pools", { name });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function newQuestion(name: string, pool = poolId): Promise<string> {
  const res = await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type: "short", internalName: name });
  expect(res.statusCode).toBe(201);
  return res.json<{ meta: { id: string } }>().meta.id;
}

/** A question with `n` published versions, whose answers are `v1`, `v2`… */
async function published(name: string, n: number): Promise<string> {
  const id = await newQuestion(name);
  for (let v = 1; v <= n; v++) {
    const config = { statement: "S", answer: `v${v}` };
    expect((await call(owner, "PUT", `/app/api/questions/${id}/draft`, { config })).statusCode).toBe(200);
    expect((await call(owner, "POST", `/app/api/questions/${id}/publish`, {})).statusCode).toBe(201);
  }
  return id;
}

async function draftConfig(id: string): Promise<unknown> {
  const [row] = await server.app.db
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, id), isNull(questionVersions.number)));
  return row!.config;
}

beforeAll(async () => {
  restoreShort = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  poolId = await newPool(owner, "Question routes pool");
});

afterAll(async () => {
  await server.close();
  restoreShort();
});

describe("GET /pools/:id/questions — the cursor", () => {
  it("refuses a malformed cursor with 400 invalid_cursor", async () => {
    const res = await call(owner, "GET", `/app/api/pools/${poolId}/questions?cursor=not-a-cursor`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_cursor", reason: "malformed" });
  });

  it("refuses a cursor produced by another order: the client starts the list again", async () => {
    await newQuestion("cursor a");
    await newQuestion("cursor b");
    const first = await call(owner, "GET", `/app/api/pools/${poolId}/questions?limit=1&sort=updated`);
    expect(first.statusCode).toBe(200);
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor;
    expect(cursor).toBeTruthy();

    const same = await call(owner, "GET", `/app/api/pools/${poolId}/questions?limit=1&sort=updated&cursor=${cursor}`);
    expect(same.statusCode).toBe(200);

    const other = await call(owner, "GET", `/app/api/pools/${poolId}/questions?limit=1&sort=name&cursor=${cursor}`);
    expect(other.statusCode).toBe(400);
    expect(other.json()).toMatchObject({ error: "invalid_cursor", reason: "sort_changed" });
  });
});

describe("POST /questions/:id/publish — the refusals", () => {
  it("refuses an invalid draft with 422 and its issues, and publishes nothing", async () => {
    const id = await newQuestion("invalid draft");
    // Stored anyway (decision D16): a half-written question may be saved.
    const saved = await call(owner, "PUT", `/app/api/questions/${id}/draft`, {
      config: { statement: "S", answer: "" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ valid: false });

    const res = await call(owner, "POST", `/app/api/questions/${id}/publish`, { changeNote: "try" });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: string; details: unknown[] }>();
    expect(body.error).toBe("config_invalid");
    expect(body.details.length).toBeGreaterThan(0);
    expect((await call(owner, "GET", `/app/api/questions/${id}/versions`)).json()).toEqual([]);
  });

  it("answers 409 no_draft for a question that lost its draft row", async () => {
    const id = await newQuestion("no draft");
    await server.app.db
      .delete(questionVersions)
      .where(and(eq(questionVersions.questionId, id), isNull(questionVersions.number)));
    const res = await call(owner, "POST", `/app/api/questions/${id}/publish`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "no_draft" });
  });

  it("publishes with a change note, which the version keeps", async () => {
    const id = await newQuestion("noted");
    await call(owner, "PUT", `/app/api/questions/${id}/draft`, { config: { statement: "S", answer: "a" } });
    const res = await call(owner, "POST", `/app/api/questions/${id}/publish`, { changeNote: "first cut" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ number: 1, changeNote: "first cut" });
  });
});

describe("versions: read, restore, deprecate", () => {
  it("reads one version, and 404s a number that does not exist or is not a number", async () => {
    const id = await published("versions read", 2);
    const v2 = await call(owner, "GET", `/app/api/questions/${id}/versions/2`);
    expect(v2.statusCode).toBe(200);
    expect(v2.json()).toMatchObject({ number: 2 });
    for (const number of ["3", "0", "abc"]) {
      const res = await call(owner, "GET", `/app/api/questions/${id}/versions/${number}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
  });

  it("restores a version into the draft, audited, and 404s a missing one", async () => {
    const id = await published("restore", 2);
    expect(await draftConfig(id)).toMatchObject({ answer: "v2" });

    const res = await call(owner, "POST", `/app/api/questions/${id}/versions/1/restore`);
    expect(res.statusCode).toBe(200);
    expect(await draftConfig(id)).toMatchObject({ answer: "v1" });
    const audits = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "question.restore_version"), eq(auditLog.subjectId, id)));
    expect(audits.map((a) => a.payload)).toEqual([{ number: 1 }]);

    for (const number of ["9", "x"]) {
      expect((await call(owner, "POST", `/app/api/questions/${id}/versions/${number}/restore`)).statusCode).toBe(404);
    }
    // The failed restores changed nothing.
    expect(await draftConfig(id)).toMatchObject({ answer: "v1" });
  });

  it("deprecates a version with a note; refuses an empty note (400) and a missing version (404)", async () => {
    const id = await published("deprecate", 1);
    const empty = await call(owner, "POST", `/app/api/questions/${id}/versions/1/deprecate`, { note: "   " });
    expect(empty.statusCode).toBe(400);
    const none = await call(owner, "POST", `/app/api/questions/${id}/versions/1/deprecate`, {});
    expect(none.statusCode).toBe(400);

    const missing = await call(owner, "POST", `/app/api/questions/${id}/versions/5/deprecate`, { note: "wrong key" });
    expect(missing.statusCode).toBe(404);
    const notANumber = await call(owner, "POST", `/app/api/questions/${id}/versions/v1/deprecate`, { note: "x" });
    expect(notANumber.statusCode).toBe(404);

    const res = await call(owner, "POST", `/app/api/questions/${id}/versions/1/deprecate`, { note: "  wrong key  " });
    expect(res.statusCode).toBe(200);
    const [row] = await server.app.db
      .select()
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, id), eq(questionVersions.number, 1)));
    expect(row!.deprecationNote).toBe("wrong key");
    expect(row!.deprecatedAt).not.toBeNull();
  });

  it("refuses the role before a malformed number, and the number before the body", async () => {
    const reader = await server.signIn("teacher");
    const created = await call(owner, "POST", "/app/api/pools", { name: "Versions order pool", isPublic: true });
    expect(created.statusCode).toBe(201);
    const id = await newQuestion("versions order", created.json<{ id: string }>().id);
    // A reader reads versions: a malformed number is the 404 of a miss.
    const read = await call(reader, "GET", `/app/api/questions/${id}/versions/abc`);
    expect(read.statusCode).toBe(404);
    expect(read.json()).toEqual({ error: "not_found" });
    // A write takes `contributor`: its 403 comes before the malformed number…
    for (const [url, payload] of [
      [`/app/api/questions/${id}/versions/abc/restore`, undefined],
      [`/app/api/questions/${id}/versions/abc/deprecate`, { note: 1 }],
    ] as const) {
      const res = await call(reader, "POST", url, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "forbidden", role: "reader" });
    }
    // …and the number before the body.
    const both = await call(owner, "POST", `/app/api/questions/${id}/versions/abc/deprecate`, { note: 1 });
    expect(both.statusCode).toBe(404);
    expect(both.json()).toEqual({ error: "not_found" });
  });

  it("answers a stranger 404 on every version route, and changes nothing", async () => {
    const id = await published("versions guarded", 1);
    const missing = crypto.randomUUID();
    const routes = (q: string) =>
      [
        ["GET", `/app/api/questions/${q}/versions`, undefined],
        ["GET", `/app/api/questions/${q}/versions/1`, undefined],
        ["POST", `/app/api/questions/${q}/versions/1/restore`, undefined],
        ["POST", `/app/api/questions/${q}/versions/1/deprecate`, { note: "hijack" }],
        ["POST", `/app/api/questions/${q}/stats/reset`, undefined],
      ] as const;
    const guarded = routes(id);
    const absent = routes(missing);
    for (let i = 0; i < guarded.length; i++) {
      const [method, url, payload] = guarded[i]!;
      const res = await call(stranger, method, url, payload);
      // Indistinguishable from a question that does not exist (invariant 6).
      const [, missingUrl, missingPayload] = absent[i]!;
      const none = await call(stranger, method, missingUrl, missingPayload);
      expect(res.statusCode).toBe(404);
      expect(none.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
      expect(res.json()).toEqual(none.json());
    }
    const [row] = await server.app.db
      .select()
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, id), eq(questionVersions.number, 1)));
    expect(row!.deprecatedAt).toBeNull();
  });
});

describe("POST /questions/:id/stats/reset (F-STAT-05)", () => {
  it("starts the statistics again at the server's clock, and says the previous start", async () => {
    const id = await newQuestion("stats");
    const first = server.clock.now().toISOString();
    const res = await call(owner, "POST", `/app/api/questions/${id}/stats/reset`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ since: first });
    const [row] = await server.app.db.select().from(questions).where(eq(questions.id, id));
    expect(row!.statsSince!.toISOString()).toBe(first);

    server.clock.advance(60_000);
    const second = await call(owner, "POST", `/app/api/questions/${id}/stats/reset`);
    expect(second.json()).toEqual({ since: server.clock.now().toISOString() });
    const audits = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "question.stats_reset"), eq(auditLog.subjectId, id)));
    expect(audits.map((a) => (a.payload as { previousSince: string | null }).previousSince)).toEqual([null, first]);
  });
});

describe("DELETE /questions/:id", () => {
  it("hides a question by default: gone from the list, back with includeDeleted", async () => {
    const id = await newQuestion("soft delete");
    const res = await call(owner, "DELETE", `/app/api/questions/${id}`);
    expect(res.statusCode).toBe(204);
    const [row] = await server.app.db.select().from(questions).where(eq(questions.id, id));
    expect(row!.deletedAt).not.toBeNull();

    const listed = (url: string) =>
      call(owner, "GET", url).then((r) => r.json<{ items: { id: string }[] }>().items.map((q) => q.id));
    expect(await listed(`/app/api/pools/${poolId}/questions?limit=200`)).not.toContain(id);
    expect(await listed(`/app/api/pools/${poolId}/questions?limit=200&includeDeleted=1`)).toContain(id);
  });

  it("purges the rows with ?hard=1, versions included", async () => {
    const id = await published("hard delete", 1);
    const res = await call(owner, "DELETE", `/app/api/questions/${id}?hard=1`);
    expect(res.statusCode).toBe(204);
    expect(await server.app.db.select().from(questions).where(eq(questions.id, id))).toHaveLength(0);
    expect(
      await server.app.db.select().from(questionVersions).where(eq(questionVersions.questionId, id)),
    ).toHaveLength(0);
    const audits = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "question.delete"), eq(auditLog.subjectId, id)));
    expect(audits.map((a) => a.payload)).toEqual([{ hard: true, internalName: "hard delete" }]);
    // Gone: the next call is a missing question.
    expect((await call(owner, "GET", `/app/api/questions/${id}`)).statusCode).toBe(404);
  });

  it("answers a stranger 404 and deletes nothing", async () => {
    const id = await newQuestion("guarded delete");
    const res = await call(stranger, "DELETE", `/app/api/questions/${id}?hard=1`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(await server.app.db.select().from(questions).where(eq(questions.id, id))).toHaveLength(1);
  });
});

describe("POST /questions/:id/copy", () => {
  it("copies into another pool of the caller, with the current draft", async () => {
    const id = await published("copy me", 1);
    const target = await newPool(owner, "Copy target");
    const res = await call(owner, "POST", `/app/api/questions/${id}/copy`, { targetPoolId: target });
    expect(res.statusCode).toBe(201);
    const copy = res.json<{ meta: { id: string; poolId: string } }>().meta;
    expect(copy.id).not.toBe(id);
    expect(copy.poolId).toBe(target);
    expect(await draftConfig(copy.id)).toMatchObject({ answer: "v1" });
  });

  it("answers 404 for a target pool out of the caller's reach, and writes nothing there", async () => {
    const id = await newQuestion("copy out");
    const foreign = await newPool(stranger, "Stranger's pool");
    for (const targetPoolId of [foreign, crypto.randomUUID()]) {
      const res = await call(owner, "POST", `/app/api/questions/${id}/copy`, { targetPoolId });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
    const inForeign = await server.app.db.select().from(questions).where(eq(questions.poolId, foreign));
    expect(inForeign).toHaveLength(0);
  });

  it("answers 404 to a stranger copying a question they cannot read, even into their own pool", async () => {
    const id = await newQuestion("copy source guarded");
    const theirs = await newPool(stranger, "Stranger's other pool");
    const res = await call(stranger, "POST", `/app/api/questions/${id}/copy`, { targetPoolId: theirs });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("refuses a body without a valid target (400)", async () => {
    const id = await newQuestion("copy bad body");
    expect((await call(owner, "POST", `/app/api/questions/${id}/copy`, { targetPoolId: "nope" })).statusCode).toBe(400);
  });
});
