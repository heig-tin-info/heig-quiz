/**
 * The per-question state of issue #89 against the real migrations: "I won't
 * answer" (`answers.skipped`), the review flag (`answers.flagged`) and the
 * validation of the locking navigations (`answers.marked_done`).
 *
 * The rules under test, one `describe` each:
 *   - both writes go through the ANSWER gate: a `410` past deadline + grace,
 *     on the server's clock, and during a pause (decision D17);
 *   - a validated question takes no write of any kind in `forward_only`;
 *   - "won't answer" is refused on an answered question, and writing an
 *     answer takes it back — an empty write does not;
 *   - the flag reaches the staff's grid, live and on a read, and no other
 *     student's payload.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GRACE_MS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { TestClock } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { subscribe, type BusMessage } from "../../events.js";
import { testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, itemRows, type EvaluationRecord } from "../evaluation/service.js";
import * as bus from "../realtime/bus.js";
import * as service from "./service.js";

let db: Db;
let restore: () => void;
let clock: TestClock;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = (await testDb()) as unknown as Db;
});
afterAll(() => restore());
beforeEach(() => {
  clock = new TestClock("2026-09-25T08:00:00.000Z");
});

/** A running evaluation with a started attempt for EVERY student. */
async function running(options: Parameters<typeof seedLive>[1] = {}) {
  const seed = await seedLive(db, options);
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
  const started = [];
  for (const userId of seed.studentIds) {
    const participant = (await service.participantOf(db, evaluation, userId))!;
    const created = await service.ensureAttempt(db, evaluation, participant, clock.now());
    started.push(await service.beginAttempt(db, evaluation, created, participant, clock.now()));
  }
  const items = await itemRows(db, evaluation.id);
  return { seed, evaluation, attempt: started[0]!, others: started.slice(1), items };
}

const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "ok";
  } catch (error) {
    if (error instanceof service.AttemptClosedError) return `410 ${error.reason}`;
    if (error instanceof service.LiveError) return error.code;
    throw error;
  }
};

describe("the write gate of skip and flag (invariant 5)", () => {
  it("accepts both at deadline + grace and refuses them the next millisecond", async () => {
    const { evaluation, attempt, items } = await running({ questions: 2 });
    const deadline = attempt.deadlineAt!;
    const itemId = items[0]!.id;

    clock.set(new Date(deadline.getTime() + GRACE_MS));
    const at = { evaluation, attempt, itemId, now: clock.now() };
    expect(await outcome(() => service.setSkipped(db, { ...at, skipped: true }))).toBe("ok");
    expect(await outcome(() => service.setFlagged(db, { ...at, flagged: true }))).toBe("ok");

    clock.set(new Date(deadline.getTime() + GRACE_MS + 1));
    const after = { evaluation, attempt, itemId, now: clock.now() };
    expect(await outcome(() => service.setSkipped(db, { ...after, skipped: false }))).toBe(
      "410 deadline",
    );
    expect(await outcome(() => service.setFlagged(db, { ...after, flagged: false }))).toBe(
      "410 deadline",
    );
  });

  it("refuses both while paused, and on a submitted attempt", async () => {
    const { evaluation, attempt, items } = await running({ questions: 1 });
    const itemId = items[0]!.id;
    const paused: EvaluationRecord = { ...evaluation, state: "paused" };
    const now = clock.now();
    expect(
      await outcome(() =>
        service.setFlagged(db, { evaluation: paused, attempt, itemId, flagged: true, now }),
      ),
    ).toBe("410 paused");
    expect(
      await outcome(() =>
        service.setSkipped(db, { evaluation: paused, attempt, itemId, skipped: true, now }),
      ),
    ).toBe("410 paused");

    const submitted = { ...attempt, state: "submitted" as const };
    expect(
      await outcome(() =>
        service.setFlagged(db, { evaluation, attempt: submitted, itemId, flagged: true, now }),
      ),
    ).toBe("410 submitted");
  });
});

describe("won't answer (issue #89)", () => {
  it("is stored with the attempt and comes back on a reload", async () => {
    const { evaluation, attempt, items } = await running({ questions: 2 });
    const itemId = items[1]!.id;
    const result = await service.setSkipped(db, {
      evaluation,
      attempt,
      itemId,
      skipped: true,
      now: clock.now(),
    });
    expect(result).toEqual({ skipped: true });

    const view = await service.attemptView(db, evaluation, attempt, clock.now());
    const item = view.items.find((i) => i.id === itemId)!;
    expect(item).toMatchObject({ skipped: true, flagged: false, markedDone: false, answer: null });
    expect(view.items.find((i) => i.id === items[0]!.id)!.skipped).toBe(false);
  });

  it("is refused on a question that holds an answer", async () => {
    const { evaluation, attempt, items } = await running({ questions: 1 });
    const itemId = items[0]!.id;
    await service.saveAnswer(db, {
      evaluation,
      attempt,
      itemId,
      payload: "forty-two",
      revision: 1,
      now: clock.now(),
    });
    expect(
      await outcome(() =>
        service.setSkipped(db, { evaluation, attempt, itemId, skipped: true, now: clock.now() }),
      ),
    ).toBe("answered");
  });

  it("is taken back by an answer, not by an empty write", async () => {
    const { evaluation, attempt, items } = await running({ questions: 1 });
    const itemId = items[0]!.id;
    const now = clock.now();
    await service.setSkipped(db, { evaluation, attempt, itemId, skipped: true, now });

    // A cleared field landing after the skip (the autosave's debounce) is
    // not an answer: the skip stays.
    await service.saveAnswer(db, { evaluation, attempt, itemId, payload: "  ", revision: 1, now });
    let view = await service.attemptView(db, evaluation, attempt, now);
    expect(view.items[0]!.skipped).toBe(true);

    await service.saveAnswer(db, { evaluation, attempt, itemId, payload: "forty-two", revision: 2, now });
    view = await service.attemptView(db, evaluation, attempt, now);
    expect(view.items[0]).toMatchObject({ skipped: false, answer: "forty-two" });
  });
});

