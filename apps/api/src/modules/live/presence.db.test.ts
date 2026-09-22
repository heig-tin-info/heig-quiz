/**
 * Two things a teacher reported from a real evaluation, over the REAL
 * application: the SSE stream, the guards, the services.
 *
 * 1. A staff member who holds a ROSTER SEAT and walks their own quiz
 *    (ADR-018) is a body in the room, and both sides must say so: the
 *    dashboard's ring, its "here / not here yet" lists and its "n of m
 *    connected", and the student ring the walker themself is looking at.
 *    Before the `lobby:` subject existed, the server guessed which side of
 *    the room a connection was on from the caller's ROLE, so this teacher
 *    was counted nowhere and read "0 %  ·  0 / 0" in their own waiting room.
 *
 * 2. With the "Results" switch on, a cell is coloured by what the answer is
 *    WORTH, from the first answer and not from the closing (ADR-020).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import { presence } from "../realtime/presence.js";
import * as bus from "../realtime/bus.js";
import * as service from "./service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
const opened: { destroy: () => void }[] = [];

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-09-21T08:00:00.000Z");
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});

afterEach(() => {
  for (const stream of opened.splice(0)) stream.destroy();
  presence.reset();
  bus.resetCoalescers();
});

afterAll(async () => {
  await server.close();
  restore();
});

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });
/** One autosave: `clientTs` travels, and the SERVER's clock is what counts. */
const save = (attemptId: string, itemId: string, payload: unknown, revision = 1) =>
  server.app.inject({
    method: "PUT",
    url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
    headers: student.headers,
    payload: { payload, revision, clientTs: server.clock.now().toISOString() },
  });

/** Opens an SSE connection and keeps it open until the test ends. */
async function openStream(headers: Record<string, string>, watch: string) {
  const res = await server.app.inject({
    method: "GET",
    url: `/app/api/events?watch=${encodeURIComponent(watch)}`,
    headers,
    payloadAsStream: true,
  });
  let text = "";
  if (res.statusCode === 200) {
    res.stream().on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
  }
  const handle = {
    statusCode: res.statusCode,
    get text() {
      return text;
    },
    destroy: () => res.stream().destroy(),
  };
  opened.push(handle);
  return handle;
}

/** Lets the event loop deliver what the handler wrote. */
const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A classroom of one student, an evaluation of `questions` items, in `state`. */
async function world(state: "lobby" | "running", questions = 1) {
  const db = server.app.db;
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions,
  });
  await applyState(db, await reload(db, seed.evaluationId), state, server.clock.now());
  const items = await joinedItems(db, seed.evaluationId);
  return { seed, evaluation: await reload(db, seed.evaluationId), items };
}

