/**
 * The concepts a course declares (F-ORG-12, ADR-081 §8, sixth addendum):
 * every staff member reads them, only an owner replaces the list (403
 * `owner_required` for an assistant, ADR-068), anyone else gets the 404 of a
 * missing course; a `proposed` concept may be listed, a merged or unknown one
 * is refused; a listed concept cannot be deleted; a merge rewrites the links;
 * and no student response ever carries the list (invariants 4 and 6).
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CourseConcepts, CourseDetail } from "@quiz/contracts";
import { qualifiedConceptKey } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { auditLog, concepts, courseConcepts, courseStaff } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let owner: Caller;
let assistant: Caller;
let outsider: Caller;
let student: Caller;
let admin: Caller;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  assistant = await server.signIn("teacher");
  outsider = await server.signIn("teacher");
  student = await server.signIn("student");
  admin = await server.signIn("admin");
});
afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const send = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, caller: Caller, payload?: unknown) =>
  server.app.inject({ method, url, headers: caller.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

/** A course of `owner`, with `assistant` on its staff and `student` in its classroom. */
async function seed() {
  const seeded = await seedLive(db(), { teacherId: owner.id, studentIds: [student.id] });
  await db().insert(courseStaff).values({ courseId: seeded.courseId, userId: assistant.id, role: "assistant" });
  return seeded;
}

async function concept(en: string, fr: string, status: "proposed" | "validated" = "validated"): Promise<string> {
  const id = randomUUID();
  await db().insert(concepts).values({
    id,
    status,
    createdBy: owner.id,
    labelFr: fr,
    keyFr: qualifiedConceptKey(fr, ""),
    labelEn: en,
    keyEn: qualifiedConceptKey(en, ""),
  });
  return id;
}

const base = (courseId: string) => `/app/api/courses/${courseId}/concepts`;
const put = (courseId: string, caller: Caller, conceptIds: string[]) => send("PUT", base(courseId), caller, { conceptIds });
const listed = async (courseId: string, caller: Caller = owner) =>
  ((await send("GET", base(courseId), caller)).json() as CourseConcepts).concepts;
const linkIds = async (courseId: string) =>
  (await db().select().from(courseConcepts).where(eq(courseConcepts.courseId, courseId))).map((r) => r.conceptId).sort();

describe("the course concepts routes", () => {
  it("are read by every staff member, written by an owner only, a 404 for anyone else", async () => {
    const { courseId } = await seed();
    const b = await concept("Bravo pointer", "Bravo pointeur");
    const a = await concept("Alpha loop", "Alpha boucle");

    const res = await put(courseId, owner, [b, a, b]);
    expect(res.statusCode, res.body).toBe(200);
    // Sorted by label, whatever the order sent, a duplicate listed once.
    expect((res.json() as CourseConcepts).concepts.map((c) => c.id)).toEqual([a, b]);
    expect((await listed(courseId, assistant)).map((c) => c.id)).toEqual([a, b]);

    const refused = await put(courseId, assistant, []);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "owner_required" });
    // The refusal comes before the body is read.
    expect((await send("PUT", base(courseId), assistant, { conceptIds: "nope" })).statusCode).toBe(403);
    expect(await linkIds(courseId)).toEqual([a, b].sort());

    for (const [method, payload] of [["GET", undefined], ["PUT", { conceptIds: [] }]] as const) {
      const out = await send(method, base(courseId), outsider, payload);
      expect(out.statusCode, method).toBe(404);
    }
    expect((await send("PUT", base(courseId), outsider, { conceptIds: "nope" })).statusCode).toBe(404);
    expect((await send("GET", base(courseId), student)).statusCode).toBeGreaterThanOrEqual(403);
    expect(await linkIds(courseId)).toEqual([a, b].sort());
  });

  it("replaces the whole set, keeps the author of a link already there, and refuses an unknown id", async () => {
    const { courseId } = await seed();
    const a = await concept("Stack", "Pile");
    const b = await concept("Heap", "Tas");
    await put(courseId, owner, [a]);
    expect((await put(courseId, owner, [a, b])).statusCode).toBe(200);
    const [kept] = await db()
      .select()
      .from(courseConcepts)
      .where(and(eq(courseConcepts.courseId, courseId), eq(courseConcepts.conceptId, a)));
    expect(kept).toMatchObject({ addedBy: owner.id });
    expect((await put(courseId, owner, [b])).statusCode).toBe(200);
    expect(await linkIds(courseId)).toEqual([b]);

    const unknown = randomUUID();
    const res = await put(courseId, owner, [b, unknown]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "concept_not_found" });
    expect(JSON.stringify(res.json())).toContain(unknown);
    expect(await linkIds(courseId)).toEqual([b]);
    expect((await put(courseId, owner, [])).statusCode).toBe(200);
    expect(await linkIds(courseId)).toEqual([]);
  });

  it("allows a proposed concept and refuses a merged one", async () => {
    const { courseId } = await seed();
    const proposed = await concept("Proposed idea", "Idée proposée", "proposed");
    const loser = await concept("Old name", "Ancien nom");
    const winner = await concept("New name", "Nouveau nom");
    expect((await send("POST", `/app/api/admin/concepts/${loser}/merge`, admin, { into: winner, keepAsAlias: false })).statusCode).toBe(200);

    expect((await put(courseId, owner, [proposed])).statusCode).toBe(200);
    expect((await listed(courseId))[0]).toMatchObject({ id: proposed, status: "proposed" });
    const res = await put(courseId, owner, [proposed, loser]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "concept_not_found" });
    expect(await linkIds(courseId)).toEqual([proposed]);
  });

  it("audits what was added and removed, and nothing when nothing changed", async () => {
    const { courseId } = await seed();
    const a = await concept("Audit A", "Audit A");
    const b = await concept("Audit B", "Audit B");
    await put(courseId, owner, [a]);
    await put(courseId, owner, [a]);
    await put(courseId, owner, [b]);
    const rows = await db()
      .select({ id: auditLog.id, payload: auditLog.payload, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.action, "course.concepts_update"), eq(auditLog.subjectId, courseId)))
      .orderBy(auditLog.id);
    expect(rows.map((r) => r.payload)).toEqual([
      { added: [a], removed: [] },
      { added: [b], removed: [a] },
    ]);
    expect(rows[0]?.actor).toBe(owner.id);
  });

  it("is part of the staff's course detail, in the reader's language, and of nobody else's", async () => {
    const { courseId } = await seed();
    const a = await concept("Recursion", "Récursivité");
    await put(courseId, owner, [a]);
    const detail = (await send("GET", `/app/api/courses/${courseId}`, assistant)).json() as CourseDetail;
    expect(detail.concepts).toMatchObject([{ id: a, label: expect.stringMatching(/Recursion|Récursivité/) }]);
    expect((await send("GET", `/app/api/courses/${courseId}`, outsider)).statusCode).toBe(404);
  });
});

