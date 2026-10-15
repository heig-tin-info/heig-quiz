/**
 * The retention of a poll's anonymous participants (#873, ADR-014 amendment
 * 2026-10-15): 30 days after the poll closed, by the server's clock, its
 * guests go with their attempts, answers and gradings — the accounts' stay —
 * and every result the teacher reads is what it was before, read from the
 * frozen copy written first. A brainstorm's moderation is read-only from then
 * on. The pass is called with explicit instants, never a sleep (invariant 5).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { answers, attempts, gradings, guestParticipants, pollFrozenResults } from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { GUEST_COOKIE, POLL_GUEST_RETENTION_MS, purgePollGuests } from "./service.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };

const T0 = new Date("2026-09-01T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const get = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string> = {}, payload?: Payload) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

beforeAll(async () => {
  server = await testServer();
  server.clock.set(T0);
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  await seedLive(server.app.db, { teacherId: teacher.id, questions: 0, studentIds: [student.id] });
});
afterAll(async () => {
  await server.close();
});

interface Poll {
  id: string;
  code: string;
}

async function launch(type: "mcq" | "brainstorm", config: unknown): Promise<Poll> {
  const created = await post("/app/api/polls/inline", teacher.headers, { audience: { kind: "anonymous" }, type, config });
  expect(created.statusCode).toBe(201);
  return { id: created.json().evaluation.id, code: created.json().evaluation.code };
}

/** One participant answers: a guest (a fresh browser), or the signed-in student. */
async function answer(poll: Poll, payload: unknown, account?: Record<string, string>): Promise<void> {
  const joined = await post(`/app/api/p/${poll.code}/join`, account ?? {});
  expect(joined.statusCode).toBe(200);
  const who = account ?? { cookie: `${GUEST_COOKIE}=${/quiz_guest=([^;]+)/.exec(String(joined.headers["set-cookie"]))![1]!}` };
  const answered = await post(`/app/api/p/${poll.code}/answer`, who, { payload } as Payload);
  expect(answered.statusCode).toBe(200);
}

const end = async (poll: Poll) => expect((await post(`/app/api/evaluations/${poll.id}/poll/end`, teacher.headers)).statusCode).toBe(200);

/** Everything the teacher reads of a poll's results, and what a phone read of it. */
async function resultsOf(poll: Poll, brainstorm: boolean) {
  const view = (await get(`/app/api/evaluations/${poll.id}/poll`, teacher.headers)).json();
  const listed = (await get("/app/api/polls", teacher.headers)).json().find((p: { id: string }) => p.id === poll.id);
  const picks = (await get("/app/api/polls/questions", teacher.headers)).json();
  const pick = picks.find((p: { id: string }) => p.id === view.question.id);
  return {
    tally: view.tally,
    answered: listed.answered,
    outcome: pick.outcome,
    board: brainstorm ? (await get(`/app/api/evaluations/${poll.id}/poll/ideas`, teacher.headers)).json() : null,
  };
}

const guestsOf = (id: string) =>
  server.app.db.select().from(guestParticipants).where(eq(guestParticipants.evaluationId, id));
const attemptsOf = (id: string) => server.app.db.select().from(attempts).where(eq(attempts.evaluationId, id));

