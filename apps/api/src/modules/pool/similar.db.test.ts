/**
 * `GET /courses/:id/similar-questions` (ADR-022, addendum of 2026-10-01): the
 * published questions closest to a statement, over a real application.
 *
 * The world: a course with an exam on its linked pool (seedLive), the
 * teacher's own unlinked pool, a colleague's PUBLIC pool and a colleague's
 * PRIVATE one, and a draft that was never published. The ranking, the three
 * scopes, the flags — and what must never appear: a pool the caller cannot
 * reach, a draft, statistics under ten answers.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SimilarQuestions } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { attempts, questions } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { publishQuestion, seedLive, type Seeded } from "../../test/live.js";
import { writeGrading } from "../grading/service.js";
import { poolQuestionStats } from "../stats/service.js";
import * as poolService from "./service.js";

let server: TestServer;
let db: Db;
let restore: () => void;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let teacher: Actor;
let colleague: Actor;
let seed: Seeded;
const ids = {} as Record<"linkedStrong" | "linkedWeak" | "own" | "public" | "private" | "draft", string>;

const STARTED = new Date("2026-09-01T08:00:00.000Z");

/** A new published version of `id` saying `statement`. */
async function republish(id: string, statement: string) {
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, question!, { config: { statement, answer: "x" } });
  await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
}

async function newPool(who: Actor, name: string, isPublic = false) {
  const res = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: who.headers,
    payload: { name, isPublic },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

const short = (statement: string) => ({ type: "short", config: { statement, answer: "x" } });

/** Every student sits the exam once; the first `graded[i]` are validated on item `i`. */
async function sit(graded: readonly number[]) {
  for (const [rank, userId] of seed.studentIds.entries()) {
    const attemptId = randomUUID();
    await db.insert(attempts).values({
      id: attemptId,
      evaluationId: seed.evaluationId,
      userId,
      seed: 1,
      state: "submitted",
      attemptNumber: 1,
      startedAt: STARTED,
      // An attempt of before the dwell was measured: counted without an answer row (ADR-039).
      displayTracked: false,
    });
    for (const [index, count] of graded.entries()) {
      if (rank < count) await validate(attemptId, seed.itemIds[index]!);
    }
  }
}

async function validate(attemptId: string, itemId: string) {
  await writeGrading(db, {
    attemptId,
    itemId,
    answerId: null,
    points: 1,
    maxPoints: 1,
    source: "manual",
    state: "validated",
    now: STARTED,
  });
}

async function similar(who: Actor, query: Record<string, string>, courseId = seed.courseId) {
  return server.app.inject({
    method: "GET",
    url: `/app/api/courses/${courseId}/similar-questions?${new URLSearchParams(query)}`,
    headers: who.headers,
  });
}

async function hits(query: Record<string, string>) {
  const res = await similar(teacher, query);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<SimilarQuestions>().items;
}

const TEXT = "Quelle est la complexité du tri rapide quand le pivot est mal choisi ?";

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  db = server.app.db;
  teacher = await server.signIn("teacher");
  colleague = await server.signIn("teacher");
  seed = await seedLive(db, { teacherId: teacher.id, students: 10, questions: 2 });

  // The course's linked pool: a strong match and a weak one.
  ids.linkedStrong = seed.questionIds[0]!;
  ids.linkedWeak = seed.questionIds[1]!;
  await republish(ids.linkedStrong, "Complexité du tri rapide avec un mauvais pivot");
  await republish(ids.linkedWeak, "Écrire un tri par insertion");
  // Ten counted exam answers on the first, three on the second.
  await sit([10, 3]);

  const own = await newPool(teacher, "Mes algorithmes");
  ids.own = await publishQuestion(db, own, teacher.id, "own", short("Le tri rapide est-il stable ?"));
  const open = await newPool(colleague, "Algorithmes publics", true);
  ids.public = await publishQuestion(db, open, colleague.id, "pub", short("Complexité moyenne du tri rapide"));
  const closed = await newPool(colleague, "Privé");
  ids.private = await publishQuestion(db, closed, colleague.id, "priv", short(TEXT));
  // A draft, in the linked pool, word for word the search: never a hit.
  const draft = await poolService.createQuestion(db, {
    poolId: seed.poolId,
    type: "short",
    internalName: "draft",
    createdBy: teacher.id,
  });
  const [draftRow] = await db.select().from(questions).where(eq(questions.id, draft.id));
  await poolService.putDraft(db, draftRow!, { config: { statement: TEXT, answer: "x" } });
  ids.draft = draft.id;
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("GET /courses/:id/similar-questions", () => {
  it("puts the course's pools first, then every reachable pool, each by shared words", async () => {
    // Four words shared, then one, in the course's pools; three, then two, elsewhere.
    const items = await hits({ text: TEXT });
    expect(items.map((h) => h.questionId)).toEqual([ids.linkedStrong, ids.linkedWeak, ids.public, ids.own]);
  });

  it("never returns a pool the caller cannot reach, nor a draft", async () => {
    const found = (await hits({ text: TEXT, limit: "50" })).map((h) => h.questionId);
    expect(found).not.toContain(ids.private);
    expect(found).not.toContain(ids.draft);
  });

  it("flags each hit: linked, can link, its pool, its excerpt, its latest version", async () => {
    const byId = new Map((await hits({ text: TEXT })).map((h) => [h.questionId, h]));
    expect(byId.get(ids.linkedStrong)).toMatchObject({
      pool: { id: seed.poolId, name: "Pool" },
      type: "short",
      internalName: "q0",
      excerpt: "Complexité du tri rapide avec un mauvais pivot",
      latestNumber: 2,
      linked: true,
      canLink: true,
    });
    expect(byId.get(ids.own)).toMatchObject({ linked: false, canLink: true });
    // A colleague's public pool is read-only for the caller: linking it is refused (ADR-013).
    expect(byId.get(ids.public)).toMatchObject({ linked: false, canLink: false, pool: { name: "Algorithmes publics" } });
  });

  it("gives the pool screen's statistics, withheld under ten answers", async () => {
    const byId = new Map((await hits({ text: TEXT })).map((h) => [h.questionId, h]));
    expect(byId.get(ids.linkedStrong)!.stats).toEqual({ n: 10, p: 1, r: null });
    expect(byId.get(ids.linkedWeak)!.stats).toBeNull();
    expect(byId.get(ids.own)!.stats).toBeNull();
    // Narrowed to the hits, the pool screen's figures are the same.
    const whole = await poolQuestionStats(db, seed.poolId);
    const narrowed = await poolQuestionStats(db, seed.poolId, [ids.linkedStrong]);
    expect(narrowed.items).toEqual(whole.items.filter((i) => i.questionId === ids.linkedStrong));
  });

  it("filters by type, cuts at limit, and finds nothing in stop words", async () => {
    expect(await hits({ text: TEXT, type: "code" })).toEqual([]);
    expect(await hits({ text: TEXT, limit: "1" })).toHaveLength(1);
    expect(await hits({ text: "Quelle est la ? Which of the following" })).toEqual([]);
  });

  it("answers 404 off the course's staff, and 400 without a text", async () => {
    expect((await similar(colleague, { text: TEXT })).statusCode).toBe(404);
    expect((await similar(teacher, { text: TEXT }, randomUUID())).statusCode).toBe(404);
    expect((await similar(teacher, {})).statusCode).toBe(400);
  });
});
