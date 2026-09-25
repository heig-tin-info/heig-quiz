/**
 * The HTTP surface of WP5 over the REAL application: the whole plugin chain,
 * the real guards, the real session cookies (as `test/http.ts` puts it,
 * anything less would test a stub of the API rather than the API).
 *
 * The service tests next to this file own the rules; this one owns the
 * contract: paths, status codes and the shape of what comes back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq, ne } from "drizzle-orm";
import { GRACE_MS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { attempts, evaluations, gradings } from "../../db/schema.js";
import { subscribe, type Topic } from "../../events.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
let outsider: { id: string; headers: Record<string, string> };
let seed: Awaited<ReturnType<typeof seedLive>>;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  outsider = await server.signIn("student");
  seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 2,
  });
});
afterAll(async () => {
  await server.close();
  restore();
});

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

describe("the teacher's authoring surface (§4.3)", () => {
  it("lists, reads and patches an evaluation", async () => {
    const list = await get(`/app/api/classrooms/${seed.classroomId}/evaluations`, teacher.headers);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ id: seed.evaluationId, itemCount: 2 });

    const detail = await get(`/app/api/evaluations/${seed.evaluationId}`, teacher.headers);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ totalPoints: 2, staleItems: [], editable: true });

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/app/api/evaluations/${seed.evaluationId}`,
      headers: teacher.headers,
      payload: { title: "Contrôle 1" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().evaluation.title).toBe("Contrôle 1");
  });

  it("answers 404, not 403, to a teacher who is not on the staff", async () => {
    const stranger = await server.signIn("teacher");
    expect((await get(`/app/api/evaluations/${seed.evaluationId}`, stranger.headers)).statusCode).toBe(404);
    expect((await get(`/app/api/evaluations/${seed.evaluationId}/dashboard`, stranger.headers)).statusCode).toBe(404);
  });

  it("refuses a student on every teacher route", async () => {
    expect((await get(`/app/api/evaluations/${seed.evaluationId}`, student.headers)).statusCode).toBe(403);
  });

  it("previews as a student, without creating an attempt", async () => {
    const preview = await post(`/app/api/evaluations/${seed.evaluationId}/preview`, teacher.headers);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().view.attempt.preview).toBe(true);
    expect(preview.json().view.items).toHaveLength(2);
    expect(JSON.stringify(preview.json())).not.toContain("answer-q0");
  });

  it("refuses a delete whose confirmation does not name the evaluation", async () => {
    const res = await server.app.inject({
      method: "DELETE",
      url: `/app/api/evaluations/${seed.evaluationId}`,
      headers: teacher.headers,
      payload: { confirmTitle: "wrong" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("confirm_mismatch");
  });
});

describe("taking the evaluation (§4.4, §4.7)", () => {
  let attemptId: string;
  let itemId: string;

  it("starts the evaluation and hands the student their attempt", async () => {
    const started = await post(
      `/app/api/evaluations/${seed.evaluationId}/start`,
      teacher.headers,
      { confirm: true },
    );
    expect(started.statusCode).toBe(200);
    expect(started.json().state).toBe("running");

    const entered = await post(
      `/app/api/evaluations/${seed.evaluationId}/attempt`,
      student.headers,
      {},
    );
    expect(entered.statusCode).toBe(200);
    expect(entered.json().kind).toBe("attempt");
    attemptId = entered.json().view.attempt.id;
    itemId = entered.json().view.items[0].id;
    expect(entered.json().view.attempt.serverNow).toBeDefined();

    // Idempotent over HTTP too.
    const again = await post(`/app/api/evaluations/${seed.evaluationId}/attempt`, student.headers, {});
    expect(again.json().view.attempt.id).toBe(attemptId);
  });

  /**
   * The loop of the "Start now" incident. `POST /evaluations/:id/attempt` is a
   * READ behind a POST (deviation W5-14): the client asks and the server
   * decides lobby or player, so the student's tab re-issues it whenever
   * anything invalidates its queries. The generic `onResponse` hook in
   * `app.ts` used to answer every unmatched mutation with a hint on the
   * ACTOR'S OWN `user:<id>` topic — which is exactly the tab that asked — and
   * the two fed each other at ~215 requests per second.
   *
   * No student write may hint the student. Everything a running attempt needs
   * travels as a typed frame on `attempt:`/`evaluation:` instead.
   */
  it("emits no refresh hint to the student on any of their own writes", async () => {
    const hints: { type: string; topics: Topic[] }[] = [];
    const stop = subscribe((m) => {
      if (m.kind === "hint") hints.push({ type: m.type, topics: m.topics });
    });
    try {
      const writes: [string, unknown][] = [
        [`/app/api/evaluations/${seed.evaluationId}/attempt`, {}],
        [`/app/api/attempts/${attemptId}/position`, { itemId }],
        [`/app/api/attempts/${attemptId}/events`, { kind: "reconnect" }],
      ];
      for (const [url, payload] of writes) {
        const res = await post(url, student.headers, payload);
        expect(res.statusCode, url).toBeLessThan(400);
      }
      expect(hints.filter((h) => h.topics.includes(`user:${student.id}`))).toEqual([]);
      expect(hints).toEqual([]);
    } finally {
      stop();
    }
  });

  it("keeps a student out of someone else's classroom and attempt", async () => {
    expect(
      (await post(`/app/api/evaluations/${seed.evaluationId}/attempt`, outsider.headers, {})).statusCode,
    ).toBe(404);
    expect((await get(`/app/api/attempts/${attemptId}`, outsider.headers)).statusCode).toBe(404);
  });

  /**
   * The order of the refusals, which the route wrappers of `modules/http.ts`
   * must keep (audit B-02): session (the preHandler) → params (404) → then,
   * for a student, body (400) before the loader's 404, and for a teacher,
   * the loader's 404 before the body.
   */
  it("refuses in the same order as ever: session, params, then body and scope", async () => {
    const badBody = { revision: "not a number" };
    const anon = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/not-a-uuid/answers/also-not`,
      headers: {},
      payload: badBody,
    });
    expect(anon.statusCode).toBe(401);
    const studentOnTeacher = await post(`/app/api/evaluations/not-a-uuid/extend`, student.headers, {});
    expect(studentOnTeacher.statusCode).toBe(403);

    const badParams = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/not-a-uuid/answers/${itemId}`,
      headers: student.headers,
      payload: badBody,
    });
    expect(badParams.statusCode).toBe(404);
    expect(badParams.json()).toEqual({ error: "not_found" });

    // Student: a malformed body is a 400 even on somebody else's attempt.
    const foreign = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
      headers: outsider.headers,
      payload: badBody,
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toBe("validation");

    // Teacher: off the staff, the scope's 404 wins over the malformed body.
    const stranger = await server.signIn("teacher");
    const offStaff = await post(`/app/api/evaluations/${seed.evaluationId}/extend`, stranger.headers, {
      minutes: "many",
    });
    expect(offStaff.statusCode).toBe(404);
    expect(offStaff.json()).toEqual({ error: "not_found" });
  });

  it("autosaves, restores and refuses a stale revision", async () => {
    const save = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
      headers: student.headers,
      payload: { payload: "Rome", revision: 4, clientTs: server.clock.now().toISOString() },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ accepted: true, revision: 4 });
    expect(save.json().serverNow).toBe(server.clock.now().toISOString());

    const stale = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
      headers: student.headers,
      payload: { payload: "Roma", revision: 2, clientTs: server.clock.now().toISOString() },
    });
    expect(stale.json()).toMatchObject({ accepted: false, revision: 4, payload: "Rome" });

    // Finding M1: `revision` is an int4 in the database. A bigger one used to
    // be a generic 500 from pg, and `2147483647` froze the item for good.
    const absurd = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
      headers: student.headers,
      payload: { payload: "overflow", revision: 2_147_483_648, clientTs: server.clock.now().toISOString() },
    });
    expect(absurd.statusCode).toBe(400);
    expect(absurd.json().error).toBe("validation");

    const restored = await get(`/app/api/attempts/${attemptId}`, student.headers);
    expect(restored.json().kind).toBe("attempt");
    const item = restored.json().view.items.find((i: { id: string }) => i.id === itemId);
    expect(item.answer).toBe("Rome");
    expect(item.revision).toBe(4);
  });

  it("journals an attempt event, and has nothing to validate in free navigation", async () => {
    expect(
      (await post(`/app/api/attempts/${attemptId}/events`, student.headers, { kind: "visibility" }))
        .statusCode,
    ).toBe(204);
    const done = await post(
      `/app/api/attempts/${attemptId}/answers/${itemId}/done`,
      student.headers,
      { done: true },
    );
    // Issue #89: validation is the step of the locking navigations only.
    expect(done.statusCode).toBe(409);
    expect(done.json().error).toBe("not_validatable");
  });

  it("shows the grid with the cell the student just filled", async () => {
    const dashboard = await get(
      `/app/api/evaluations/${seed.evaluationId}/dashboard?includeAnswers=1`,
      teacher.headers,
    );
    expect(dashboard.statusCode).toBe(200);
    const row = dashboard.json().rows.find((r: { userId: string }) => r.userId === student.id);
    expect(row.state).toBe("in_progress");
    expect(row.cells[0].status).toBe("in_progress");
    expect(row.cells[0].summary).toContain("Rome");
  });

  it("flags a question and skips another, for the student's own attempt only (issue #89)", async () => {
    const view = await get(`/app/api/attempts/${attemptId}`, student.headers);
    const other = view.json().view.items.find((i: { id: string }) => i.id !== itemId).id as string;

    const flag = await post(`/app/api/attempts/${attemptId}/answers/${other}/flag`, student.headers, {
      flagged: true,
    });
    expect(flag.statusCode).toBe(200);
    expect(flag.json()).toMatchObject({ flagged: true });
    expect(flag.json().serverNow).toBe(server.clock.now().toISOString());

    // The first question holds "Rome": skipping it would erase an answer.
    const refused = await post(`/app/api/attempts/${attemptId}/answers/${itemId}/skip`, student.headers, {
      skipped: true,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("answered");

    const skip = await post(`/app/api/attempts/${attemptId}/answers/${other}/skip`, student.headers, {
      skipped: true,
    });
    expect(skip.statusCode).toBe(200);
    expect(skip.json()).toMatchObject({ skipped: true });

    // Somebody else's attempt is a 404, like every student route.
    const foreign = await post(`/app/api/attempts/${attemptId}/answers/${other}/flag`, outsider.headers, {
      flagged: false,
    });
    expect(foreign.statusCode).toBe(404);

    const dashboard = await get(`/app/api/evaluations/${seed.evaluationId}/dashboard`, teacher.headers);
    const row = dashboard.json().rows.find((r: { userId: string }) => r.userId === student.id);
    const cell = row.cells.find((c: { itemId: string }) => c.itemId === other);
    expect(cell).toMatchObject({ flagged: true, status: "skipped" });

    const restored = await get(`/app/api/attempts/${attemptId}`, student.headers);
    const item = restored.json().view.items.find((i: { id: string }) => i.id === other);
    expect(item).toMatchObject({ flagged: true, skipped: true });
  });

  it("inspects one attempt, key included, for the teacher only (F-DASH-05)", async () => {
    const inspect = await get(
      `/app/api/evaluations/${seed.evaluationId}/attempts/${attemptId}`,
      teacher.headers,
    );
    expect(inspect.statusCode).toBe(200);
    expect(JSON.stringify(inspect.json().items[0].solution)).toContain("answer-q0");
    expect(JSON.stringify(inspect.json().items[0].studentConfig)).not.toContain("answer-q0");
    expect(inspect.json().events.map((e: { kind: string }) => e.kind)).toContain("visibility");
  });

  it("answers 410 attempt_closed past the deadline and its grace", async () => {
    const view = await get(`/app/api/attempts/${attemptId}`, student.headers);
    const deadline = new Date(view.json().view.attempt.deadlineAt as string);
    server.clock.set(new Date(deadline.getTime() + GRACE_MS + 1));

    const late = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
      headers: student.headers,
      payload: { payload: "too late", revision: 99, clientTs: server.clock.now().toISOString() },
    });
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({ error: "attempt_closed", reason: "deadline" });
    expect(late.json().serverNow).toBe(server.clock.now().toISOString());

    // The two state writes of issue #89 take the same gate.
    for (const [action, body] of [
      ["flag", { flagged: false }],
      ["skip", { skipped: false }],
    ] as const) {
      const refused = await post(
        `/app/api/attempts/${attemptId}/answers/${itemId}/${action}`,
        student.headers,
        body,
      );
      expect(refused.statusCode).toBe(410);
      expect(refused.json()).toMatchObject({ error: "attempt_closed", reason: "deadline" });
    }
    server.clock.set(new Date(deadline.getTime() - 60_000));
  });

  it("extends the time of everybody, then of one attempt (F-LIVE-11)", async () => {
    const all = await post(`/app/api/evaluations/${seed.evaluationId}/extend`, teacher.headers, {
      minutes: 5,
      scope: "all",
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().updated).toBe(1);

    const one = await post(`/app/api/evaluations/${seed.evaluationId}/extend`, teacher.headers, {
      minutes: 10,
      scope: "attempt",
      attemptId,
    });
    expect(one.json().updated).toBe(1);

    // `scope: "attempt"` without an id is a validation error, not a 500.
    const broken = await post(`/app/api/evaluations/${seed.evaluationId}/extend`, teacher.headers, {
      minutes: 1,
      scope: "attempt",
    });
    expect(broken.statusCode).toBe(400);
  });

  it("pauses, refuses the writes, then resumes (decision D17)", async () => {
    expect((await post(`/app/api/evaluations/${seed.evaluationId}/pause`, teacher.headers)).statusCode).toBe(200);
    const blocked = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
      headers: student.headers,
      payload: { payload: "during the pause", revision: 50, clientTs: server.clock.now().toISOString() },
    });
    expect(blocked.statusCode).toBe(410);
    expect(blocked.json().reason).toBe("paused");
    const dashboard = await get(`/app/api/evaluations/${seed.evaluationId}/dashboard`, teacher.headers);
    expect(dashboard.json().evaluation.state).toBe("paused");

    expect((await post(`/app/api/evaluations/${seed.evaluationId}/resume`, teacher.headers)).statusCode).toBe(200);
    // Issue #77: once resumed, the same student writes again.
    const accepted = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
      headers: student.headers,
      payload: { payload: "after the pause", revision: 51, clientTs: server.clock.now().toISOString() },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().accepted).toBe(true);
  });

  it("submits, and then refuses everything with reason `submitted`", async () => {
    const submitted = await post(`/app/api/attempts/${attemptId}/submit`, student.headers, {
      confirm: true,
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().state).toBe("submitted");

    const after = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
      headers: student.headers,
      payload: { payload: "nope", revision: 100, clientTs: server.clock.now().toISOString() },
    });
    expect(after.statusCode).toBe(410);
    expect(after.json().reason).toBe("submitted");

    // Finding M7: the position and the journal are writes too. A submitted
    // student kept refreshing `present_at` — so kept showing up as online —
    // and kept growing the journal after the exam.
    const moved = await post(`/app/api/attempts/${attemptId}/position`, student.headers, { itemId });
    expect(moved.statusCode).toBe(410);
    expect(moved.json().reason).toBe("submitted");
    const journalled = await post(`/app/api/attempts/${attemptId}/events`, student.headers, {
      kind: "visibility",
    });
    expect(journalled.statusCode).toBe(410);
  });

  it("closes the evaluation and leaves it closed", async () => {
    const closed = await post(`/app/api/evaluations/${seed.evaluationId}/close`, teacher.headers);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().state).toBe("closed");
    const [row] = await server.app.db
      .select()
      .from(evaluations)
      .where(eq(evaluations.id, seed.evaluationId));
    expect(row!.closedAt).not.toBeNull();
  });
});

