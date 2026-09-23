/**
 * One whole life of a live poll, over the REAL application (F-LIVE-13,
 * F-AUTH-05, ADR-014): the personal pool, the create-and-start, the public
 * join with a guest cookie, the tally, the reveal, the end.
 *
 * It runs against the real question types (`mcq` and `short`), not the fake
 * of `test/fakeType.ts`: what the tally counts is what those types store, and
 * the leak check at the end is only worth something on a real answer key.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq, isNull } from "drizzle-orm";

import {
  attempts,
  auditLog,
  coursePools,
  courseStaff,
  evaluations,
  gradings,
  guestParticipants,
  pools,
  questions,
  questionVersions,
} from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { FORBIDDEN_STUDENT_KEYS } from "../live/studentView.js";
import * as poolService from "../pool/service.js";
import { createPoll, GUEST_COOKIE } from "./service.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let outsider: { id: string; headers: Record<string, string> };
let seed: Awaited<ReturnType<typeof seedLive>>;

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  outsider = await server.signIn("student");
  // `questions: 0`: this suite publishes its own, of the real types.
  seed = await seedLive(server.app.db, { teacherId: teacher.id, questions: 0 });
});
afterAll(async () => {
  await server.close();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  server.app.inject({
    method: "POST",
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });

/** The value of `quiz_guest` in a reply's `set-cookie`, or null. */
function guestCookieOf(response: Awaited<ReturnType<typeof post>>): string | null {
  const raw = response.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  for (const cookie of all) {
    const match = /^quiz_guest=([^;]+)/.exec(cookie);
    if (match) return match[1]!;
  }
  return null;
}

/** A published question of the teacher's personal pool, through the routes. */
async function publishPollQuestion(
  type: "mcq" | "short",
  internalName: string,
  config: unknown,
): Promise<string> {
  const created = await post("/app/api/polls/questions", teacher.headers, { type, internalName });
  expect(created.statusCode).toBe(201);
  const id = created.json().meta.id as string;
  const [question] = await server.app.db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(server.app.db, question!, { config });
  await poolService.publishQuestion(server.app.db, question!, { userId: teacher.id });
  return id;
}

const MCQ_CONFIG = {
  configVersion: 2,
  prompt: "Quelle est la capitale du canton de Vaud ?",
  choices: [
    { text: "Lausanne", correct: true },
    { text: "Yverdon", correct: false },
    { text: "Nyon", correct: false },
  ],
  mode: "single",
};

let questionId: string;
let code: string;
let evaluationId: string;

