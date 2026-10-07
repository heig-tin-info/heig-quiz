/**
 * ADR-076 (issue #525): entering a running evaluation is not starting it.
 * A participant with no attempt row is answered `ready` and nothing is
 * written; `POST /evaluations/:id/attempt/start` is the explicit act.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import { registerForTests } from "@quiz/registry/server";

import { attempts } from "../../db/schema.js";
import { subscribe, type Topic } from "../../events.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { openSebSession } from "../../auth/testing.js";
import { publishParameterized } from "../../test/parameterized.js";
import { addItems, applyState, byId } from "../evaluation/service.js";
import { exampleConfig, typeOf } from "../pool/service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
});
afterAll(async () => {
  await server.close();
  restore();
});

const post = (url: string, headers: Record<string, string>, payload: Payload = {}) =>
  server.app.inject({ method: "POST", url, headers, payload });
const rowsOf = (evaluationId: string) =>
  server.app.db.select().from(attempts).where(eq(attempts.evaluationId, evaluationId));

/** A fresh evaluation with one seated student, running (started by the teacher). */
async function running(options: { durationS?: number; timeBonusPercent?: number } = {}) {
  const student = await server.signIn("student");
  const seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 1,
    ...(options.durationS === undefined ? {} : { durationS: options.durationS }),
    ...(options.timeBonusPercent === undefined ? {} : { timeBonusPercent: options.timeBonusPercent }),
  });
  const entry = `/app/api/evaluations/${seed.evaluationId}/attempt`;
  const started = await post(`/app/api/evaluations/${seed.evaluationId}/start`, teacher.headers, {
    confirm: true,
  });
  expect(started.statusCode, started.body).toBe(200);
  return { student, seed, entry, start: `${entry}/start` };
}

describe("entering a running evaluation", () => {
  it("answers the ready screen and writes nothing", async () => {
    const { student, seed, entry } = await running();
    const events: Topic[][] = [];
    const stop = subscribe((m) => {
      if (m.kind === "hint" || m.kind === "data") events.push(m.topics as Topic[]);
    });
    try {
      const res = await post(entry, student.headers);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.kind).toBe("ready");
      expect(body.view.evaluation).toMatchObject({ id: seed.evaluationId, timing: "duration" });
      // No question content on the ready screen (invariant 4).
      expect(Object.keys(body.view)).not.toContain("items");
      expect(JSON.stringify(body)).not.toContain('"student"');
      expect(await rowsOf(seed.evaluationId)).toEqual([]);
      expect(events.flat().filter((t) => t === `lobby:${seed.evaluationId}`)).toEqual([]);
      // Entering twice is still a look.
      expect((await post(entry, student.headers)).json().kind).toBe("ready");
      expect(await rowsOf(seed.evaluationId)).toEqual([]);
    } finally {
      stop();
    }
  });

  it("keeps the 404 of a student without a seat", async () => {
    const { seed, entry } = await running();
    const stranger = await server.signIn("student");
    expect((await post(entry, stranger.headers)).statusCode).toBe(404);
    expect((await post(`${entry}/start`, stranger.headers)).statusCode).toBe(404);
    expect(await rowsOf(seed.evaluationId)).toEqual([]);
  });

  it("begins directly when the row exists (entered in the lobby)", async () => {
    const student = await server.signIn("student");
    const seed = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [student.id],
      questions: 1,
    });
    const entry = `/app/api/evaluations/${seed.evaluationId}/attempt`;
    await applyState(server.app.db, await reload(server.app.db, seed.evaluationId), "lobby", server.clock.now());
    expect((await post(entry, student.headers)).json().kind).toBe("lobby");
    expect((await rowsOf(seed.evaluationId))[0]!.state).toBe("not_started");
    await applyState(server.app.db, await reload(server.app.db, seed.evaluationId), "running", server.clock.now());
    const entered = await post(entry, student.headers);
    expect(entered.json().kind).toBe("attempt");
    expect((await rowsOf(seed.evaluationId))[0]!.state).toBe("in_progress");
  });
});