describe("closing and reopening one attempt around the close (#95)", () => {
  let own: Awaited<ReturnType<typeof seedLive>>;
  let pupil: { id: string; headers: Record<string, string> };
  let attemptId: string;

  const standing = (id: string) =>
    server.app.db
      .select()
      .from(gradings)
      .where(and(eq(gradings.attemptId, id), ne(gradings.state, "superseded")));
  const attemptRow = async (id: string) =>
    (await server.app.db.select().from(attempts).where(eq(attempts.id, id)))[0]!;
  const base = () => `/app/api/evaluations/${own.evaluationId}`;

  beforeAll(async () => {
    pupil = await server.signIn("student");
    own = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [pupil.id],
      questions: 2,
    });
    await post(`${base()}/start`, teacher.headers, { confirm: true });
    const entered = await post(`${base()}/attempt`, pupil.headers, {});
    attemptId = entered.json().view.attempt.id;
    const itemId = entered.json().view.items[0].id;
    await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
      headers: pupil.headers,
      payload: { payload: "Rome", revision: 1, clientTs: server.clock.now().toISOString() },
    });
  });

  it("closes and reopens one attempt while the evaluation runs", async () => {
    const closed = await post(`${base()}/attempts/${attemptId}/close`, teacher.headers);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().state).toBe("expired");
    const reopened = await post(`${base()}/attempts/${attemptId}/reopen`, teacher.headers);
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().state).toBe("in_progress");
  });

  it("refuses to reopen, or to extend, once the evaluation is closed", async () => {
    expect((await post(`${base()}/close`, teacher.headers)).statusCode).toBe(200);
    expect((await attemptRow(attemptId)).state).toBe("expired");
    // The close ran the grading pass: one grading per item.
    expect(await standing(attemptId)).toHaveLength(2);

    // A reopened attempt there would be `in_progress` and yet refuse every
    // write with `evaluation_closed`: a zombie nobody could close.
    const reopened = await post(`${base()}/attempts/${attemptId}/reopen`, teacher.headers);
    expect(reopened.statusCode).toBe(409);
    expect(reopened.json().error).toBe("evaluation_not_live");
    expect((await attemptRow(attemptId)).state).toBe("expired");

    for (const body of [
      { minutes: 5, scope: "all" },
      { minutes: 5, scope: "attempt", attemptId },
    ]) {
      const extended = await post(`${base()}/extend`, teacher.headers, body);
      expect(extended.statusCode).toBe(409);
      expect(extended.json().error).toBe("evaluation_finished");
    }
  });

  it("closes an attempt left open in a closed evaluation, and grades it", async () => {
    // The row a reopen after the close used to leave behind: `in_progress`,
    // and never graded as such.
    await server.app.db.delete(gradings).where(eq(gradings.attemptId, attemptId));
    await server.app.db
      .update(attempts)
      .set({ state: "in_progress", closedAt: null, closedBy: null, deadlineAt: null })
      .where(eq(attempts.id, attemptId));

    const closed = await post(`${base()}/attempts/${attemptId}/close`, teacher.headers);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().state).toBe("expired");
    const row = await attemptRow(attemptId);
    expect(row.closedBy).toBe("teacher");
    expect(await standing(attemptId)).toHaveLength(2);
  });

  it("closes one left open in a released evaluation, without touching its grades", async () => {
    await server.app.db
      .update(evaluations)
      .set({ state: "released" })
      .where(eq(evaluations.id, own.evaluationId));
    await server.app.db.delete(gradings).where(eq(gradings.attemptId, attemptId));
    await server.app.db
      .update(attempts)
      .set({ state: "in_progress", closedAt: null, closedBy: null })
      .where(eq(attempts.id, attemptId));

    const closed = await post(`${base()}/attempts/${attemptId}/close`, teacher.headers);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().state).toBe("expired");
    // Published grades stay the teacher's to change, from the panel.
    expect(await standing(attemptId)).toHaveLength(0);

    const reopened = await post(`${base()}/attempts/${attemptId}/reopen`, teacher.headers);
    expect(reopened.statusCode).toBe(409);
    const extended = await post(`${base()}/extend`, teacher.headers, { minutes: 1, scope: "all" });
    expect(extended.statusCode).toBe(409);
  });
});

