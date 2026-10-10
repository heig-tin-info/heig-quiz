/**
 * The course filter of a pool's question list (#599 step 7b, ADR-081 sixth
 * addendum): `?course=<id>` keeps the questions that exercise a concept the
 * course lists, and is refused with the 404 of a missing course unless the
 * caller staffs the course AND the pool is linked to it. The pool detail
 * offers exactly those courses, never one the caller does not staff.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PoolDetail, QuestionPage } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { courseConcepts, coursePools, courseStaff, courses, poolMembers } from "../../db/schema.js";
import { seedConcept } from "../../test/concepts.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let owner: Caller;
let member: Caller;
let outsider: Caller;
let poolId: string;
let linkedCourse: string;
let otherLinkedCourse: string;
let unlinkedCourse: string;
let emptyCourse: string;
const concept: Record<"loops" | "pointers" | "files", string> = { loops: "", pointers: "", files: "" };
const question: Record<"loop" | "pointer" | "both" | "plain", string> = { loop: "", pointer: "", both: "", plain: "" };

const db = () => server.app.db;

async function newCourse(code: string, staff: Caller[], conceptIds: string[]): Promise<string> {
  const id = randomUUID();
  await db().insert(courses).values({ id, name: `Course ${code}`, code });
  for (const s of staff) await db().insert(courseStaff).values({ courseId: id, userId: s.id, role: "owner" });
  for (const conceptId of conceptIds) {
    await db().insert(courseConcepts).values({ courseId: id, conceptId, addedBy: owner.id });
  }
  return id;
}

const list = (caller: Caller, query: string, id = poolId) =>
  server.app.inject({ method: "GET", url: `/app/api/pools/${id}/questions?${query}`, headers: caller.headers });
const idsOf = (res: { json: () => unknown }) =>
  QuestionPage.parse(res.json()).items.map((q) => q.id).sort();

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  member = await server.signIn("teacher");
  outsider = await server.signIn("teacher");
  concept.loops = await seedConcept(db(), owner.id, ["boucles"], ["loops"]);
  concept.pointers = await seedConcept(db(), owner.id, ["pointeurs"], ["pointers"]);
  concept.files = await seedConcept(db(), owner.id, ["fichiers"], ["files"]);

  const pool = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: owner.headers,
    payload: { name: "PRG1 pool" },
  });
  poolId = pool.json().id;
  await db().insert(poolMembers).values({ poolId, userId: member.id, role: "reader" });

  const create = async (internalName: string, concepts: string[]) => {
    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${poolId}/questions`,
      headers: owner.headers,
      payload: { type: "short", internalName, concepts },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().meta.id as string;
  };
  question.loop = await create("loop", [concept.loops]);
  question.pointer = await create("pointer", [concept.pointers]);
  question.both = await create("both", [concept.loops, concept.files]);
  question.plain = await create("plain", []);

  // The owner staffs two linked courses, one unlinked and one that lists nothing; the member staffs none.
  linkedCourse = await newCourse("PRG1", [owner], [concept.loops, concept.files]);
  otherLinkedCourse = await newCourse("PRG2", [owner, member], [concept.pointers]);
  emptyCourse = await newCourse("EMPTY", [owner], []);
  unlinkedCourse = await newCourse("ALGO", [owner], [concept.loops]);
  for (const courseId of [linkedCourse, otherLinkedCourse, emptyCourse]) {
    await db().insert(coursePools).values({ courseId, poolId, mode: "edit" });
  }
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("the course filter", () => {
  it("keeps the questions of the concepts the course lists", async () => {
    const res = await list(owner, `course=${linkedCourse}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(res)).toEqual([question.loop, question.both].sort());
    expect(QuestionPage.parse(res.json()).total).toBe(2);
    expect(idsOf(await list(owner, `course=${otherLinkedCourse}`))).toEqual([question.pointer]);
  });

  it("matches nothing for a course that lists no concept", async () => {
    const res = await list(owner, `course=${emptyCourse}`);
    expect(res.statusCode).toBe(200);
    expect(QuestionPage.parse(res.json())).toMatchObject({ items: [], total: 0 });
  });

  it("composes with the other filters", async () => {
    const res = await list(owner, `course=${linkedCourse}&concept=${concept.files}`);
    expect(idsOf(res)).toEqual([question.both]);
  });

  it("is a 404 for a course the caller does not staff", async () => {
    // The member reads the pool, but staffs only PRG2.
    const missing = await list(member, `course=${randomUUID()}`);
    const refused = await list(member, `course=${linkedCourse}`);
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual(missing.json());
    expect(missing.statusCode).toBe(404);
    expect(idsOf(await list(member, `course=${otherLinkedCourse}`))).toEqual([question.pointer]);
  });

  it("is a 404 for a course the caller staffs but the pool is not linked to", async () => {
    const res = await list(owner, `course=${unlinkedCourse}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual((await list(owner, `course=${randomUUID()}`)).json());
  });

  it("does not open a private pool to an outsider", async () => {
    expect((await list(outsider, `course=${linkedCourse}`)).statusCode).toBe(404);
  });

  it("is a 400 for something that is not an id", async () => {
    expect((await list(owner, "course=PRG1")).statusCode).toBe(400);
  });

  it("is offered in the pool detail as the linked courses the caller staffs, and no other", async () => {
    const detail = async (caller: Caller) =>
      PoolDetail.parse((await server.app.inject({ method: "GET", url: `/app/api/pools/${poolId}`, headers: caller.headers })).json())
        .filterCourses;
    expect((await detail(owner)).map((c) => c.code)).toEqual(["EMPTY", "PRG1", "PRG2"]);
    expect(await detail(member)).toEqual([{ id: otherLinkedCourse, name: "Course PRG2", code: "PRG2" }]);
  });
});