describe("a staff member in the roster is a body in the room (F-LIVE-02, F-LIVE-03)", () => {
  it("counts the walking teacher present, in the lobby ring and in the dashboard", async () => {
    const db = server.app.db;
    const { seed, evaluation } = await world("lobby");
    // Exactly the reported setup: staff of the course, AND on the roster.
    expect(
      (await post(`/app/api/classrooms/${seed.classroomId}/self-enroll`, teacher.headers))
        .statusCode,
    ).toBe(201);
    const entered = await post(`/app/api/evaluations/${evaluation.id}/attempt`, teacher.headers);
    expect(entered.statusCode).toBe(200);
    expect(entered.json().kind).toBe("lobby");

    // The dashboard the teacher keeps in their other tab is NOT a presence:
    // watching the grid is not sitting in the room.
    const dashboardTab = await openStream(teacher.headers, `evaluation:${evaluation.id}`);
    await settle();
    expect(dashboardTab.statusCode).toBe(200);
    expect(presence.count(evaluation.id)).toBe(0);

    // The student view is. This is the connection that used to count for
    // nothing, because the server read the caller's role and saw "teacher".
    const studentTab = await openStream(teacher.headers, `lobby:${evaluation.id}`);
    await settle();
    expect(studentTab.statusCode).toBe(200);
    expect(presence.count(evaluation.id)).toBe(1);

    // The student ring: the numerator AND the denominator (it used to be
    // "0 / 0", the seat being a staff one).
    const lobby = await service.lobbyView(
      db,
      evaluation,
      (await service.participantOf(db, evaluation, teacher.id))!,
      server.clock.now(),
    );
    expect(lobby.present).toBe(1);
    expect(lobby.enrolled).toBe(2);

    // The teacher's own grid: the ring, the "here" list and "n of m".
    const view = (await get(`/app/api/evaluations/${evaluation.id}/dashboard`, teacher.headers))
      .json();
    const mine = view.rows.find((r: { userId: string }) => r.userId === teacher.id);
    expect(mine.staff).toBe(true);
    expect(mine.online).toBe(true);
    expect(view.rows.filter((r: { online: boolean }) => r.online)).toHaveLength(1);

    // And the class statistics stay the class's (ADR-018, decision 4).
    expect(view.rows.filter((r: { staff: boolean }) => !r.staff)).toHaveLength(1);
    expect(view.totals[0].completion).toBe(0);
  });

  it("counts a plain student exactly the same way", async () => {
    const { evaluation } = await world("lobby");
    const stream = await openStream(student.headers, `lobby:${evaluation.id}`);
    await settle();
    expect(stream.statusCode).toBe(200);
    expect(presence.count(evaluation.id)).toBe(1);
    // Letting go when the socket closes is `PresenceMap.leave`, and it is
    // unit-tested in `modules/realtime/realtime.test.ts`: `inject` holds the
    // response stream open, so a close cannot be observed from here.
  });

  it("refuses a `lobby:` subject to somebody who cannot reach the evaluation", async () => {
    const stranger = await server.signIn("student");
    const { evaluation } = await world("lobby");
    expect((await openStream(stranger.headers, `lobby:${evaluation.id}`)).statusCode).toBe(404);
  });

  it("does not count a teacher who holds NO seat, whatever they watch", async () => {
    const other = await server.signIn("teacher");
    const { seed, evaluation } = await world("lobby");
    // An admin reaches every evaluation; a seat is still what puts them in
    // the room, and `enrolledCount` never counted a seat that took nothing.
    const admin = await server.signIn("admin");
    expect((await openStream(admin.headers, `lobby:${evaluation.id}`)).statusCode).toBe(200);
    await settle();
    expect(presence.count(evaluation.id)).toBe(0);
    // And a stranger to the course gets the 404 of a missing entity.
    expect((await openStream(other.headers, `lobby:${evaluation.id}`)).statusCode).toBe(404);
    expect(seed.classroomId).toBeTruthy();
  });

  it("counts the teacher who is answering: their OWN attempt is a presence", async () => {
    const db = server.app.db;
    const { seed, evaluation } = await world("running");
    await post(`/app/api/classrooms/${seed.classroomId}/self-enroll`, teacher.headers);
    const entered = await post(`/app/api/evaluations/${evaluation.id}/attempt`, teacher.headers);
    const attemptId = entered.json().view.attempt.id;
    const stream = await openStream(teacher.headers, `attempt:${attemptId}`);
    await settle();
    expect(stream.statusCode).toBe(200);
    expect(presence.count(evaluation.id)).toBe(1);
    expect(await service.enrolledCount(db, evaluation)).toBe(2);
  });
});