describe("the student's home (F-LIVE-01)", () => {
  it("lists the evaluations of the classrooms the student claimed", async () => {
    const home = await get("/app/api/student/home", student.headers);
    expect(home.statusCode).toBe(200);
    expect(home.json().past.map((c: { id: string }) => c.id)).toContain(seed.evaluationId);
    expect(home.json().serverNow).toBeDefined();
    // Someone enrolled nowhere sees nothing at all.
    const empty = await get("/app/api/student/home", outsider.headers);
    expect(empty.json()).toMatchObject({ open: [], upcoming: [], past: [] });
  });
});

describe("running code from an attempt (decision D14)", () => {
  it("answers 503 runner_unavailable with the default stub runner", async () => {
    const other = await server.signIn("student");
    const own = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [other.id],
      questions: 1,
    });
    await post(`/app/api/evaluations/${own.evaluationId}/start`, teacher.headers, { confirm: true });
    const entered = await post(`/app/api/evaluations/${own.evaluationId}/attempt`, other.headers, {});
    const attemptId = entered.json().view.attempt.id;
    const itemId = entered.json().view.items[0].id;

    const run = await post(`/app/api/attempts/${attemptId}/run`, other.headers, {
      itemId,
      regions: ["return 0;"],
    });
    // The fake `short` type has no runner half at all: `not_runnable`. A
    // runner-backed type on the same stub answers 503, which
    // `live.db.test.ts` asserts against the real `UnavailableRunner`.
    expect([422, 503]).toContain(run.statusCode);
    expect(["not_runnable", "runner_unavailable"]).toContain(run.json().error);
  });
});