describe("the personal pool is the home of poll questions (F-POOL-01)", () => {
  it("creates it on the first question and reuses it on the second", async () => {
    questionId = await publishPollQuestion("mcq", "Capitale VD", MCQ_CONFIG);
    const second = await post("/app/api/polls/questions", teacher.headers, {
      type: "short",
      internalName: "Un mot",
    });
    expect(second.statusCode).toBe(201);

    const personal = await server.app.db
      .select()
      .from(pools)
      .where(and(eq(pools.ownerId, teacher.id), eq(pools.isPersonal, true)));
    expect(personal).toHaveLength(1);
    expect(personal[0]!.name).toBe(poolService.PERSONAL_POOL_NAME);
    expect(personal[0]!.visibility).toBe("private");
  });

  it("refuses a question type a poll cannot run", async () => {
    const refused = await post("/app/api/polls/questions", teacher.headers, {
      type: "code",
      internalName: "Pas en direct",
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("poll_type");
  });

  it("lists only the PUBLISHED pollable questions, never used last", async () => {
    const picks = await get("/app/api/polls/questions", teacher.headers);
    expect(picks.statusCode).toBe(200);
    const rows = picks.json() as { id: string; prompt: string; lastUsedAt: string | null }[];
    // "Un mot" has a draft only: it is not runnable (F-EVAL-03).
    expect(rows.map((r) => r.id)).toEqual([questionId]);
    expect(rows[0]).toMatchObject({ lastUsedAt: null, useCount: 0 });
    expect(rows[0]!.prompt).toContain("capitale");
  });
});

describe("creating and starting a poll", () => {
  it("creates an evaluation of mode poll, running, with one item and a code", async () => {
    const created = await post("/app/api/polls", teacher.headers, {
      classroomId: seed.classroomId,
      questionId,
      anonymous: true,
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    evaluationId = body.evaluation.id;
    code = body.evaluation.code;
    expect(body.evaluation.state).toBe("running");
    // Where the poll lives, in the same answer: the projection's context line
    // never asks a second route for a name it already implies.
    expect(body.evaluation).toMatchObject({
      classroomId: seed.classroomId,
      classroomName: "A",
      courseName: "Programmation C",
    });
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(body.joinUrl).toMatch(new RegExp(`/p/${code}$`));
    expect(body.settings).toEqual({ anonymous: true, revealed: false });
    expect(body.tally).toMatchObject({ joined: 0, answered: 0 });
    expect(body.tally.choices).toHaveLength(3);
  });

  it("draws a different code for every running poll", async () => {
    const other = await post("/app/api/polls", teacher.headers, {
      classroomId: seed.classroomId,
      questionId,
      anonymous: true,
    });
    expect(other.statusCode).toBe(201);
    expect(other.json().evaluation.code).not.toBe(code);
    // Closed straight away: it is only here for the uniqueness check.
    await post(`/app/api/evaluations/${other.json().evaluation.id}/poll/end`, teacher.headers);
  });

  it("lets the unique index settle two concurrent creates that draw the same code", async () => {
    // Both creates draw "RACE22" first; the index refuses whichever writes
    // second, and that one draws again. No check-then-insert is involved.
    const drawsOf = (...codes: string[]) => () => codes.shift() ?? "UNUSED";
    const input = {
      classroomId: seed.classroomId,
      questionId,
      anonymous: false,
      createdBy: teacher.id,
      now: server.clock.now(),
    };
    const [a, b] = await Promise.all([
      createPoll(server.app.db, { ...input, drawCode: drawsOf("RACE22", "RACE33") }),
      createPoll(server.app.db, { ...input, drawCode: drawsOf("RACE22", "RACE44") }),
    ]);
    const codes = [a.evaluation.accessCode, b.evaluation.accessCode].sort();
    expect(codes[0]).toBe("RACE22");
    expect(["RACE33", "RACE44"]).toContain(codes[1]);

    // A code no longer drawable at all ends in a 503, not a duplicate.
    await expect(
      createPoll(server.app.db, { ...input, drawCode: () => "RACE22" }),
    ).rejects.toMatchObject({ code: "code_exhausted", status: 503 });

    for (const scope of [a, b]) {
      await post(`/app/api/evaluations/${scope.evaluation.id}/poll/end`, teacher.headers);
    }
  });

  it("does not draw the code of a poll ended less than two hours ago", async () => {
    // RACE22 and its sibling were ended just above: a phone may still be on
    // them, so the draw skips them and takes the next code.
    const scope = await createPoll(server.app.db, {
      classroomId: seed.classroomId,
      questionId,
      anonymous: false,
      createdBy: teacher.id,
      now: server.clock.now(),
      drawCode: ((codes: string[]) => () => codes.shift() ?? "UNUSED")(["RACE22", "GRACE2"]),
    });
    expect(scope.evaluation.accessCode).toBe("GRACE2");
    await post(`/app/api/evaluations/${scope.evaluation.id}/poll/end`, teacher.headers);
  });

  it("answers 409 code_taken, not a 500, when a poll would run again on a code now held", async () => {
    // No route leads a poll back to `running` today; the row is put in
    // `paused` by hand to reach the generic resume route, which must then
    // meet the unique index with a clean refusal.
    const input = {
      classroomId: seed.classroomId,
      questionId,
      anonymous: false,
      createdBy: teacher.id,
      now: server.clock.now(),
    };
    const first = await createPoll(server.app.db, { ...input, drawCode: () => "HELD22" });
    await server.app.db
      .update(evaluations)
      .set({ state: "paused", pausedAt: server.clock.now() })
      .where(eq(evaluations.id, first.evaluation.id));
    // Paused, never closed: no phone can reach it by code, so the code is
    // free for a new poll.
    const second = await createPoll(server.app.db, { ...input, drawCode: () => "HELD22" });

    const resumed = await post(`/app/api/evaluations/${first.evaluation.id}/resume`, teacher.headers);
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json().error).toBe("code_taken");

    await post(`/app/api/evaluations/${second.evaluation.id}/poll/end`, teacher.headers);
    await server.app.db
      .update(evaluations)
      .set({ state: "closed", closedAt: server.clock.now() })
      .where(eq(evaluations.id, first.evaluation.id));
  });

  it("answers 404 to a teacher who is not on the classroom's staff", async () => {
    const stranger = await server.signIn("teacher");
    expect((await get(`/app/api/evaluations/${evaluationId}/poll`, stranger.headers)).statusCode).toBe(404);
    expect(
      (
        await post("/app/api/polls", stranger.headers, {
          classroomId: seed.classroomId,
          questionId,
          anonymous: true,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("answers 404 to its own classroom with a question from a pool it cannot reach", async () => {
    // Another teacher's personal pool is private: the classroom passes, the
    // question does not, and the answer is the one a missing question gives.
    const colleague = await server.signIn("teacher");
    const foreign = await post("/app/api/polls/questions", colleague.headers, {
      type: "mcq",
      internalName: "Foreign question",
    });
    expect(foreign.statusCode).toBe(201);
    const denied = await post("/app/api/polls", teacher.headers, {
      classroomId: seed.classroomId,
      questionId: foreign.json().meta.id as string,
      anonymous: true,
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ error: "not_found" });
  });
});

describe("the public page (F-AUTH-05)", () => {
  let firstGuest: string;

  it("is served with no cookie at all, and carries no key", async () => {
    const view = await get(`/app/api/p/${code}`);
    expect(view.statusCode).toBe(200);
    const body = view.json();
    expect(body).toMatchObject({ code, state: "running", solution: null });
    expect(body.me).toMatchObject({ identified: false, loginRequired: false, joined: false });
    expect(body.question.student.choices).toHaveLength(3);
    // Invariant 4: the public view is a student payload like any other.
    const serialized = JSON.stringify(body.question.student);
    for (const forbidden of FORBIDDEN_STUDENT_KEYS) {
      expect(serialized, `public view leaked "${forbidden}"`).not.toContain(`"${forbidden}"`);
    }
  });

  it("is a 404 on an unknown code, exactly like a missing one", async () => {
    expect((await get("/app/api/p/ZZZZZZ")).statusCode).toBe(404);
  });

  it("joins as a guest, sets the cookie and writes exactly one row", async () => {
    const joined = await post(`/app/api/p/${code}/join`);
    expect(joined.statusCode).toBe(200);
    firstGuest = guestCookieOf(joined)!;
    expect(firstGuest).toBeTruthy();
    expect(joined.json().me).toMatchObject({ identified: true, joined: true });

    const again = await post(`/app/api/p/${code}/join`, {
      cookie: `${GUEST_COOKIE}=${firstGuest}`,
    });
    expect(again.statusCode).toBe(200);
    const rows = await server.app.db
      .select()
      .from(guestParticipants)
      .where(eq(guestParticipants.evaluationId, evaluationId));
    expect(rows).toHaveLength(1);
    const opened = await server.app.db
      .select()
      .from(attempts)
      .where(eq(attempts.evaluationId, evaluationId));
    expect(opened).toHaveLength(1);
    expect(opened[0]!.userId).toBeNull();
    expect(opened[0]!.guestId).toBe(rows[0]!.id);
  });

  it("counts an answer, and counts a change of mind only once", async () => {
    const answered = await post(
      `/app/api/p/${code}/answer`,
      { cookie: `${GUEST_COOKIE}=${firstGuest}` },
      { payload: { selected: [1] } },
    );
    expect(answered.statusCode).toBe(200);
    expect(answered.json().me.answer).toEqual({ selected: [1] });

    const changed = await post(
      `/app/api/p/${code}/answer`,
      { cookie: `${GUEST_COOKIE}=${firstGuest}` },
      { payload: { selected: [0] } },
    );
    expect(changed.statusCode).toBe(200);

    const view = await get(`/app/api/evaluations/${evaluationId}/poll`, teacher.headers);
    expect(view.json().tally).toMatchObject({ joined: 1, answered: 1 });
    expect(view.json().tally.choices).toEqual([
      { index: 0, count: 1 },
      { index: 1, count: 0 },
      { index: 2, count: 0 },
    ]);
  });

  it("gives a second browser its own guest, its own attempt and its own vote", async () => {
    const joined = await post(`/app/api/p/${code}/join`);
    const second = guestCookieOf(joined)!;
    expect(second).not.toBe(firstGuest);
    await post(
      `/app/api/p/${code}/answer`,
      { cookie: `${GUEST_COOKIE}=${second}` },
      { payload: { selected: [1] } },
    );
    const view = await get(`/app/api/evaluations/${evaluationId}/poll`, teacher.headers);
    expect(view.json().tally).toMatchObject({ joined: 2, answered: 2 });
    expect(view.json().tally.choices.map((c: { count: number }) => c.count)).toEqual([1, 1, 0]);
  });

  it("refuses an answer from a browser that never joined", async () => {
    const refused = await post(`/app/api/p/${code}/answer`, {}, { payload: { selected: [0] } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("not_joined");
  });

  it("refuses a payload the question type does not accept", async () => {
    const refused = await post(
      `/app/api/p/${code}/answer`,
      { cookie: `${GUEST_COOKIE}=${firstGuest}` },
      { payload: { selected: "Lausanne" } },
    );
    expect(refused.statusCode).toBe(422);
  });

  it("shows the key once the teacher reveals, and not before", async () => {
    expect((await get(`/app/api/p/${code}`)).json().solution).toBeNull();
    const revealed = await post(
      `/app/api/evaluations/${evaluationId}/poll/reveal`,
      teacher.headers,
      { revealed: true },
    );
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().settings.revealed).toBe(true);
    // Every exit builds the same teacher view, names included.
    expect(revealed.json().evaluation.courseName).toBe("Programmation C");
    expect((await get(`/app/api/p/${code}`)).json().solution).toEqual({ correct: [0] });
  });

  it("ends: the poll is closed, the page still answers, the writes do not", async () => {
    const ended = await post(`/app/api/evaluations/${evaluationId}/poll/end`, teacher.headers);
    expect(ended.statusCode).toBe(200);
    // The glossary sends a poll from `running` to the end in one move; the
    // release is deliberately not taken (ADR-014).
    expect(ended.json().evaluation.state).toBe("closed");
    expect(ended.json().evaluation.classroomName).toBe("A");

    const view = await get(`/app/api/p/${code}`);
    expect(view.statusCode).toBe(200);
    expect(view.json().state).toBe("ended");
    const refused = await post(
      `/app/api/p/${code}/answer`,
      { cookie: `${GUEST_COOKIE}=${firstGuest}` },
      { payload: { selected: [2] } },
    );
    expect(refused.statusCode).toBe(410);
  });

  it("runs the same question again, as a new poll with a new code", async () => {
    const again = await post(`/app/api/evaluations/${evaluationId}/poll/again`, teacher.headers);
    expect(again.statusCode).toBe(201);
    expect(again.json().evaluation.id).not.toBe(evaluationId);
    expect(again.json().evaluation.code).not.toBe(code);
    expect(again.json().evaluation).toMatchObject({
      classroomName: "A",
      courseName: "Programmation C",
    });
    expect(again.json().tally).toMatchObject({ joined: 0, answered: 0 });
    expect(again.json().question.id).toBe(questionId);
    await post(`/app/api/evaluations/${again.json().evaluation.id}/poll/end`, teacher.headers);

    // The pick list now knows the question has been used.
    const picks = await get("/app/api/polls/questions", teacher.headers);
    expect(picks.json()[0]).toMatchObject({ id: questionId });
    expect(picks.json()[0].lastUsedAt).not.toBeNull();
    expect(picks.json()[0].useCount).toBeGreaterThanOrEqual(3);
  });
});

describe("a poll that asks who answers", () => {
  let named: string;

  beforeAll(async () => {
    const created = await post("/app/api/polls", teacher.headers, {
      classroomId: seed.classroomId,
      questionId,
      anonymous: false,
    });
    named = created.json().evaluation.code;
  });

  it("sends a browser with no session to the login", async () => {
    const refused = await post(`/app/api/p/${named}/join`);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: "login_required", next: `/p/${named}` });
    expect(guestCookieOf(refused)).toBeNull();
    expect((await get(`/app/api/p/${named}`)).json().me.loginRequired).toBe(true);
  });

  it("lets a signed-in account join although it holds no roster seat", async () => {
    const joined = await post(`/app/api/p/${named}/join`, outsider.headers);
    expect(joined.statusCode).toBe(200);
    expect(joined.json().me).toMatchObject({ identified: true, joined: true, loginRequired: false });
    const rows = await server.app.db
      .select()
      .from(attempts)
      .where(eq(attempts.userId, outsider.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.guestId).toBeNull();
  });

  it("refuses a signed-in browser whose CSRF header does not match its cookie", async () => {
    const refused = await post(`/app/api/p/${named}/join`, {
      cookie: outsider.headers.cookie!,
      "x-csrf-token": "not-the-one",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("csrf");
  });
});

describe("the public view of a short poll never carries the answer", () => {
  it("keeps every matcher out of what a phone reads (invariant 4)", async () => {
    const id = await publishPollQuestion("short", "Mot secret", {
      configVersion: 2,
      prompt: "Quel mot ?",
      matchers: [{ kind: "exact", value: "S3CR3TANSWER" }],
    });
    const created = await post("/app/api/polls", teacher.headers, {
      classroomId: seed.classroomId,
      questionId: id,
      anonymous: true,
    });
    const shortCode = created.json().evaluation.code;
    const view = await get(`/app/api/p/${shortCode}`);
    expect(view.statusCode).toBe(200);
    expect(JSON.stringify(view.json())).not.toContain("S3CR3TANSWER");

    // The same question, answered by two guests who spell it differently.
    for (const text of ["Lausanne", " lausanne "]) {
      const joined = await post(`/app/api/p/${shortCode}/join`);
      const cookie = `${GUEST_COOKIE}=${guestCookieOf(joined)}`;
      await post(`/app/api/p/${shortCode}/answer`, { cookie }, { payload: { text } });
    }
    const teacherView = await get(
      `/app/api/evaluations/${created.json().evaluation.id}/poll`,
      teacher.headers,
    );
    expect(teacherView.json().tally.answers).toEqual([{ text: "Lausanne", count: 2 }]);
    await post(
      `/app/api/evaluations/${created.json().evaluation.id}/poll/end`,
      teacher.headers,
    );
  });
});

/**
 * "Ask a new question" (ADR-014, addendum 2026-09-23): the question is written
 * in the launcher, validated by its type's own schema, run at once, and saved
 * in no pool.
 */
describe("a poll on a question written in the launcher and never saved", () => {
  const SECRET = "S3CR3T-INLINE";
  const inline = (headers: Record<string, string>, body: Record<string, unknown>) =>
    post("/app/api/polls/inline", headers, {
      classroomId: seed.classroomId,
      anonymous: true,
      ...body,
    });
  const unsavedCount = async () =>
    (await server.app.db.select().from(questions).where(isNull(questions.poolId))).length;

  it("starts the poll, titled by its statement, on a question no pool holds", async () => {
    const before = await unsavedCount();
    const created = await inline(teacher.headers, { type: "mcq", config: MCQ_CONFIG });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.evaluation).toMatchObject({
      state: "running",
      title: MCQ_CONFIG.prompt,
      classroomName: "A",
    });
    expect(body.question.type).toBe("mcq");
    expect(body.question.solution).toEqual({ correct: [0] });

    // One question more, and it belongs to no pool: nothing lists it, and
    // the editor's route cannot reach it.
    expect(await unsavedCount()).toBe(before + 1);
    const [row] = await server.app.db
      .select()
      .from(questions)
      .where(eq(questions.id, body.question.id));
    expect(row!.poolId).toBeNull();
    const picks = await get("/app/api/polls/questions", teacher.headers);
    expect((picks.json() as { id: string }[]).map((p) => p.id)).not.toContain(body.question.id);
    expect((await get(`/app/api/questions/${body.question.id}`, teacher.headers)).statusCode).toBe(404);

    // Audited like the other path, and says which path it was.
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "poll.create"), eq(auditLog.subjectId, body.evaluation.id)));
    expect(entry!.payload).toMatchObject({
      questionId: body.question.id,
      inline: true,
      type: "mcq",
      code: body.evaluation.code,
    });

    // "Run again" works on it like on any other poll.
    const again = await post(`/app/api/evaluations/${body.evaluation.id}/poll/again`, teacher.headers);
    expect(again.statusCode).toBe(201);
    expect(again.json().question.id).toBe(body.question.id);
    for (const id of [body.evaluation.id, again.json().evaluation.id]) {
      await post(`/app/api/evaluations/${id}/poll/end`, teacher.headers);
    }
  });

  it("reaches a phone only through toStudent: no key, no matcher (invariant 4)", async () => {
    const created = await inline(teacher.headers, {
      type: "short",
      config: {
        configVersion: 2,
        prompt: "Le mot de passe ?",
        matchers: [{ kind: "exact", value: SECRET }],
      },
    });
    expect(created.statusCode).toBe(201);
    const shortCode = created.json().evaluation.code as string;

    const view = await get(`/app/api/p/${shortCode}`);
    expect(view.statusCode).toBe(200);
    expect(JSON.stringify(view.json())).not.toContain(SECRET);
    const serialized = JSON.stringify(view.json().question.student);
    for (const forbidden of FORBIDDEN_STUDENT_KEYS) {
      expect(serialized, `public view leaked "${forbidden}"`).not.toContain(`"${forbidden}"`);
    }
    expect(view.json().question.student).toMatchObject({ prompt: "Le mot de passe ?" });
    expect(view.json().solution).toBeNull();

    // Same for the mcq key: not a `correct` flag anywhere before the reveal.
    const mcq = await inline(teacher.headers, { type: "mcq", config: MCQ_CONFIG });
    const mcqView = await get(`/app/api/p/${mcq.json().evaluation.code}`);
    expect(JSON.stringify(mcqView.json())).not.toContain('"correct"');
    for (const id of [created.json().evaluation.id, mcq.json().evaluation.id]) {
      await post(`/app/api/evaluations/${id}/poll/end`, teacher.headers);
    }
  });

  it("refuses content its type's schema refuses, and writes nothing", async () => {
    const before = await unsavedCount();
    // The key is optional here; the rest of the schema is not.
    const oneChoice = await inline(teacher.headers, {
      type: "mcq",
      config: { ...MCQ_CONFIG, choices: [{ text: "A" }] },
    });
    expect(oneChoice.statusCode).toBe(422);
    expect(oneChoice.json().error).toBe("config_invalid");
    expect(oneChoice.json().details.length).toBeGreaterThan(0);

    const twoKeysSingle = await inline(teacher.headers, {
      type: "mcq",
      config: {
        ...MCQ_CONFIG,
        choices: [
          { text: "A", correct: true },
          { text: "B", correct: true },
        ],
      },
    });
    expect(twoKeysSingle.statusCode).toBe(422);

    const blankMatcher = await inline(teacher.headers, {
      type: "short",
      config: { configVersion: 2, prompt: "?", matchers: [{ kind: "exact", value: "" }] },
    });
    expect(blankMatcher.statusCode).toBe(422);

    const empty = await inline(teacher.headers, { type: "short", config: { prompt: "" } });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toBe("config_invalid");

    const code = await inline(teacher.headers, { type: "code", config: {} });
    expect(code.statusCode).toBe(422);
    expect(code.json().error).toBe("poll_type");

    const malformed = await inline(teacher.headers, { type: "mcq", config: MCQ_CONFIG, classroomId: "x" });
    expect(malformed.statusCode).toBe(400);
    expect(await unsavedCount()).toBe(before);
  });

  it("is a teacher's act, in a classroom they teach", async () => {
    const before = await unsavedCount();
    expect((await inline({}, { type: "mcq", config: MCQ_CONFIG })).statusCode).toBe(401);
    expect((await inline(outsider.headers, { type: "mcq", config: MCQ_CONFIG })).statusCode).toBe(403);
    const stranger = await server.signIn("teacher");
    const offStaff = await inline(stranger.headers, { type: "mcq", config: MCQ_CONFIG });
    expect(offStaff.statusCode).toBe(404);
    expect(offStaff.json()).toEqual({ error: "not_found" });
    expect(await unsavedCount()).toBe(before);
  });
});

/**
 * An opinion poll (ADR-014, addendum 2026-09-23): a question written in the
 * launcher may mark nothing correct. It runs, counts and reveals like any
 * other poll; the reveal simply names no answer, and nothing grades it.
 */
describe("an opinion poll, whose question has no key", () => {
  const OPINION_MCQ = {
    configVersion: 2,
    prompt: "Le rythme des laboratoires vous convient-il ?",
    choices: [
      { text: "Trop lent", correct: false },
      { text: "Juste bien", correct: false },
      { text: "Trop rapide", correct: false },
    ],
    mode: "single",
  };
  const inline = (body: Record<string, unknown>) =>
    post("/app/api/polls/inline", teacher.headers, {
      classroomId: seed.classroomId,
      anonymous: true,
      ...body,
    });
  const gradingsOf = async (id: string) =>
    server.app.db
      .select({ id: gradings.id })
      .from(gradings)
      .innerJoin(attempts, eq(attempts.id, gradings.attemptId))
      .where(eq(attempts.evaluationId, id));

  it("launches an mcq with no choice marked correct, and a short answer with no accepted answer", async () => {
    const mcq = await inline({ type: "mcq", config: OPINION_MCQ });
    expect(mcq.statusCode).toBe(201);
    expect(mcq.json().question.solution).toEqual({ correct: [] });

    const short = await inline({
      type: "short",
      config: { configVersion: 2, prompt: "Un mot pour ce cours ?", matchers: [] },
    });
    expect(short.statusCode).toBe(201);
    expect(short.json().question.solution).toEqual({ expected: [] });
    // Without matchers at all, too: the key is optional, not merely empty.
    const bare = await inline({ type: "short", config: { configVersion: 2, prompt: "Et vous ?" } });
    expect(bare.statusCode).toBe(201);

    for (const id of [mcq, short, bare].map((r) => r.json().evaluation.id as string)) {
      await post(`/app/api/evaluations/${id}/poll/end`, teacher.headers);
    }
  });

  it("runs whole: answers, tally, reveal of the distribution, end without grades, run again", async () => {
    const created = await inline({ type: "mcq", config: OPINION_MCQ });
    const id = created.json().evaluation.id as string;
    const pollCode = created.json().evaluation.code as string;

    // Three phones.
    const votes = [[1], [1], [2]];
    for (const selected of votes) {
      const joined = await post(`/app/api/p/${pollCode}/join`);
      const cookie = `${GUEST_COOKIE}=${guestCookieOf(joined)!}`;
      const answered = await post(`/app/api/p/${pollCode}/answer`, { cookie }, { payload: { selected } });
      expect(answered.statusCode).toBe(200);
    }
    const before = await get(`/app/api/p/${pollCode}`);
    expect(before.json()).toMatchObject({ solution: null, tally: null });

    const view = await get(`/app/api/evaluations/${id}/poll`, teacher.headers);
    expect(view.json().tally).toMatchObject({ joined: 3, answered: 3 });
    expect(view.json().tally.choices.map((c: { count: number }) => c.count)).toEqual([0, 2, 1]);

    // The reveal names no answer and hands the phones the distribution.
    const revealed = await post(`/app/api/evaluations/${id}/poll/reveal`, teacher.headers, { revealed: true });
    expect(revealed.statusCode).toBe(200);
    const phone = (await get(`/app/api/p/${pollCode}`)).json();
    expect(phone.solution).toEqual({ correct: [] });
    expect(phone.tally.choices.map((c: { count: number }) => c.count)).toEqual([0, 2, 1]);
    // Still only `toStudent` on the question (invariant 4).
    const serialized = JSON.stringify(phone.question.student);
    for (const forbidden of FORBIDDEN_STUDENT_KEYS) {
      expect(serialized, `public view leaked "${forbidden}"`).not.toContain(`"${forbidden}"`);
    }

    // The end runs the grading pass, which writes nothing: no zero for the
    // whole room on a question nobody could get wrong.
    const ended = await post(`/app/api/evaluations/${id}/poll/end`, teacher.headers);
    expect(ended.statusCode).toBe(200);
    expect(ended.json().evaluation.state).toBe("closed");
    expect(await gradingsOf(id)).toHaveLength(0);

    const again = await post(`/app/api/evaluations/${id}/poll/again`, teacher.headers);
    expect(again.statusCode).toBe(201);
    expect(again.json().question.solution).toEqual({ correct: [] });
    expect(again.json().tally).toMatchObject({ joined: 0, answered: 0 });
    await post(`/app/api/evaluations/${again.json().evaluation.id}/poll/end`, teacher.headers);
  });

  it("still grades a poll that HAS a key", async () => {
    const created = await inline({ type: "mcq", config: MCQ_CONFIG });
    const id = created.json().evaluation.id as string;
    const pollCode = created.json().evaluation.code as string;
    const joined = await post(`/app/api/p/${pollCode}/join`);
    const cookie = `${GUEST_COOKIE}=${guestCookieOf(joined)!}`;
    await post(`/app/api/p/${pollCode}/answer`, { cookie }, { payload: { selected: [0] } });
    await post(`/app/api/evaluations/${id}/poll/end`, teacher.headers);
    expect(await gradingsOf(id)).toHaveLength(1);
  });

  it("keeps a pool question to its key: publishing one without a key is refused", async () => {
    const created = await post("/app/api/polls/questions", teacher.headers, {
      type: "mcq",
      internalName: "Sans clé",
    });
    const qid = created.json().meta.id as string;
    const [question] = await server.app.db.select().from(questions).where(eq(questions.id, qid));
    // The draft is stored (D16), and the editor is told why it cannot go out.
    const saved = await poolService.putDraft(server.app.db, question!, { config: OPINION_MCQ });
    expect(saved.valid).toBe(false);
    expect(saved.issues.map((i) => i.message)).toContain("mcq.no_correct_choice");
    await expect(
      poolService.publishQuestion(server.app.db, question!, { userId: teacher.id }),
    ).rejects.toBeInstanceOf(poolService.DraftInvalid);
    const detail = await get(`/app/api/questions/${qid}`, teacher.headers);
    expect(detail.json().draft.valid).toBe(false);

    const shortCreated = await post("/app/api/polls/questions", teacher.headers, {
      type: "short",
      internalName: "Sans réponse",
    });
    const sid = shortCreated.json().meta.id as string;
    const [shortQuestion] = await server.app.db.select().from(questions).where(eq(questions.id, sid));
    await poolService.putDraft(server.app.db, shortQuestion!, {
      config: { configVersion: 2, prompt: "Un mot ?", matchers: [] },
    });
    await expect(
      poolService.publishQuestion(server.app.db, shortQuestion!, { userId: teacher.id }),
    ).rejects.toBeInstanceOf(poolService.DraftInvalid);
  });
});

describe("keeping the question of a poll (ADR-014, addenda item 6)", () => {
  const OPINION = {
    configVersion: 2,
    prompt: "Quel créneau pour la séance de questions ?",
    choices: [
      { text: "Lundi", correct: false },
      { text: "Jeudi", correct: false },
    ],
    mode: "single",
  };
  let colleague: { id: string; headers: Record<string, string> };
  let pollId: string;
  let keptId: string;
  let personalId: string;

  const personalOf = (userId: string) =>
    server.app.db
      .select()
      .from(pools)
      .where(and(eq(pools.ownerId, userId), eq(pools.isPersonal, true)));

  beforeAll(async () => {
    // A colleague on the course's staff who never polled: no personal pool.
    colleague = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: seed.courseId, userId: colleague.id });
    const created = await post("/app/api/polls/inline", colleague.headers, {
      classroomId: seed.classroomId,
      anonymous: true,
      type: "mcq",
      config: OPINION,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().question).toMatchObject({ saved: false, pool: null });
    pollId = created.json().evaluation.id as string;
    keptId = created.json().question.id as string;
  });

  it("refuses outsiders: no session 401, a student 403, a teacher off the staff 404", async () => {
    const url = `/app/api/evaluations/${pollId}/poll/keep`;
    expect((await post(url)).statusCode).toBe(401);
    expect((await post(url, outsider.headers)).statusCode).toBe(403);
    const stranger = await server.signIn("teacher");
    const denied = await post(url, stranger.headers);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ error: "not_found" });
    expect(await personalOf(stranger.id)).toHaveLength(0);
    const [row] = await server.app.db.select().from(questions).where(eq(questions.id, keptId));
    expect(row!.poolId).toBeNull();
  });

  it("creates the personal pool on first use and attaches the question, without a copy", async () => {
    expect(await personalOf(colleague.id)).toHaveLength(0);
    const before = (await server.app.db.select().from(questions)).length;
    const kept = await post(`/app/api/evaluations/${pollId}/poll/keep`, colleague.headers);
    expect(kept.statusCode).toBe(200);

    const personal = await personalOf(colleague.id);
    expect(personal).toHaveLength(1);
    personalId = personal[0]!.id;
    expect(kept.json().question).toMatchObject({
      id: keptId,
      saved: true,
      pool: { id: personalId, name: poolService.PERSONAL_POOL_NAME },
    });
    expect((await server.app.db.select().from(questions)).length).toBe(before);
    const [row] = await server.app.db.select().from(questions).where(eq(questions.id, keptId));
    expect(row).toMatchObject({ poolId: personalId, internalName: OPINION.prompt });
    // The poll still runs the version it froze; the question gained a draft.
    const versions = await server.app.db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionId, keptId));
    expect(versions.map((v) => v.number).sort()).toEqual([1, null]);

    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "poll.keep"), eq(auditLog.subjectId, keptId)));
    expect(entry!.payload).toMatchObject({ evaluationId: pollId, poolId: personalId });
  });

  it("is idempotent: a second keep changes nothing and audits nothing", async () => {
    const again = await post(`/app/api/evaluations/${pollId}/poll/keep`, colleague.headers);
    expect(again.statusCode).toBe(200);
    expect(again.json().question).toMatchObject({ saved: true, pool: { id: personalId } });
    expect(await personalOf(colleague.id)).toHaveLength(1);
    const entries = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "poll.keep"), eq(auditLog.subjectId, keptId)));
    expect(entries).toHaveLength(1);
    // The owner of the classroom sees it saved, and not in which pool: that
    // private pool is the colleague's.
    const theirs = await get(`/app/api/evaluations/${pollId}/poll`, teacher.headers);
    expect(theirs.json().question).toMatchObject({ saved: true, pool: null });
  });

  it("lists the kept question in the Polls pool, the launcher and the editor", async () => {
    const list = await get(`/app/api/pools/${personalId}/questions`, colleague.headers);
    expect(list.statusCode).toBe(200);
    const row = (list.json().items as { id: string }[]).find((r) => r.id === keptId);
    expect(row).toMatchObject({ latestNumber: 1, hasDraftChanges: false, keyless: true });

    const picks = await get("/app/api/polls/questions", colleague.headers);
    expect((picks.json() as { id: string }[]).map((p) => p.id)).toContain(keptId);

    // The editor opens it; its draft is the keyless config, which the strict
    // publication gate reports as incomplete — viewing asks for nothing.
    const detail = await get(`/app/api/questions/${keptId}`, colleague.headers);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ keyless: true, draft: { valid: false } });
    expect(detail.json().latestPublished.number).toBe(1);
  });

  it("runs a poll again from the pick list", async () => {
    const again = await post("/app/api/polls", colleague.headers, {
      classroomId: seed.classroomId,
      questionId: keptId,
      anonymous: true,
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().question).toMatchObject({ id: keptId, saved: true, solution: { correct: [] } });
    await post(`/app/api/evaluations/${again.json().evaluation.id}/poll/end`, colleague.headers);
  });

  it("names a second question with the same statement apart", async () => {
    const created = await post("/app/api/polls/inline", colleague.headers, {
      classroomId: seed.classroomId,
      anonymous: true,
      type: "mcq",
      config: OPINION,
    });
    const id = created.json().evaluation.id as string;
    const kept = await post(`/app/api/evaluations/${id}/poll/keep`, colleague.headers);
    expect(kept.statusCode).toBe(200);
    const [row] = await server.app.db
      .select()
      .from(questions)
      .where(eq(questions.id, kept.json().question.id as string));
    expect(row).toMatchObject({ poolId: personalId, internalName: `${OPINION.prompt} (2)` });
    await post(`/app/api/evaluations/${id}/poll/end`, colleague.headers);
  });

  it("refuses a keyless kept question in an evaluation, and accepts a keyed one", async () => {
    // A keyed poll, kept too.
    const keyed = await post("/app/api/polls/inline", colleague.headers, {
      classroomId: seed.classroomId,
      anonymous: true,
      type: "mcq",
      config: MCQ_CONFIG,
    });
    const keyedPoll = keyed.json().evaluation.id as string;
    const keyedId = keyed.json().question.id as string;
    expect((await post(`/app/api/evaluations/${keyedPoll}/poll/keep`, colleague.headers)).statusCode).toBe(200);
    await post(`/app/api/evaluations/${keyedPoll}/poll/end`, colleague.headers);

    // The course draws from the Polls pool, so only the key can refuse.
    await server.app.db.insert(coursePools).values({ courseId: seed.courseId, poolId: personalId });
    const evaluation = await post(`/app/api/classrooms/${seed.classroomId}/evaluations`, colleague.headers, {
      title: "Test with kept questions",
    });
    expect(evaluation.statusCode).toBe(201);
    const evaluationId = evaluation.json().id as string;

    const refused = await post(`/app/api/evaluations/${evaluationId}/items`, colleague.headers, {
      questionIds: [keptId],
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("question_keyless");

    const accepted = await post(`/app/api/evaluations/${evaluationId}/items`, colleague.headers, {
      questionIds: [keyedId],
    });
    expect(accepted.statusCode).toBe(200);
    const list = await get(`/app/api/pools/${personalId}/questions`, colleague.headers);
    const flags = new Map(
      (list.json().items as { id: string; keyless: boolean }[]).map((r) => [r.id, r.keyless]),
    );
    expect(flags.get(keyedId)).toBe(false);
  });

  afterAll(async () => {
    await post(`/app/api/evaluations/${pollId}/poll/end`, colleague.headers);
  });
});

/**
 * The order of the refusals on the teacher side, which `teacherRoute` in
 * `modules/http.ts` must keep (audit B-02): session and role → params (404)
 * → the poll, loaded through the staff predicate (404) → body (400).
 */
describe("the order of the refusals on the teacher side", () => {
  it("refuses session, params, scope, then body", async () => {
    const running = await post("/app/api/polls", teacher.headers, {
      classroomId: seed.classroomId,
      questionId,
      anonymous: true,
    });
    expect(running.statusCode).toBe(201);
    const id = running.json().evaluation.id as string;
    const url = `/app/api/evaluations/${id}/poll/reveal`;
    const badBody = { revealed: "yes" };

    expect((await post("/app/api/evaluations/x/poll/reveal", {}, badBody)).statusCode).toBe(401);
    expect((await post("/app/api/evaluations/x/poll/reveal", outsider.headers, badBody)).statusCode).toBe(403);
    const badParams = await post("/app/api/evaluations/x/poll/reveal", teacher.headers, badBody);
    expect(badParams.statusCode).toBe(404);
    expect(badParams.json()).toEqual({ error: "not_found" });

    // Off the staff, the scope's 404 wins over the malformed body (invariant 6).
    const stranger = await server.signIn("teacher");
    const offStaff = await post(url, stranger.headers, badBody);
    expect(offStaff.statusCode).toBe(404);
    expect(offStaff.json()).toEqual({ error: "not_found" });

    const malformed = await post(url, teacher.headers, badBody);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe("validation");

    await post(`/app/api/evaluations/${id}/poll/end`, teacher.headers);
  });
});