describe("the guests of a poll closed 30 days ago", () => {
  let brainstorm: Poll;
  let mcq: Poll;
  let recent: Poll;
  let running: Poll;
  let before: Record<string, Awaited<ReturnType<typeof resultsOf>>>;
  let phoneBefore: unknown;
  const closedAt = T0.getTime() + 60_000;

  beforeAll(async () => {
    // A brainstorm answered by three guests and the signed-in student, moderated.
    brainstorm = await launch("brainstorm", { configVersion: 1, prompt: "Un être vivant ?", maxIdeas: 3 });
    await answer(brainstorm, { ideas: ["Il respire", "grandit"] });
    await answer(brainstorm, { ideas: ["la respiration"] });
    await answer(brainstorm, { ideas: ["gros mot"] });
    await answer(brainstorm, { ideas: ["se reproduit"] }, student.headers);
    const act = (body: unknown) => post(`/app/api/evaluations/${brainstorm.id}/poll/ideas`, teacher.headers, body as Payload);
    expect((await act({ action: "merge", keys: ["respiration"], into: "il respire" })).statusCode).toBe(200);
    expect((await act({ action: "approve", keys: ["il respire", "respiration", "grandit"] })).statusCode).toBe(200);
    expect((await act({ action: "hide", keys: ["gros mot"] })).statusCode).toBe(200);

    // A keyed mcq: two guests right, one wrong, the student right; its votes shown.
    mcq = await launch("mcq", {
      configVersion: 2,
      prompt: "Capitale du canton de Vaud ?",
      choices: [
        { text: "Lausanne", correct: true },
        { text: "Yverdon", correct: false },
      ],
      mode: "single",
    });
    await answer(mcq, { selected: [0] });
    await answer(mcq, { selected: [0] });
    await answer(mcq, { selected: [1] });
    await answer(mcq, { selected: [0] }, student.headers);
    expect((await post(`/app/api/evaluations/${mcq.id}/poll/reveal`, teacher.headers, { votes: true })).statusCode).toBe(200);

    server.clock.set(new Date(closedAt));
    await end(brainstorm);
    await end(mcq);
    phoneBefore = (await get(`/app/api/p/${mcq.code}`)).json().tally;

    // Closed two days later: 29 days old when the others are 31.
    server.clock.set(new Date(closedAt + 2 * DAY));
    recent = await launch("mcq", { configVersion: 2, prompt: "Encore ?", choices: [{ text: "Oui", correct: true }, { text: "Non", correct: false }], mode: "single" });
    await answer(recent, { selected: [1] });
    await end(recent);
    // Never ended.
    running = await launch("mcq", { configVersion: 2, prompt: "Toujours ?", choices: [{ text: "Oui", correct: true }, { text: "Non", correct: false }], mode: "single" });
    await answer(running, { selected: [0] });

    before = { brainstorm: await resultsOf(brainstorm, true), mcq: await resultsOf(mcq, false) };
    // What the test compares is real: answers, a grading pass, moderation.
    expect(before.brainstorm!.tally).toMatchObject({ joined: 4, answered: 4 });
    expect(before.brainstorm!.board).toMatchObject({ answered: 4, pending: 1 });
    expect(before.mcq!.answered).toBe(4);
    expect(before.mcq!.outcome).toMatchObject({ kind: "keyed", correct: { percent: 75 } });
  });

  it("leaves everything as it is the day before the 30 days end", async () => {
    expect(await purgePollGuests(server.app.db, new Date(closedAt + POLL_GUEST_RETENTION_MS - 1))).toBe(0);
    expect(await guestsOf(brainstorm.id)).toHaveLength(3);
    expect(await server.app.db.select().from(pollFrozenResults)).toEqual([]);
  });

  it("deletes the guests, their attempts, answers and gradings; the account's answer stays", async () => {
    const now = new Date(closedAt + 31 * DAY);
    // Three in the brainstorm, three in the mcq: the recent and the running poll keep theirs.
    expect(await purgePollGuests(server.app.db, now)).toBe(6);
    for (const poll of [brainstorm, mcq]) {
      expect(await guestsOf(poll.id)).toEqual([]);
      const left = await attemptsOf(poll.id);
      expect(left.map((a) => a.userId)).toEqual([student.id]);
      const kept = await server.app.db.select().from(answers).where(eq(answers.attemptId, left[0]!.id));
      expect(kept).toHaveLength(1);
    }
    const graded = await server.app.db
      .select({ userId: attempts.userId })
      .from(gradings)
      .innerJoin(attempts, eq(attempts.id, gradings.attemptId))
      .where(eq(attempts.evaluationId, mcq.id));
    expect(graded.map((g) => g.userId)).toEqual([student.id]);

    // 29 days after its close, and still running: untouched.
    expect(await guestsOf(recent.id)).toHaveLength(1);
    expect(await guestsOf(running.id)).toHaveLength(1);
    const frozen = await server.app.db.select().from(pollFrozenResults);
    expect(frozen.map((f) => f.evaluationId).sort()).toEqual([brainstorm.id, mcq.id].sort());
    // The typed texts stay; nothing in the copy points to a person.
    const copy = frozen.find((f) => f.evaluationId === brainstorm.id)!;
    expect(JSON.stringify(copy.payloads)).toContain("gros mot");
    expect(JSON.stringify(copy.payloads)).not.toContain(student.id);
  });

  it("shows the teacher the same results as before: tally, board, history, launcher and phone", async () => {
    expect(await resultsOf(brainstorm, true)).toEqual(before.brainstorm);
    expect(await resultsOf(mcq, false)).toEqual(before.mcq);
    // The phone's tally, while the code still answers (two hours after the end).
    server.clock.set(new Date(closedAt + 60_000));
    expect((await get(`/app/api/p/${mcq.code}`)).json().tally).toEqual(phoneBefore);
    const view = (await get(`/app/api/evaluations/${brainstorm.id}/poll`, teacher.headers)).json();
    expect(view.frozenAt).toBe(new Date(closedAt + 31 * DAY).toISOString());
  });

  it("refuses to moderate a purged brainstorm", async () => {
    const refused = await post(`/app/api/evaluations/${brainstorm.id}/poll/ideas`, teacher.headers, {
      action: "approve",
      keys: ["gros mot"],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("poll_frozen");
    for (const body of [{ moderation: false }, { ai: false }]) {
      const switched = await post(`/app/api/evaluations/${brainstorm.id}/poll/reveal`, teacher.headers, body);
      expect(switched.statusCode).toBe(409);
      expect(switched.json().error).toBe("poll_frozen");
    }
    // The display switches still move: they decide what is shown, not what was answered.
    expect((await post(`/app/api/evaluations/${brainstorm.id}/poll/reveal`, teacher.headers, { votes: true })).statusCode).toBe(200);
    expect((await resultsOf(brainstorm, true)).board).toEqual(before.brainstorm!.board);
  });

  it("is idempotent: a second pass finds nothing, and the copy keeps its date", async () => {
    const [copy] = await server.app.db.select().from(pollFrozenResults).where(eq(pollFrozenResults.evaluationId, mcq.id));
    expect(await purgePollGuests(server.app.db, new Date(closedAt + 40 * DAY))).toBe(1); // the recent poll's turn
    expect(await purgePollGuests(server.app.db, new Date(closedAt + 41 * DAY))).toBe(0);
    const [again] = await server.app.db.select().from(pollFrozenResults).where(eq(pollFrozenResults.evaluationId, mcq.id));
    expect(again).toEqual(copy);
    expect(await guestsOf(running.id)).toHaveLength(1);
  });
});
