/**
 * The dwell (ADR-039) over the REAL application: the position reports of the
 * player open and close the intervals, every end of an attempt flushes the
 * open one, and every instant is the server's (invariant 5) — the test moves
 * the clock, never sleeps.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EvaluationMode } from "@quiz/contracts";
import { DWELL_IDLE_CAP_MS, GRACE_MS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { answers, attempts } from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import * as service from "./service.js";

let server: TestServer;
let restore: () => void;
let teacherId: string;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-09-21T08:00:00.000Z");
  teacherId = (await server.signIn("teacher")).id;
});

afterAll(async () => {
  await server.close();
  restore();
});

const MIN = 60_000;
const db = () => server.app.db;
const now = () => server.clock.now();
const tick = (ms: number) => server.clock.advance(ms);

/** One student in a running evaluation of three questions, their attempt begun now. */
async function world(o: { durationS?: number | null; mode?: EvaluationMode } = {}) {
  const student = await server.signIn("student");
  const seed = await seedLive(db(), {
    teacherId,
    studentIds: [student.id],
    questions: 3,
    durationS: o.durationS === undefined ? 3600 : o.durationS,
    ...(o.mode ? { mode: o.mode } : {}),
  });
  await service.startEvaluation(db(), await reload(db(), seed.evaluationId), now());
  const entered = await server.app.inject({
    method: "POST",
    url: `/app/api/evaluations/${seed.evaluationId}/attempt`,
    headers: student.headers,
    payload: {},
  });
  expect(entered.statusCode).toBe(200);
  const attemptId = entered.json().view.attempt.id as string;
  const [a, b, c] = seed.itemIds as [string, string, string];
  const post = (path: string, payload: Payload) =>
    server.app.inject({ method: "POST", url: `/app/api/attempts/${attemptId}/${path}`, headers: student.headers, payload });
  return {
    seed,
    attemptId,
    a,
    b,
    c,
    /** The player's report: this item is on screen, or none. */
    show: async (itemId: string | null) => (await post("position", { itemId })).statusCode,
    save: async (itemId: string, payload: string, revision = 1) =>
      server.app.inject({
        method: "PUT",
        url: `/app/api/attempts/${attemptId}/answers/${itemId}`,
        headers: student.headers,
        payload: { payload, revision, clientTs: now().toISOString() },
      }),
    submit: () => post("submit", { confirm: true }),
    attempt: async () => (await service.attemptById(db(), attemptId))!,
    evaluation: () => reload(db(), seed.evaluationId),
    /** The answer row of an item, or null. */
    row: async (itemId: string) => {
      const [row] = await db()
        .select()
        .from(answers)
        .where(and(eq(answers.attemptId, attemptId), eq(answers.itemId, itemId)));
      return row ?? null;
    },
    dwell: async (itemId: string) => {
      const [row] = await db()
        .select({ dwellMs: answers.dwellMs })
        .from(answers)
        .where(and(eq(answers.attemptId, attemptId), eq(answers.itemId, itemId)));
      return row?.dwellMs ?? null;
    },
  };
}

/** The open interval of an attempt: its item, or null. */
async function openOf(w: Awaited<ReturnType<typeof world>>) {
  const row = await w.attempt();
  return row.shownItemId;
}

