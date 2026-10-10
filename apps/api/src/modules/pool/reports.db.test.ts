/**
 * Reports on a question (issue #680, lot 3), on a real application: who may
 * report, who reads what, the writers' notification folded per question, the
 * resolution and its reply, the move that carries the reports, the delete
 * that closes them and the audit trail.
 *
 * Access follows invariant 6: a question out of reach is the 404 of a missing
 * one; a student never reaches the routes (invariant 4).
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { auditLog, notifications, questionReports } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let owner: Actor;
let contributor: Actor;
let reader: Actor;
let stranger: Actor;
let poolId: string;
let restoreShort: () => void;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
function call(who: Actor, method: Method, url: string, payload?: Payload) {
  return server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });
}

async function newPool(name: string): Promise<string> {
  const res = await call(owner, "POST", "/app/api/pools", { name });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function invite(pool: string, who: Actor, role: "reader" | "contributor"): Promise<void> {
  const email = (await server.app.db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, who.id) }))!.email;
  const res = await call(owner, "POST", `/app/api/pools/${pool}/members`, { email, role });
  expect(res.statusCode).toBe(201);
}

async function newQuestion(name: string, pool = poolId): Promise<string> {
  const res = await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type: "short", internalName: name });
  expect(res.statusCode).toBe(201);
  return res.json<{ meta: { id: string } }>().meta.id;
}

const report = (who: Actor, question: string, message = "The key is wrong") =>
  call(who, "POST", `/app/api/questions/${question}/reports`, { message });

const reportsOf = async (who: Actor, question: string) =>
  (await call(who, "GET", `/app/api/questions/${question}/reports`)).json<
    { id: string; mine: boolean; message: string; resolvedAt: string | null; resolution: string }[]
  >();

const bellsOf = (userId: string, kind: string) =>
  server.app.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .then((rows) => rows.filter((r) => (r.payload as { kind: string }).kind === kind));

beforeAll(async () => {
  restoreShort = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  contributor = await server.signIn("teacher");
  reader = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  poolId = await newPool("Reports pool");
  await invite(poolId, contributor, "contributor");
  await invite(poolId, reader, "reader");
});

afterAll(async () => {
  await server.close();
  restoreShort();
});

describe("who may report", () => {
  it("lets a reader report, and a writer too", async () => {
    const q = await newQuestion("who-reports");
    expect((await report(reader, q)).statusCode).toBe(201);
    expect((await report(contributor, q)).statusCode).toBe(201);
  });

  it("answers a teacher outside the pool with the 404 of a missing question", async () => {
    const q = await newQuestion("out-of-reach");
    expect((await report(stranger, q)).statusCode).toBe(404);
    expect((await call(stranger, "GET", `/app/api/questions/${q}/reports`)).statusCode).toBe(404);
  });

  it("reaches a public reader through poolAccess", async () => {
    const pool = await newPool("Public reports pool");
    const q = await newQuestion("public-q", pool);
    expect((await call(owner, "PATCH", `/app/api/pools/${pool}`, { isPublic: true })).statusCode).toBe(200);
    expect((await report(stranger, q)).statusCode).toBe(201);
  });

  it("never serves a student", async () => {
    const student = await server.signIn("student");
    const q = await newQuestion("student-q");
    expect((await report(student, q)).statusCode).toBe(403);
    expect((await call(student, "GET", `/app/api/questions/${q}/reports`)).statusCode).toBe(403);
  });

  it("refuses an empty message and one over 1000 characters", async () => {
    const q = await newQuestion("bad-message");
    expect((await report(reader, q, "   ")).statusCode).toBe(400);
    expect((await report(reader, q, "x".repeat(1001))).statusCode).toBe(400);
    expect((await report(reader, q, "x".repeat(1000))).statusCode).toBe(201);
  });
});

describe("who reads which report", () => {
  it("shows the writers every report and a reporter only their own", async () => {
    const q = await newQuestion("visibility");
    await report(reader, q, "from the reader");
    await report(contributor, q, "from the contributor");

    const asOwner = await reportsOf(owner, q);
    expect(asOwner.map((r) => r.message).sort()).toEqual(["from the contributor", "from the reader"]);

    const asReader = await reportsOf(reader, q);
    expect(asReader.map((r) => r.message)).toEqual(["from the reader"]);
    expect(asReader[0]!.mine).toBe(true);
  });

  it("counts the open reports the caller may read on the question row", async () => {
    const q = await newQuestion("row-count");
    await report(reader, q);
    await report(contributor, q);
    const countAs = async (who: Actor) =>
      (await call(who, "GET", `/app/api/pools/${poolId}/questions`))
        .json<{ items: { id: string; openReports: number }[] }>()
        .items.find((i) => i.id === q)!.openReports;
    expect(await countAs(owner)).toBe(2);
    expect(await countAs(reader)).toBe(1);
    expect(await countAs(contributor)).toBe(2);
  });
});

describe("the notifications", () => {
  it("tells the writers, folded per question, never the reporter nor a reader", async () => {
    const q = await newQuestion("folded");
    await report(reader, q);
    await report(reader, q, "again");
    const forOwner = (await bellsOf(owner.id, "question_reported")).filter((b) => b.questionId === q);
    expect(forOwner).toHaveLength(1);
    expect(forOwner[0]!.payload).toMatchObject({ kind: "question_reported", questionId: q, count: 2 });
    expect((await bellsOf(contributor.id, "question_reported")).some((b) => b.questionId === q)).toBe(true);
    expect((await bellsOf(reader.id, "question_reported")).some((b) => b.questionId === q)).toBe(false);
    // A report by a writer does not tell that writer.
    const q2 = await newQuestion("folded-self");
    await report(contributor, q2);
    expect((await bellsOf(contributor.id, "question_reported")).some((b) => b.questionId === q2)).toBe(false);
    expect((await bellsOf(owner.id, "question_reported")).some((b) => b.questionId === q2)).toBe(true);
  });

  it("tells the reporter when a writer resolves, with or without a reply", async () => {
    const q = await newQuestion("resolved-bell");
    const id = (await report(reader, q)).json<{ id: string }>().id;
    const res = await call(contributor, "POST", `/app/api/questions/${q}/reports/${id}/resolve`, { reply: "Fixed" });
    expect(res.statusCode).toBe(200);
    expect((await bellsOf(reader.id, "question_report_resolved")).some((b) => b.questionId === q)).toBe(true);
  });
});

describe("resolving", () => {
  it("is a writer's act: a reader gets 403, a stranger 404", async () => {
    const q = await newQuestion("who-resolves");
    const id = (await report(reader, q)).json<{ id: string }>().id;
    const url = `/app/api/questions/${q}/reports/${id}/resolve`;
    expect((await call(reader, "POST", url, {})).statusCode).toBe(403);
    expect((await call(stranger, "POST", url, {})).statusCode).toBe(404);
  });

  it("keeps the reply for the reporter, closes the report once, and audits both acts", async () => {
    const q = await newQuestion("resolution");
    const id = (await report(reader, q)).json<{ id: string }>().id;
    const url = `/app/api/questions/${q}/reports/${id}/resolve`;
    expect((await call(owner, "POST", url, { reply: "Thanks, fixed" })).statusCode).toBe(200);
    const mine = (await reportsOf(reader, q))[0]!;
    expect(mine.resolvedAt).not.toBeNull();
    expect(mine.resolution).toBe("Thanks, fixed");
    expect((await call(owner, "POST", url, {})).statusCode).toBe(409);
    expect((await call(owner, "POST", `/app/api/questions/${q}/reports/${crypto.randomUUID()}/resolve`, {})).statusCode).toBe(404);

    const actions = (await server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, q))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["question.report", "question.report_resolve"]));
    // The row's indicator goes with the resolution.
    const row = (await call(owner, "GET", `/app/api/pools/${poolId}/questions`))
      .json<{ items: { id: string; openReports: number }[] }>()
      .items.find((i) => i.id === q)!;
    expect(row.openReports).toBe(0);
  });

  it("is open to an admin under Super Powers, who owns no seat in the pool", async () => {
    const admin = await server.signInWithSuperPowers();
    const q = await newQuestion("orphan");
    const id = (await report(reader, q)).json<{ id: string }>().id;
    expect(
      (await call(admin, "POST", `/app/api/questions/${q}/reports/${id}/resolve`, { reply: "" })).statusCode,
    ).toBe(200);
  });
});

describe("moves and deletion", () => {
  it("carries the reports with a moved question", async () => {
    const q = await newQuestion("moving");
    await report(reader, q);
    const target = await newPool("Move target");
    const moved = await call(owner, "POST", "/app/api/questions/move", { questionIds: [q], targetPoolId: target });
    expect(moved.statusCode).toBe(200);
    const rows = await server.app.db.select().from(questionReports).where(eq(questionReports.questionId, q));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedAt).toBeNull();
    expect((await reportsOf(owner, q))).toHaveLength(1);
  });

  it("closes the open reports of a soft-deleted question, without a resolver", async () => {
    const q = await newQuestion("deleted");
    await report(reader, q);
    expect((await call(owner, "DELETE", `/app/api/questions/${q}`)).statusCode).toBe(204);
    const [row] = await server.app.db.select().from(questionReports).where(eq(questionReports.questionId, q));
    expect(row!.resolvedAt).not.toBeNull();
    expect(row!.resolvedBy).toBeNull();
    // And a deleted question takes no new report.
    expect((await report(reader, q)).statusCode).toBe(404);
  });
});