describe("POST /evaluations/:id/attempt/start", () => {
  it("begins the attempt with the deadline from now, and is idempotent", async () => {
    const { student, seed, start } = await running({ durationS: 1200 });
    const first = await post(start, student.headers);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().kind).toBe("attempt");
    const [row] = await rowsOf(seed.evaluationId);
    expect(row!.state).toBe("in_progress");
    expect(row!.startedAt).not.toBeNull();
    const duration = (row!.deadlineAt!.getTime() - row!.startedAt!.getTime()) / 1000;
    expect(duration).toBe(1200);

    const second = await post(start, student.headers);
    expect(second.json().view.attempt.id).toBe(first.json().view.attempt.id);
    expect(second.json().view.attempt.startedAt).toBe(first.json().view.attempt.startedAt);
    expect(await rowsOf(seed.evaluationId)).toHaveLength(1);
  });

  it("applies the participant's time bonus", async () => {
    const { student, seed, start, entry } = await running({ durationS: 1000, timeBonusPercent: 50 });
    // The ready screen states it in the conditions' duration line (ADR-079).
    expect((await post(entry, student.headers)).json().view.conditions.imposed).toContainEqual({
      key: "duration",
      kind: "info",
      durationS: 1000,
      bonusPercent: 50,
    });
    const res = await post(start, student.headers);
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await rowsOf(seed.evaluationId);
    expect((row!.deadlineAt!.getTime() - row!.startedAt!.getTime()) / 1000).toBe(1500);
  });

  it("answers the lobby, not a start, while the evaluation waits", async () => {
    const student = await server.signIn("student");
    const seed = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [student.id],
      questions: 1,
    });
    await applyState(server.app.db, await reload(server.app.db, seed.evaluationId), "lobby", server.clock.now());
    const res = await post(`/app/api/evaluations/${seed.evaluationId}/attempt/start`, student.headers);
    expect(res.json().kind).toBe("lobby");
    expect((await rowsOf(seed.evaluationId))[0]!.state).toBe("not_started");
  });

  it("is refused on a closed evaluation with no attempt (not_open)", async () => {
    const { student, seed, start } = await running();
    await applyState(server.app.db, await reload(server.app.db, seed.evaluationId), "closed", server.clock.now());
    const res = await post(start, student.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_open");
    expect(await rowsOf(seed.evaluationId)).toEqual([]);
  });
});

describe("what the two entry routes answer (invariant 4)", () => {
  it("is `{ kind, view }` and nothing else, no seed and no drawn values, for ready, lobby and attempt", async () => {
    const student = await server.signIn("student");
    const db = server.app.db;
    const seed = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const questionId = await publishParameterized(db, {
      poolId: seed.poolId,
      teacherId: teacher.id,
      type: "mcq",
    });
    await addItems(
      db,
      (await byId(db, seed.evaluationId))!,
      [questionId],
      (type, version) => typeOf(type).defaultPoints(exampleConfig(type, version)),
      { attemptCount: 0 },
    );
    const entry = `/app/api/evaluations/${seed.evaluationId}/attempt`;
    const answers: { kind: string; body: string; keys: string[] }[] = [];
    const record = async (url: string) => {
      const res = await post(url, student.headers);
      expect(res.statusCode, res.body).toBe(200);
      answers.push({ kind: res.json().kind, body: res.body, keys: Object.keys(res.json()).sort() });
    };

    // Ready first: running, no row.
    await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
    await record(entry);
    await record(`${entry}/start`);
    await record(entry);
    expect(answers.map((a) => a.kind)).toEqual(["ready", "attempt", "attempt"]);

    // The lobby, for a second student seated in the same classroom.
    const other = await server.signIn("student");
    const lobbySeed = await seedLive(db, { teacherId: teacher.id, studentIds: [other.id], questions: 1 });
    await applyState(db, await reload(db, lobbySeed.evaluationId), "lobby", server.clock.now());
    const waiting = await post(`/app/api/evaluations/${lobbySeed.evaluationId}/attempt`, other.headers);
    answers.push({ kind: waiting.json().kind, body: waiting.body, keys: Object.keys(waiting.json()).sort() });
    expect(answers.at(-1)!.kind).toBe("lobby");

    for (const a of answers) {
      expect(a.keys).toEqual(["kind", "view"]);
      expect(a.body).not.toContain('"seed"');
      expect(a.body).not.toContain('"instances"');
    }
  });
});

describe("a trusted client", () => {
  it("begins directly: a seb session on a running evaluation with no row answers the attempt", async () => {
    const student = await server.signIn("student");
    const seed = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [student.id],
      mode: "exam",
      settings: { safeExamBrowser: true },
      questions: 1,
    });
    await post(`/app/api/evaluations/${seed.evaluationId}/start`, teacher.headers, { confirm: true });
    const seb = await openSebSession(server, seed.evaluationId, student.headers);
    const url = `/app/api/evaluations/${seed.evaluationId}/attempt`;
    const res = await server.app.inject({ method: "POST", url, headers: seb(url), payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().kind).toBe("attempt");
    expect((await rowsOf(seed.evaluationId))[0]!.state).toBe("in_progress");
  });
});
