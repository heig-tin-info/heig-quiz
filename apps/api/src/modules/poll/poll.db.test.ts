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

import { and, eq } from "drizzle-orm";

import { attempts, guestParticipants, pools, questions } from "../../db/schema.js";
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
      now: new Date(),
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
