/**
 * The names of the grading panel over HTTP (F-GRADE-03, #119): the whole
 * plugin chain, the real guards and the real session cookie, so what is
 * checked is the query string as the SPA sends it — `anonymous=0` / `=1` —
 * and not a service call that already holds a boolean.
 *
 * Hidden by default, the name on request: the real name travels only when
 * `anonymous=0` is asked for, and never, anywhere in the body, otherwise.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { users } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";
import * as live from "../live/service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let evaluationId: string;
let firstItemId: string;
let firstAttemptId: string;

/** Two students as an identity provider fills them: given and family names. */
const STUDENTS = [
  { givenName: "Ada", familyName: "Lovelace" },
  { givenName: "Alan", familyName: "Turing" },
];
const NAMES = STUDENTS.map((s) => `${s.givenName} ${s.familyName}`);

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-09-20T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  const db = server.app.db;

  const studentIds: string[] = [];
  for (const student of STUDENTS) {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      oidcSub: `test-${id}`,
      email: `${student.givenName.toLowerCase()}@heig.test`,
      ...student,
      role: "student",
    });
    studentIds.push(id);
  }
  const seed = await seedLive(db, { teacherId: teacher.id, studentIds, questions: 2 });
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
  const attemptIds: string[] = [];
  for (const userId of studentIds) {
    server.clock.advance(1);
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, server.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, server.clock.now());
    attemptIds.push(attempt.id);
  }
  evaluation = await live.closeEvaluation(db, evaluation, server.clock.now());
  evaluationId = evaluation.id;
  firstItemId = seed.itemIds[0]!;
  firstAttemptId = attemptIds[0]!;
});
afterAll(async () => {
  await server.close();
  restore();
});

const get = (url: string) => server.app.inject({ method: "GET", url, headers: teacher.headers });

/** Every read of the panel that names a student, with the switch as given. */
async function namedReads(anonymous: string) {
  const base = `/app/api/evaluations/${evaluationId}/grading`;
  const urls = [
    `${base}/steps?by=student&anonymous=${anonymous}`,
    `${base}?by=question&itemId=${firstItemId}&anonymous=${anonymous}`,
    `${base}?by=student&attemptId=${firstAttemptId}&anonymous=${anonymous}`,
  ];
  const replies = await Promise.all(urls.map(get));
  for (const reply of replies) expect(reply.statusCode).toBe(200);
  const [steps, byQuestion, byStudent] = replies.map((r) => r.json());
  return {
    raw: replies.map((r) => r.body).join("\n"),
    steps: (steps.steps as { label: string }[]).map((s) => s.label),
    byQuestion: (byQuestion.entries as { label: string }[]).map((e) => e.label),
    byStudent: (byStudent.entries as { label: string }[]).map((e) => e.label),
  };
}

describe("grading routes — names (F-GRADE-03, #119)", () => {
  it("anonymous=0 labels every student with their real name", async () => {
    const named = await namedReads("0");
    expect(named.steps).toEqual(NAMES);
    expect(named.byQuestion).toEqual(NAMES);
    expect(named.byStudent).toEqual([NAMES[0], NAMES[0]]);
  });

  it("anonymous=1, and no parameter at all, never carry a real name", async () => {
    const named = await namedReads("0");
    for (const reads of [await namedReads("1"), await namedReads("")]) {
      // The same students, in the same places, under pseudonyms.
      expect(reads.steps).toHaveLength(named.steps.length);
      expect(reads.byQuestion).toHaveLength(named.byQuestion.length);
      for (const label of [...reads.steps, ...reads.byQuestion, ...reads.byStudent]) {
        expect(label).not.toBe("—");
      }
      // And not a trace of a name, a family name or an address in the body.
      for (const student of STUDENTS) {
        expect(reads.raw).not.toContain(student.givenName);
        expect(reads.raw).not.toContain(student.familyName);
        expect(reads.raw).not.toContain(`${student.givenName.toLowerCase()}@heig.test`);
      }
    }
  });
});
