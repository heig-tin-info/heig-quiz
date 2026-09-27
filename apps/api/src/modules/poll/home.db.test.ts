/**
 * A running classroom poll on the student home (issue #163, ADR-014 addendum
 * 2026-09-27, item 9).
 *
 * Before this issue the home listed a poll like any other evaluation: its
 * card sat under "Open now" with a Start button that posted to
 * `/evaluations/:id/attempt`, which refuses a poll with `501`. The home now
 * carries a running classroom poll in its own list, with the code the button
 * opens `/p/:code` with, and nothing else about it: no title (a poll's title
 * is its question's internal name, or its statement), no settings, no item.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { StudentHome } from "@quiz/contracts";

import { evaluations, questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import * as poolService from "../pool/service.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
/** A student with a CLAIMED seat on the classroom's roster. */
let rostered: { id: string; headers: Record<string, string> };
/** A signed-in student of no classroom of this course. */
let outsider: { id: string; headers: Record<string, string> };
let seed: Awaited<ReturnType<typeof seedLive>>;

const SECRET_NAME = "INTERNAL-NAME-9f3";
const SECRET_STATEMENT = "STATEMENT-OF-THE-POLL-7c1";

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  rostered = await server.signIn("student");
  outsider = await server.signIn("student");
  seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    questions: 0,
    studentIds: [rostered.id],
  });
});
afterAll(async () => {
  await server.close();
});

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  server.app.inject({
    method: "POST",
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });

async function homeOf(user: { headers: Record<string, string> }): Promise<StudentHome> {
  const response = await get("/app/api/student/home", user.headers);
  expect(response.statusCode).toBe(200);
  // The route's answer is the contract's shape, whole.
  return StudentHome.parse(response.json());
}

const MCQ_CONFIG = {
  configVersion: 2,
  prompt: SECRET_STATEMENT,
  choices: [
    { text: "Oui", correct: true },
    { text: "Non", correct: false },
  ],
  mode: "single",
};

async function publishPollQuestion(): Promise<string> {
  const created = await post("/app/api/polls/questions", teacher.headers, {
    type: "mcq",
    internalName: SECRET_NAME,
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().meta.id as string;
  const [question] = await server.app.db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(server.app.db, question!, { config: MCQ_CONFIG });
  await poolService.publishQuestion(server.app.db, question!, { userId: teacher.id });
  return id;
}

/** Every evaluation card of a home, whichever list it sits in. */
const cardsOf = (home: StudentHome) => [...home.open, ...home.upcoming, ...home.past];

describe("a running classroom poll on the student home (#163)", () => {
  let questionId: string;
  let pollId: string;
  let code: string;

  beforeAll(async () => {
    questionId = await publishPollQuestion();
    const created = await post("/app/api/polls", teacher.headers, {
      audience: { kind: "classroom", classroomId: seed.classroomId },
      questionId,
    });
    expect(created.statusCode).toBe(201);
    pollId = created.json().evaluation.id;
    code = created.json().evaluation.code;
  });

  it("is never an evaluation card, whose Start button the attempt route refuses with 501", async () => {
    // What the button of an evaluation card posts to: a poll is answered at
    // /p/:code, never through an attempt of the player.
    const entered = await post(`/app/api/evaluations/${pollId}/attempt`, rostered.headers);
    expect(entered.statusCode).toBe(501);

    const home = await homeOf(rostered);
    expect(cardsOf(home).map((card) => card.id)).not.toContain(pollId);
  });

  it("is listed for a student of the roster, with the code the Answer button opens", async () => {
    const home = await homeOf(rostered);
    expect(home.polls).toEqual([
      {
        id: pollId,
        code,
        classroomId: seed.classroomId,
        classroomName: "A",
        courseCode: expect.stringMatching(/^PRG-/),
      },
    ]);
    // The code opens the page the card sends to.
    expect((await get(`/app/api/p/${code}`, rostered.headers)).statusCode).toBe(200);
  });

  it("carries nothing of the question (invariant 4)", async () => {
    const serialized = JSON.stringify(await homeOf(rostered));
    expect(serialized).not.toContain(SECRET_NAME);
    expect(serialized).not.toContain(SECRET_STATEMENT);
    expect(serialized).not.toContain("Oui");
  });

  it("is on no home of an account off the roster", async () => {
    const home = await homeOf(outsider);
    expect(home.polls).toEqual([]);
    expect(cardsOf(home)).toEqual([]);
  });

  it("never shows an anonymous poll, on any home", async () => {
    const anonymous = await post("/app/api/polls", teacher.headers, {
      audience: { kind: "anonymous" },
      questionId,
    });
    expect(anonymous.statusCode).toBe(201);
    const anonymousId = anonymous.json().evaluation.id as string;
    for (const user of [rostered, outsider]) {
      const home = await homeOf(user);
      expect(home.polls.map((p) => p.id)).not.toContain(anonymousId);
      expect(cardsOf(home).map((c) => c.id)).not.toContain(anonymousId);
    }
  });

  it("disappears once it ends, answered or not: nothing is released (ADR-014 §8)", async () => {
    expect((await post(`/app/api/p/${code}/join`, rostered.headers)).statusCode).toBe(200);
    const answered = await post(`/app/api/p/${code}/answer`, rostered.headers, {
      payload: { selected: [0] },
    });
    expect(answered.statusCode).toBe(200);

    const ended = await post(`/app/api/evaluations/${pollId}/poll/end`, teacher.headers);
    expect(ended.statusCode).toBe(200);

    const home = await homeOf(rostered);
    expect(home.polls.map((p) => p.id)).not.toContain(pollId);
    // No card under "Past" either: its View button would open a feedback
    // page for something that is never released.
    expect(cardsOf(home).map((c) => c.id)).not.toContain(pollId);
  });

  it("leaves the ordinary evaluations of the classroom where they were", async () => {
    await server.app.db
      .update(evaluations)
      .set({ state: "scheduled" })
      .where(eq(evaluations.id, seed.evaluationId));
    const home = await homeOf(rostered);
    expect(home.upcoming.map((c) => c.id)).toEqual([seed.evaluationId]);
  });
});