describe("the review flag (issue #89)", () => {
  it("toggles, and survives a reload", async () => {
    const { evaluation, attempt, items } = await running({ questions: 1 });
    const itemId = items[0]!.id;
    const now = clock.now();
    await service.setFlagged(db, { evaluation, attempt, itemId, flagged: true, now });
    let view = await service.attemptView(db, evaluation, attempt, now);
    expect(view.items[0]!.flagged).toBe(true);

    // An answer written afterwards leaves the flag where it is.
    await service.saveAnswer(db, { evaluation, attempt, itemId, payload: "forty-two", revision: 1, now });
    view = await service.attemptView(db, evaluation, attempt, now);
    expect(view.items[0]).toMatchObject({ flagged: true, answer: "forty-two" });

    await service.setFlagged(db, { evaluation, attempt, itemId, flagged: false, now });
    view = await service.attemptView(db, evaluation, attempt, now);
    expect(view.items[0]!.flagged).toBe(false);
  });

  it("reaches the staff's grid, and no other student's view", async () => {
    const { evaluation, attempt, others, items, seed } = await running({
      students: 2,
      questions: 2,
    });
    const itemId = items[0]!.id;
    const now = clock.now();
    await service.setFlagged(db, { evaluation, attempt, itemId, flagged: true, now });
    await service.setSkipped(db, { evaluation, attempt, itemId: items[1]!.id, skipped: true, now });

    const grid = await service.dashboardView(db, evaluation, {
      now,
      includeAnswers: false,
      includeResults: false,
    });
    const mine = grid.rows.find((r) => r.userId === seed.studentIds[0]!)!;
    expect(mine.cells.find((c) => c.itemId === itemId)).toMatchObject({
      flagged: true,
      status: "seen",
    });
    expect(mine.cells.find((c) => c.itemId === items[1]!.id)).toMatchObject({
      flagged: false,
      status: "skipped",
    });
    // A skipped question counts as dealt with.
    expect(grid.totals.find((t) => t.itemId === items[1]!.id)!.completion).toBe(0.5);

    const theirs = await service.attemptView(db, evaluation, others[0]!, now);
    expect(theirs.items.every((i) => !i.flagged && !i.skipped)).toBe(true);
  });

  it("publishes the whole cell to the staff topic only", async () => {
    bus.resetCoalescers();
    const { evaluation, attempt, items } = await running({ questions: 1 });
    const itemId = items[0]!.id;
    const seen: BusMessage[] = [];
    const unsubscribe = subscribe((message) => {
      if (message.kind === "data" && message.event.type === "dashboard.cell") seen.push(message);
    });
    try {
      await service.setFlagged(db, { evaluation, attempt, itemId, flagged: true, now: clock.now() });
      bus.flushCoalescers();
    } finally {
      unsubscribe();
    }
    expect(seen).toHaveLength(1);
    const message = seen[0]!;
    if (message.kind !== "data") throw new Error("unreachable");
    expect(message.audience).toBe("staff");
    expect(message.topics).toEqual([`evaluation:${evaluation.id}`]);
    expect(message.event).toMatchObject({
      type: "dashboard.cell",
      attemptId: attempt.id,
      itemId,
      status: "seen",
      flagged: true,
    });
  });
});

describe("validate and continue in forward_only (F-LIVE-08, issue #89)", () => {
  it("locks the question against answers, skips and flags", async () => {
    const { evaluation, attempt, items } = await running({
      questions: 2,
      settings: { navigation: "forward_only" },
    });
    const itemId = items[0]!.id;
    const now = clock.now();
    await service.setSkipped(db, { evaluation, attempt, itemId, skipped: true, now });
    const validated = await service.markDone(db, { evaluation, attempt, itemId, done: true, now });
    expect(validated.nextItemId).toBe(items[1]!.id);

    expect(
      await outcome(() =>
        service.saveAnswer(db, { evaluation, attempt, itemId, payload: "late", revision: 1, now }),
      ),
    ).toBe("item_locked");
    expect(
      await outcome(() =>
        service.setSkipped(db, { evaluation, attempt, itemId, skipped: false, now }),
      ),
    ).toBe("item_locked");
    expect(
      await outcome(() =>
        service.setFlagged(db, { evaluation, attempt, itemId, flagged: true, now }),
      ),
    ).toBe("item_locked");
    expect(
      await outcome(() => service.markDone(db, { evaluation, attempt, itemId, done: false, now })),
    ).toBe("irreversible");

    const view = await service.attemptView(db, evaluation, attempt, now);
    expect(view.items[0]).toMatchObject({ markedDone: true, skipped: true, locked: true });
    expect(view.items[1]!.locked).toBe(false);
  });
});