/**
 * Finding H2: Caddy APPENDS to `X-Forwarded-For`, so the left-most entry is
 * whatever the client typed. `trustProxy: 1` makes `req.ip` the address the
 * one trusted hop actually saw — the right-most entry — and the room
 * restriction of F-EVAL-12 stops being a header away.
 */
describe("the room restriction reads the address Caddy saw (H2)", () => {
  it("ignores a forged left-most X-Forwarded-For", async () => {
    const learner = await server.signIn("student");
    const own = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [learner.id],
      questions: 1,
    });
    await server.app.db
      .update(evaluations)
      .set({ ipAllowlist: ["10.20."] })
      .where(eq(evaluations.id, own.evaluationId));
    await post(`/app/api/evaluations/${own.evaluationId}/start`, teacher.headers, { confirm: true });

    // What a student would send from home, with Caddy appending their real
    // address after it.
    const forged = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${own.evaluationId}/attempt`,
      headers: { ...learner.headers, "x-forwarded-for": "10.20.0.1, 203.0.113.9" },
      payload: {},
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error).toBe("ip_not_allowed");

    // The same request from a machine in the room passes, whatever the
    // left-most entry claims.
    const inRoom = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${own.evaluationId}/attempt`,
      headers: { ...learner.headers, "x-forwarded-for": "1.2.3.4, 10.20.0.7" },
      payload: {},
    });
    expect(inRoom.statusCode).toBe(200);
    expect(inRoom.json().kind).toBe("attempt");
  });
});