describe("the Results switch colours a cell from the answer (ADR-020)", () => {
  it("returns a live verdict per cell, only when the results were asked for", async () => {
    const db = server.app.db;
    const { seed, evaluation, items } = await world("running", 2);
    const entered = await post(`/app/api/evaluations/${evaluation.id}/attempt`, student.headers);
    const attemptId = entered.json().view.attempt.id;
    const right = items[0]!;
    const wrong = items[1]!;
    // `fakeShort` matches on the exact string; the seed answers are known.
    const key = (name: string) => `answer-${name}`;
    expect((await save(attemptId, right.item.id, key("q0"))).statusCode).toBe(200);
    expect((await save(attemptId, wrong.item.id, "nope")).statusCode).toBe(200);

    // Results off: nothing is graded and nothing is coloured — the payload is
    // exactly what it was before this change.
    const plain = (
      await get(`/app/api/evaluations/${evaluation.id}/dashboard`, teacher.headers)
    ).json();
    const plainCells = plain.rows.find((r: { userId: string }) => r.userId === student.id).cells;
    expect(plainCells.every((c: { verdict: null }) => c.verdict === null)).toBe(true);
    expect(plain.totals.every((t: { successRate: null }) => t.successRate === null)).toBe(true);

    // Results on: green and red, while the evaluation is still running.
    const withResults = (
      await get(`/app/api/evaluations/${evaluation.id}/dashboard?results=1`, teacher.headers)
    ).json();
    const cells = withResults.rows.find((r: { userId: string }) => r.userId === student.id).cells;
    const cellOf = (itemId: string) =>
      cells.find((c: { itemId: string }) => c.itemId === itemId);
    expect(cellOf(right.item.id).verdict).toBe("correct");
    expect(cellOf(right.item.id).provisional).toBe(true);
    expect(cellOf(wrong.item.id).verdict).toBe("wrong");
    // A preview is not a score: `points` stays what a validated grading fills.
    expect(cellOf(right.item.id).points).toBe(null);

    // The class row reads the live rate, flagged as live.
    const total = (itemId: string) =>
      withResults.totals.find((t: { itemId: string }) => t.itemId === itemId);
    expect(total(right.item.id)).toMatchObject({ successRate: 1, provisional: true });
    expect(total(wrong.item.id)).toMatchObject({ successRate: 0, provisional: true });

    // And NOTHING was written: a preview is computed and thrown away, so the
    // grading pass at closing still has everything to do.
    const progress = (
      await get(`/app/api/evaluations/${evaluation.id}/grading/progress`, teacher.headers)
    ).json();
    expect(progress.done).toBe(0);
    expect(seed.classroomId).toBeTruthy();
    expect(db).toBeTruthy();
  });

  it("leaves an unanswered cell blank rather than calling it wrong", async () => {
    const { evaluation, items } = await world("running", 2);
    await post(`/app/api/evaluations/${evaluation.id}/attempt`, student.headers);
    const view = (
      await get(`/app/api/evaluations/${evaluation.id}/dashboard?results=1`, teacher.headers)
    ).json();
    const cells = view.rows.find((r: { userId: string }) => r.userId === student.id).cells;
    expect(cells).toHaveLength(items.length);
    expect(cells.every((c: { verdict: null; status: string }) => c.verdict === null)).toBe(true);
    expect(view.totals.every((t: { successRate: null }) => t.successRate === null)).toBe(true);
  });

  it("does not let a preview overwrite a grading on record", async () => {
    const db = server.app.db;
    const { evaluation, items } = await world("running", 1);
    const entered = await post(`/app/api/evaluations/${evaluation.id}/attempt`, student.headers);
    const attemptId = entered.json().view.attempt.id;
    await save(attemptId, items[0]!.item.id, "answer-q0");
    // A teacher decided otherwise, in the panel: a validated zero.
    const grading = await import("../grading/service.js");
    await grading.writeGrading(db, {
      attemptId,
      itemId: items[0]!.item.id,
      answerId: null,
      points: 0,
      maxPoints: items[0]!.item.points,
      source: "manual",
      state: "validated",
      details: null,
      comment: "off topic",
      now: server.clock.now(),
    });
    const view = (
      await get(`/app/api/evaluations/${evaluation.id}/dashboard?results=1`, teacher.headers)
    ).json();
    const cell = view.rows.find((r: { userId: string }) => r.userId === student.id).cells[0];
    expect(cell.verdict).toBe("wrong");
    expect(cell.provisional).toBe(false);
  });
});
