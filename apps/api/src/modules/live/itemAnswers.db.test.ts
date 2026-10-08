/**
 * F-DASH-07: one question of the live grid opened for the whole class
 * (`GET /evaluations/:id/items/:itemId/answers`, issue #353), over the real
 * application. The staff of the course read every student's answer to the
 * item; a teacher off the staff gets the 404 of a missing evaluation, and a
 * student the refusal they get on any staff route — never a sign that the
 * evaluation is there (invariant 6).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { ItemAnswers } from "@quiz/contracts";

import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive } from "../../test/live.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let teacher: Who;
let student: Who;
let other: Who;
let seed: Awaited<ReturnType<typeof seedLive>>;
let attemptId: string;

const get = (url: string, who: Who) => server.app.inject({ method: "GET", url, headers: who.headers });
const url = (itemId: string, evaluationId = seed.evaluationId) =>
  `/app/api/evaluations/${evaluationId}/items/${itemId}/answers`;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  other = await server.signIn("student");
  seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [student.id, other.id],
    questions: 2,
  });
  await server.app.inject({
    method: "POST",
    url: `/app/api/evaluations/${seed.evaluationId}/start`,
    headers: teacher.headers,
    payload: { confirm: true },
  });
  const entered = await server.app.inject({
    method: "POST",
    url: `/app/api/evaluations/${seed.evaluationId}/attempt/start`,
    headers: student.headers,
    payload: {},
  });
  attemptId = entered.json().view.attempt.id;
  const saved = await server.app.inject({
    method: "PUT",
    url: `/app/api/attempts/${attemptId}/answers/${seed.itemIds[0]}`,
    headers: student.headers,
    payload: { payload: "Rome", revision: 1, clientTs: server.clock.now().toISOString() },
  });
  expect(saved.statusCode).toBe(200);
});
afterAll(async () => {
  await server.close();
  restore();
});

describe("one question for the whole class (F-DASH-07)", () => {
  it("hands the staff every started student's answer to the item, with the key", async () => {
    const res = await get(url(seed.itemIds[0]!), teacher);
    expect(res.statusCode).toBe(200);
    const view = ItemAnswers.parse(res.json());
    expect(view.item).toMatchObject({ id: seed.itemIds[0], position: 0 });
    // One entry per attempt: the second student has not started, so has none.
    expect(view.answers).toHaveLength(1);
    expect(view.answers[0]).toMatchObject({
      attemptId,
      answer: "Rome",
      revision: 1,
      skipped: false,
      flagged: false,
      solution: { answer: "answer-q0" },
    });
    // No name travels: the dashboard names the row itself (F-DASH-02).
    expect(JSON.stringify(view)).not.toMatch(/Nom0|Prenom0|@heig\.test/);
  });

  it("reads an unanswered item as a null answer, not as a missing student", async () => {
    const view = ItemAnswers.parse((await get(url(seed.itemIds[1]!), teacher)).json());
    expect(view.answers).toEqual([
      expect.objectContaining({ attemptId, answer: null, revision: 0 }),
    ]);
  });

  it("answers an item of no such evaluation, or of another one, like a missing evaluation", async () => {
    const missing = await get(url(crypto.randomUUID()), teacher);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });

    const elsewhere = await seedLive(server.app.db, { teacherId: teacher.id, questions: 1 });
    const foreignItem = await get(url(elsewhere.itemIds[0]!), teacher);
    expect(foreignItem.statusCode).toBe(404);
    expect(foreignItem.json()).toEqual({ error: "not_found" });
  });

  it("gives a teacher off the staff the 404 of a missing evaluation", async () => {
    const stranger = await server.signIn("teacher");
    const real = await get(url(seed.itemIds[0]!), stranger);
    const absent = await get(url(seed.itemIds[0]!, crypto.randomUUID()), stranger);
    expect(real.statusCode).toBe(404);
    expect(real.json()).toEqual({ error: "not_found" });
    expect(real.json()).toEqual(absent.json());
  });

  it("gives a student of the class exactly what a missing evaluation gives them", async () => {
    const real = await get(url(seed.itemIds[0]!), student);
    const absent = await get(url(seed.itemIds[0]!, crypto.randomUUID()), student);
    expect(real.statusCode).not.toBe(200);
    expect(real.statusCode).toBe(absent.statusCode);
    expect(real.json()).toEqual(absent.json());
    expect(real.body).not.toContain("Rome");
  });
});