describe("the position reports (ADR-039)", () => {
  it("credits each question the time until the next one is shown", async () => {
    const w = await world();
    expect(await w.show(w.a)).toBe(204);
    tick(30_000);
    expect(await w.show(w.b)).toBe(204);
    expect(await w.dwell(w.a)).toBe(30_000);
    tick(20_000);
    await w.show(w.a);
    expect(await w.dwell(w.b)).toBe(20_000);
    expect(await openOf(w)).toBe(w.a);
    expect((await w.attempt()).lastItemId).toBe(w.a);
  });

  it("leaves the open interval alone when the same question is reported again", async () => {
    const w = await world();
    await w.show(w.a);
    const since = (await w.attempt()).shownSince;
    tick(10_000);
    await w.show(w.a);
    expect((await w.attempt()).shownSince).toEqual(since);
    expect(await w.dwell(w.a)).toBe(0);
    tick(10_000);
    await w.show(null);
    expect(await w.dwell(w.a)).toBe(20_000);
  });

  it("stops counting while the tab is hidden, keeps the bookmark, and counts again on return", async () => {
    const w = await world();
    await w.show(w.a);
    tick(10_000);
    await w.show(null);
    expect(await openOf(w)).toBeNull();
    expect((await w.attempt()).lastItemId).toBe(w.a);
    tick(60_000);
    await w.show(w.a);
    tick(5_000);
    await w.show(null);
    expect(await w.dwell(w.a)).toBe(15_000);
  });

  it("follows the last report of two tabs", async () => {
    const w = await world();
    await w.show(w.a);
    tick(5_000);
    await w.show(w.b); // a second tab
    tick(5_000);
    await w.show(w.a); // the first one visible again
    expect(await w.dwell(w.a)).toBe(5_000);
    expect(await w.dwell(w.b)).toBe(5_000);
    expect(await openOf(w)).toBe(w.a);
  });

  it("keeps one open interval when two reports race, and the totals add up", async () => {
    const w = await world();
    await Promise.all([w.show(w.a), w.show(w.b)]);
    const open = await openOf(w);
    expect([w.a, w.b]).toContain(open);
    tick(10_000);
    await w.show(null);
    expect((await w.dwell(w.a))! + (await w.dwell(w.b))!).toBe(10_000);
  });

  it("refuses an item of another evaluation, and writes nothing", async () => {
    const w = await world();
    const other = await world();
    await w.show(w.a);
    expect(await w.show(other.a)).toBe(404);
    expect(await w.row(other.a)).toBeNull();
    expect(await openOf(w)).toBe(w.a);
    expect((await w.attempt()).lastItemId).toBe(w.a);
  });

  it("marks a new attempt tracked", async () => {
    const w = await world();
    expect((await w.attempt()).displayTracked).toBe(true);
  });

  it("makes a displayed question a 'seen' cell, which the first autosave still takes", async () => {
    const w = await world();
    await w.show(w.a);
    const row = await w.row(w.a);
    expect(row).toMatchObject({ revision: 0, firstShownAt: now(), dwellMs: 0 });
    const view = await service.dashboardView(db(), await w.evaluation(), {
      now: now(),
      includeAnswers: false,
      includeResults: false,
    });
    const cell = view.rows.find((r) => r.attemptId === w.attemptId)!.cells.find((c) => c.itemId === w.a);
    expect(cell?.status).toBe("seen");
    const saved = await w.save(w.a, "x", 1);
    expect(saved.json()).toMatchObject({ accepted: true, revision: 1 });
  });

  it("stamps the first display on a write that no report preceded, with no time", async () => {
    const w = await world();
    const at = now();
    tick(3_000);
    await w.save(w.b, "x");
    expect(await w.row(w.b)).toMatchObject({ firstShownAt: new Date(at.getTime() + 3_000), dwellMs: 0 });
    tick(3_000);
    await w.save(w.b, "xy", 2);
    expect((await w.row(w.b))!.firstShownAt).toEqual(new Date(at.getTime() + 3_000));
  });

  it("accrues in an exercise too", async () => {
    const w = await world({ mode: "exercise" });
    await w.show(w.a);
    tick(10_000);
    await w.show(null);
    expect(await w.dwell(w.a)).toBe(10_000);
  });

  it("moves only the bookmark for somebody acting as the student (ADR-034)", async () => {
    const w = await world();
    const before = await w.attempt();
    tick(1_000);
    await service.reportShown(db(), {
      evaluation: await w.evaluation(),
      attempt: before,
      itemId: w.b,
      now: now(),
      track: false,
    });
    const after = await w.attempt();
    expect(after.lastItemId).toBe(w.b);
    expect(after.shownItemId).toBeNull();
    expect(after.presentAt).toEqual(before.presentAt);
    expect(await w.row(w.b)).toBeNull();
  });
});

