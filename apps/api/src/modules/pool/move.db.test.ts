/**
 * `POST /questions/move` — moving a question, or a selection, to another pool
 * (ADR-017). A file of its own rather than a block of `routes.db.test.ts`:
 * the interesting half of a move is what it does to the OTHER modules (the
 * evaluations that play the question, the `course_pools` link), and that
 * fixture is `seedLive`, which the route tests do not otherwise need.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { auditLog, coursePools, poolMembers, questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive } from "../../test/live.js";

type Actor = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restoreShort: () => void;
let mover: Actor;
let stranger: Actor;
let source: string;
let destination: string;

async function newPool(who: Actor, name: string): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: who.headers,
    payload: { name },
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
}

/** A question of `source`, with the tags it carries into the move. */
async function question(name: string, tags: string[] = []): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: `/app/api/pools/${source}/questions`,
    headers: mover.headers,
    payload: { type: "short", internalName: name },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().meta.id as string;
  if (tags.length) {
    const patched = await server.app.inject({
      method: "PATCH",
      url: `/app/api/questions/${id}`,
      headers: mover.headers,
      payload: { tags },
    });
    expect(patched.statusCode).toBe(200);
  }
  return id;
}

const move = (who: Actor, payload: Record<string, unknown>) =>
  server.app.inject({
    method: "POST",
    url: "/app/api/questions/move",
    headers: who.headers,
    payload,
  });

beforeAll(async () => {
  restoreShort = registerForTests(fakeShort);
  server = await testServer();
  mover = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  source = await newPool(mover, "Move source");
  destination = await newPool(mover, "Move destination");
});

afterAll(async () => {
  await server.close();
  restoreShort();
});