/**
 * Finding C1 of the security review: an attempt row exists as soon as the
 * student joins the LOBBY, and its id is public to its owner (the student
 * home carries it). Neither the route nor the stream may turn that id into
 * the question paper before the teacher presses Start.
 */
describe("the lobby hands out no question content (C1)", () => {
  it("answers the lobby view, then the attempt, then a read-only attempt", async () => {
    const learner = await server.signIn("student");
    const own = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [learner.id],
      questions: 2,
    });
    await applyState(
      server.app.db,
      await reload(server.app.db, own.evaluationId),
      "lobby",
      server.clock.now(),
    );

    const entered = await post(`/app/api/evaluations/${own.evaluationId}/attempt`, learner.headers, {});
    expect(entered.statusCode).toBe(200);
    expect(entered.json().kind).toBe("lobby");

    // The id the student legitimately knows, straight from their own home.
    const home = await get("/app/api/student/home", learner.headers);
    const card = home
      .json()
      .open.find((c: { id: string }) => c.id === own.evaluationId) as { attemptId: string };
    expect(card.attemptId).not.toBeNull();

    const inLobby = await get(`/app/api/attempts/${card.attemptId}`, learner.headers);
    expect(inLobby.statusCode).toBe(200);
    expect(inLobby.json().kind).toBe("lobby");
    expect(inLobby.json().view.items).toBeUndefined();
    // Neither the statements nor the key travel before the start.
    expect(inLobby.payload).not.toContain("Statement of q0");
    expect(inLobby.payload).not.toContain("answer-q0");

    await post(`/app/api/evaluations/${own.evaluationId}/start`, teacher.headers, { confirm: true });
    const running = await get(`/app/api/attempts/${card.attemptId}`, learner.headers);
    expect(running.json().kind).toBe("attempt");
    expect(running.json().view.items).toHaveLength(2);
    expect(running.json().view.attempt.readOnly).toBe(false);
    expect(running.payload).toContain("Statement of q0");

    // After the end the content comes back read-only, still without the key.
    await post(`/app/api/evaluations/${own.evaluationId}/close`, teacher.headers);
    const closed = await get(`/app/api/attempts/${card.attemptId}`, learner.headers);
    expect(closed.json().kind).toBe("attempt");
    expect(closed.json().view.attempt.readOnly).toBe(true);
    expect(closed.payload).not.toContain("answer-q0");
  });
});

describe("pausing an exercise (#77)", () => {
  /**
   * The glossary: "the `exercise` mode skips `lobby` and `paused`". The
   * refusal is a 409 the dashboard must SHOW — it used to swallow it, and
   * the button looked like it did nothing.
   */
  it("is refused with 409 illegal_transition, and the exercise keeps running", async () => {
    const own = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [student.id],
      mode: "exercise",
    });
    const started = await post(`/app/api/evaluations/${own.evaluationId}/start`, teacher.headers, {
      confirm: true,
    });
    expect(started.statusCode).toBe(200);
    const paused = await post(`/app/api/evaluations/${own.evaluationId}/pause`, teacher.headers);
    expect(paused.statusCode).toBe(409);
    expect(paused.json().error).toBe("illegal_transition");
    expect((await reload(server.app.db, own.evaluationId)).state).toBe("running");
  });
});