describe("the idle cap (ADR-039)", () => {
  it("credits ten minutes on screen in full", async () => {
    const w = await world();
    await w.show(w.a);
    tick(10 * MIN);
    await w.show(w.b);
    expect(await w.dwell(w.a)).toBe(DWELL_IDLE_CAP_MS);
  });

  it("credits a question left alone twenty-five minutes the cap only", async () => {
    const w = await world();
    await w.show(w.a);
    tick(25 * MIN);
    await w.show(w.b);
    expect(await w.dwell(w.a)).toBe(10 * MIN);
  });

  it("counts the cap from the last write to the question", async () => {
    const w = await world();
    await w.show(w.a);
    tick(3 * MIN);
    await w.save(w.a, "x");
    tick(9 * MIN);
    await w.show(w.b);
    expect(await w.dwell(w.a)).toBe(12 * MIN);
  });
});

describe("the ends of an attempt flush the open interval (ADR-039)", () => {
  it("at the submission", async () => {
    const w = await world();
    await w.show(w.a);
    tick(12_000);
    expect((await w.submit()).statusCode).toBe(200);
    expect(await w.dwell(w.a)).toBe(12_000);
    expect(await openOf(w)).toBeNull();
  });

  it("at the pause, and a report during the pause moves the bookmark only", async () => {
    const w = await world();
    await w.show(w.a);
    tick(10_000);
    await service.pauseEvaluation(db(), await w.evaluation(), now());
    expect(await w.dwell(w.a)).toBe(10_000);
    expect(await openOf(w)).toBeNull();
    tick(30_000);
    expect(await w.show(w.b)).toBe(204);
    expect(await openOf(w)).toBeNull();
    expect((await w.attempt()).lastItemId).toBe(w.b);
    expect(await w.row(w.b)).toBeNull();
    await service.resumeEvaluation(db(), await w.evaluation(), now());
    await w.show(w.b);
    tick(7_000);
    await w.show(null);
    expect(await w.dwell(w.b)).toBe(7_000);
  });

  it("at the teacher's close of the attempt", async () => {
    const w = await world();
    await w.show(w.a);
    tick(8_000);
    await service.closeAttempt(db(), await w.evaluation(), await w.attempt(), now());
    expect(await w.dwell(w.a)).toBe(8_000);
    expect(await openOf(w)).toBeNull();
  });

  it("at the close of the evaluation", async () => {
    const w = await world();
    await w.show(w.c);
    tick(9_000);
    await service.closeEvaluation(db(), await w.evaluation(), now());
    expect(await w.dwell(w.c)).toBe(9_000);
    expect(await openOf(w)).toBeNull();
  });

  it("at the expiry, clamped at the deadline, and nothing past the grace", async () => {
    const w = await world({ durationS: 60 });
    await w.show(w.a);
    tick(60_000 + GRACE_MS + 1_000);
    // Past deadline + grace: the report is refused and changes nothing.
    expect(await w.show(w.b)).toBe(410);
    expect(await w.dwell(w.a)).toBe(0);
    expect(await openOf(w)).toBe(w.a);
    await service.expireDueAttempts(db(), now());
    expect((await w.attempt()).state).toBe("expired");
    expect(await w.dwell(w.a)).toBe(60_000);
    expect(await openOf(w)).toBeNull();
  });
});

describe("the schema (ADR-039)", () => {
  it("refuses half an interval", async () => {
    const w = await world();
    await expect(
      db().update(attempts).set({ shownItemId: randomUUID() }).where(eq(attempts.id, w.attemptId)),
    ).rejects.toThrow();
  });
});