describe("POST /questions/move", () => {
  it("keeps the id and the tags, and teaches the tags to the target pool", async () => {
    const id = await question("mv-keeps-id", ["pointeurs", "revision"]);
    const res = await move(mover, { questionIds: [id], targetPoolId: destination });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      moved: 1,
      questionIds: [id],
      targetPoolId: destination,
      categoryId: null,
      linkedCourseIds: [],
    });

    const [row] = await server.app.db.select().from(questions).where(eq(questions.id, id));
    expect(row!.poolId).toBe(destination);
    expect(row!.categoryId).toBeNull();

    // The question is served by the target pool now, with its tags.
    const listed = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${destination}/questions`,
      headers: mover.headers,
    });
    expect(listed.json().items.map((q: { id: string }) => q.id)).toContain(id);
    expect(listed.json().items.find((q: { id: string }) => q.id === id).tags).toEqual([
      "pointeurs",
      "revision",
    ]);

    // The target pool's vocabulary learned them (`pool_tags`).
    const detail = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${destination}`,
      headers: mover.headers,
    });
    expect(detail.json().tags).toEqual(expect.arrayContaining(["pointeurs", "revision"]));
  });

  it("audits the move with both of its ends", async () => {
    const id = await question("mv-audited");
    const res = await move(mover, { questionIds: [id], targetPoolId: destination });
    expect(res.statusCode).toBe(200);
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "question.move"), eq(auditLog.subjectId, id)));
    expect(entry!.payload).toMatchObject({ fromPoolId: source, toPoolId: destination });
  });

  it("files the questions under a category OF THE TARGET, and refuses another pool's", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${destination}/categories`,
      headers: mover.headers,
      payload: { name: "Arrivees", parentId: null },
    });
    expect(created.statusCode).toBe(201);
    const categoryId = created.json().id as string;

    const foreign = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${source}/categories`,
      headers: mover.headers,
      payload: { name: "Restee derriere", parentId: null },
    });
    const foreignId = foreign.json().id as string;

    const id = await question("mv-category");
    const refused = await move(mover, {
      questionIds: [id],
      targetPoolId: destination,
      categoryId: foreignId,
    });
    expect(refused.statusCode).toBe(404);
    const [before] = await server.app.db.select().from(questions).where(eq(questions.id, id));
    expect(before!.poolId).toBe(source);

    const ok = await move(mover, { questionIds: [id], targetPoolId: destination, categoryId });
    expect(ok.statusCode).toBe(200);
    const [after] = await server.app.db.select().from(questions).where(eq(questions.id, id));
    expect(after!.categoryId).toBe(categoryId);
  });

  it("moves a whole selection in one call", async () => {
    const ids = [
      await question("mv-bulk-1"),
      await question("mv-bulk-2"),
      await question("mv-bulk-3"),
    ];
    const res = await move(mover, { questionIds: ids, targetPoolId: destination });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toBe(3);
    const rows = await server.app.db
      .select()
      .from(questions)
      .where(eq(questions.poolId, destination));
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(ids));
  });

  it("refuses the whole batch when an internal name is already taken there", async () => {
    const id = await question("mv-clash");
    const twin = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${destination}/questions`,
      headers: mover.headers,
      payload: { type: "short", internalName: "mv-clash" },
    });
    expect(twin.statusCode).toBe(201);
    const other = await question("mv-clash-innocent");

    const res = await move(mover, { questionIds: [id, other], targetPoolId: destination });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "name_taken", names: ["mv-clash"] });
    // Atomic: the innocent one of the batch did not move either.
    const [row] = await server.app.db.select().from(questions).where(eq(questions.id, other));
    expect(row!.poolId).toBe(source);
  });

  it("answers 404 for a target pool the caller cannot reach, and for an unknown question", async () => {
    const id = await question("mv-unreachable");
    const foreign = await newPool(stranger, "Not yours");
    const res = await move(mover, { questionIds: [id], targetPoolId: foreign });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });

    const ghost = await move(mover, {
      questionIds: [crypto.randomUUID()],
      targetPoolId: destination,
    });
    expect(ghost.statusCode).toBe(404);
  });

  it("needs a contributor's seat on the source AND on the target", async () => {
    const reader = await server.signIn("teacher");
    const shared = await newPool(mover, "Readable source");
    const readerTarget = await newPool(mover, "Readable target");
    await server.app.db.insert(poolMembers).values([
      { poolId: shared, userId: reader.id, role: "contributor" },
      { poolId: readerTarget, userId: reader.id, role: "reader" },
    ]);
    const created = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${shared}/questions`,
      headers: mover.headers,
      payload: { type: "short", internalName: "mv-rights" },
    });
    const id = created.json().meta.id as string;

    // A reader on the TARGET may not create there, so they may not move there.
    const toTarget = await move(reader, { questionIds: [id], targetPoolId: readerTarget });
    expect(toTarget.statusCode).toBe(403);

    // And a reader on the SOURCE may not take the question out of it.
    await server.app.db
      .update(poolMembers)
      .set({ role: "reader" })
      .where(and(eq(poolMembers.poolId, shared), eq(poolMembers.userId, reader.id)));
    await server.app.db
      .update(poolMembers)
      .set({ role: "contributor" })
      .where(and(eq(poolMembers.poolId, readerTarget), eq(poolMembers.userId, reader.id)));
    const fromSource = await move(reader, { questionIds: [id], targetPoolId: readerTarget });
    expect(fromSource.statusCode).toBe(403);
  });

  it("refuses when a classroom plays the question and the pool is not linked, then links on retry", async () => {
    const seeded = await seedLive(server.app.db, {
      teacherId: mover.id,
      questions: 1,
      students: 0,
    });
    const target = await newPool(mover, "Pool the course does not draw from");

    const refused = await move(mover, {
      questionIds: [seeded.questionIds[0]!],
      targetPoolId: target,
    });
    expect(refused.statusCode).toBe(409);
    const conflict = refused.json();
    expect(conflict.error).toBe("pool_not_linked");
    expect(conflict.courses).toHaveLength(1);
    expect(conflict.courses[0]).toMatchObject({ courseId: seeded.courseId, mayLink: true });
    expect(conflict.courses[0].classrooms[0]).toMatchObject({ id: seeded.classroomId });
    const [before] = await server.app.db
      .select()
      .from(questions)
      .where(eq(questions.id, seeded.questionIds[0]!));
    expect(before!.poolId).toBe(seeded.poolId);

    const retried = await move(mover, {
      questionIds: [seeded.questionIds[0]!],
      targetPoolId: target,
      linkCourses: true,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().linkedCourseIds).toEqual([seeded.courseId]);
    const links = await server.app.db
      .select()
      .from(coursePools)
      .where(and(eq(coursePools.courseId, seeded.courseId), eq(coursePools.poolId, target)));
    expect(links).toHaveLength(1);
    const [after] = await server.app.db
      .select()
      .from(questions)
      .where(eq(questions.id, seeded.questionIds[0]!));
    expect(after!.poolId).toBe(target);
  });

  it("never links a course the caller is not staff of", async () => {
    const colleague = await server.signIn("teacher");
    const seeded = await seedLive(server.app.db, {
      teacherId: colleague.id,
      questions: 1,
      students: 0,
    });
    // A seat in the colleague's pool, and none on their course.
    await server.app.db
      .insert(poolMembers)
      .values({ poolId: seeded.poolId, userId: mover.id, role: "contributor" });
    const target = await newPool(mover, "Mine, not the course's");

    const asked = await move(mover, {
      questionIds: [seeded.questionIds[0]!],
      targetPoolId: target,
    });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().courses[0]).toMatchObject({ courseId: seeded.courseId, mayLink: false });

    const forced = await move(mover, {
      questionIds: [seeded.questionIds[0]!],
      targetPoolId: target,
      linkCourses: true,
    });
    expect(forced.statusCode).toBe(409);
    expect(forced.json().error).toBe("course_forbidden");
    expect(forced.json().courses[0].courseId).toBe(seeded.courseId);
    const links = await server.app.db
      .select()
      .from(coursePools)
      .where(and(eq(coursePools.courseId, seeded.courseId), eq(coursePools.poolId, target)));
    expect(links).toHaveLength(0);
  });

  it("moves a question a classroom plays when the target pool is already linked", async () => {
    const seeded = await seedLive(server.app.db, {
      teacherId: mover.id,
      questions: 1,
      students: 0,
    });
    const target = await newPool(mover, "Already one of the course's pools");
    await server.app.db.insert(coursePools).values({ courseId: seeded.courseId, poolId: target });

    const res = await move(mover, {
      questionIds: [seeded.questionIds[0]!],
      targetPoolId: target,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().linkedCourseIds).toEqual([]);
  });
});