describe("a concept a course lists", () => {
  it("cannot be deleted (409 concept_in_use), until the course drops it", async () => {
    const { courseId } = await seed();
    const a = await concept("Listed", "Listé", "proposed");
    await put(courseId, owner, [a]);
    const blocked = await send("DELETE", `/app/api/admin/concepts/${a}`, admin);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "concept_in_use" });
    const queue = await send("GET", "/app/api/admin/concepts", admin);
    const row = (queue.json() as { concepts: { id: string; deletable: boolean }[] }).concepts.find((c) => c.id === a);
    expect(row?.deletable).toBe(false);

    await put(courseId, owner, []);
    expect((await send("DELETE", `/app/api/admin/concepts/${a}`, admin)).statusCode).toBe(204);
  });

  it("is rewritten by a merge: moved to the winner, a duplicate collapsed, audited", async () => {
    const one = await seed();
    const two = await seed();
    const three = await seed();
    const loser = await concept("Pointage", "Pointage");
    const winner = await concept("Pointeur", "Pointeur");
    await put(one.courseId, owner, [loser]);
    await put(two.courseId, owner, [loser, winner]);
    await put(three.courseId, owner, [winner]);

    const res = await send("POST", `/app/api/admin/concepts/${loser}/merge`, admin, { into: winner, keepAsAlias: false });
    expect(res.statusCode, res.body).toBe(200);

    expect(await linkIds(one.courseId)).toEqual([winner]);
    expect(await linkIds(two.courseId)).toEqual([winner]);
    expect(await linkIds(three.courseId)).toEqual([winner]);
    expect((await listed(one.courseId)).map((c) => c.id)).toEqual([winner]);

    const [entry] = await db()
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.action, "concept.merge"), eq(auditLog.subjectId, loser)));
    expect(entry?.payload).toMatchObject({
      coursesMoved: [one.courseId],
      coursesAlreadyListed: [two.courseId],
    });
  });
});

describe("the student views", () => {
  it("never carry a course's concepts, in the classroom page or the student's list", async () => {
    const { courseId, classroomId } = await seed();
    const secret = await concept("Zxqv secret notion", "Notion zxqv secrète", "proposed");
    await put(courseId, owner, [secret]);

    const list = await send("GET", "/app/api/student/classrooms", student);
    expect(list.statusCode).toBe(200);
    const gradebook = await send("GET", `/app/api/student/classrooms/${classroomId}/gradebook`, student);
    expect(gradebook.statusCode).toBe(200);
    // The teacher routes are refused to a student, and refuse without a word of the list.
    const course = await send("GET", `/app/api/courses/${courseId}`, student);
    expect(course.statusCode).toBeGreaterThanOrEqual(403);
    for (const res of [list, gradebook, course]) {
      expect(res.body).not.toMatch(/zxqv/i);
      expect(res.body).not.toContain(secret);
    }
    // The staff's classroom page does not carry it either: the list is read from the course.
    const staffPage = await send("GET", `/app/api/classrooms/${classroomId}`, owner);
    expect(staffPage.statusCode).toBe(200);
    expect(staffPage.body).not.toMatch(/zxqv/i);
  });
});
