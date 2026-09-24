/**
 * The `live` module against the real migrations (PLAN-MVP §8, WP5).
 *
 * Every instant in this file comes from a {@link TestClock}: the deadline
 * boundary, the three-second grace and the pause shift are asserted by MOVING
 * the clock, never by waiting for it. That is the whole point of taking `now`
 * as a parameter (invariant 5).
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LobbyView } from "@quiz/contracts";
import type { RunnerOutcome } from "@quiz/core/server";
import { GRACE_MS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { TestClock } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  answers,
  attemptEvents,
  attempts,
  enrollments,
  evaluationItems,
  evaluations,
  users,
} from "../../db/schema.js";
import { subscribe, type BusMessage } from "../../events.js";
import { testDb } from "../../test/db.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { UnavailableRunner } from "../runner/unavailable.js";
import { applyState, itemRows, settingsOf, type EvaluationRecord } from "../evaluation/service.js";
import { presence } from "../realtime/presence.js";
import * as service from "./service.js";

let db: Db;
const restores: (() => void)[] = [];
let clock: TestClock;

beforeAll(async () => {
  restores.push(registerForTests(fakeShort), registerForTests(fakeRunnableCode));
  db = (await testDb()) as unknown as Db;
});
afterAll(() => {
  for (const restore of restores) restore();
});
beforeEach(() => {
  clock = new TestClock("2026-09-20T08:00:00.000Z");
});

/** A running evaluation with one started attempt for its first student. */
async function running(options: Parameters<typeof seedLive>[1] = {}) {
  const seed = await seedLive(db, options);
  const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
  const participant = (await service.participantOf(db, row, seed.studentIds[0]!))!;
  const created = await service.ensureAttempt(db, row, participant, clock.now());
  const attempt = await service.beginAttempt(db, row, created, participant, clock.now());
  const items = await itemRows(db, row.id);
  return { seed, evaluation: row, attempt, participant, items };
}

/** The PostgreSQL error under Drizzle's wrapper, whatever the driver. */
function pgErrorOf(err: unknown): { code?: string; constraint?: string } {
  let e: unknown = err;
  while (typeof e === "object" && e !== null) {
    const { code, cause } = e as { code?: unknown; cause?: unknown };
    if (typeof code === "string") return e as { code: string; constraint?: string };
    e = cause;
  }
  return {};
}

describe("an account that holds an attempt (D-10)", () => {
  it("cannot be deleted: its answers and gradings are never erased in passing", async () => {
    const { seed, attempt } = await running();
    const userId = seed.studentIds[0]!;
    // The roster seat refuses the delete too; take it away to reach attempts.
    await db.delete(enrollments).where(eq(enrollments.userId, userId));

    const refused = await db
      .delete(users)
      .where(eq(users.id, userId))
      .then(() => null, (err: unknown) => err);
    expect(pgErrorOf(refused)).toMatchObject({
      code: "23503",
      constraint: "attempts_user_id_users_id_fk",
    });
    const [kept] = await db.select().from(attempts).where(eq(attempts.id, attempt.id));
    expect(kept?.userId).toBe(userId);
  });
});

describe("entering an evaluation (F-LIVE-01)", () => {
  it("creates ONE attempt however many times it is called", async () => {
    const seed = await seedLive(db);
    const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    const participant = (await service.participantOf(db, row, seed.studentIds[0]!))!;

    const first = await service.enterEvaluation(db, { evaluation: row, participant, now: clock.now() });
    clock.advance(1_000);
    const second = await service.enterEvaluation(db, { evaluation: row, participant, now: clock.now() });

    expect(first.attempt.id).toBe(second.attempt.id);
    expect(first.attempt.seed).toBe(second.attempt.seed);
    // The start instant and therefore the deadline are drawn once: a second
    // tab must not hand the student a fresh hour.
    expect(second.attempt.startedAt?.toISOString()).toBe(first.attempt.startedAt?.toISOString());
    const all = await db.select().from(attempts).where(eq(attempts.evaluationId, row.id));
    expect(all).toHaveLength(1);
  });

  it("answers a LobbyView while the evaluation is in the lobby", async () => {
    const seed = await seedLive(db);
    const row = await applyState(db, await reload(db, seed.evaluationId), "lobby", clock.now());
    const participant = (await service.participantOf(db, row, seed.studentIds[0]!))!;
    const result = await service.enterEvaluation(db, { evaluation: row, participant, now: clock.now() });
    expect(result.kind).toBe("lobby");
    if (result.kind === "lobby") expect(result.view.enrolled).toBe(2);
    // The row exists but has not started: no clock is running yet.
    expect(result.attempt.state).toBe("not_started");
    expect(result.attempt.deadlineAt).toBeNull();
  });

  it("carries the evaluation's navigation rule in the lobby (§6.3, F-LIVE-08)", async () => {
    const seed = await seedLive(db);
    const draft = await reload(db, seed.evaluationId);
    await db
      .update(evaluations)
      .set({ settings: { ...(draft.settings as object), navigation: "forward_only" } })
      .where(eq(evaluations.id, seed.evaluationId));
    const row = await applyState(db, await reload(db, seed.evaluationId), "lobby", clock.now());
    const participant = (await service.participantOf(db, row, seed.studentIds[0]!))!;
    const view = await service.lobbyView(db, row, participant, clock.now());
    expect(LobbyView.parse(view).navigation).toBe("forward_only");
  });

  it("refuses a wrong access code and a foreign address (F-EVAL-12)", async () => {
    const seed = await seedLive(db);
    await db
      .update(evaluations)
      .set({ accessCode: "OPEN", ipAllowlist: ["10.0."] })
      .where(eq(evaluations.id, seed.evaluationId));
    const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    const participant = (await service.participantOf(db, row, seed.studentIds[0]!))!;
    await expect(
      service.enterEvaluation(db, { evaluation: row, participant, now: clock.now() }),
    ).rejects.toMatchObject({ code: "access_code_invalid", status: 403 });
    await expect(
      service.enterEvaluation(db, {
        evaluation: row,
        participant,
        accessCode: "OPEN",
        ip: "192.168.1.4",
        now: clock.now(),
      }),
    ).rejects.toMatchObject({ code: "ip_not_allowed", status: 403 });
    const ok = await service.enterEvaluation(db, {
      evaluation: row,
      participant,
      accessCode: "OPEN",
      ip: "10.0.0.9",
      now: clock.now(),
    });
    expect(ok.kind).toBe("attempt");
  });

  it("gives the accommodation its extra seconds (F-ORG-07, F-EVAL-05)", async () => {
    const { attempt } = await running({ timeBonusPercent: 50, durationS: 1800 });
    // 1800 s + 50 % = 2700 s.
    expect(attempt.deadlineAt!.getTime() - clock.now().getTime()).toBe(2700 * 1000);
    expect(attempt.bonusS).toBe(900);
  });
});

/**
 * F-DASH-03. `attempt.deadline` rides the ATTEMPT topic, which only the
 * student watching their own attempt holds; the teacher's dashboard watches
 * `evaluation:<id>`. Without the frame below, a row that had started still
 * read "never connected" on the projector until a full refetch.
 */
describe("what the teacher's grid is told about a row", () => {
  /** Collects the `dashboard.attempt` frames published while `run` executes. */
  async function published<T>(run: () => Promise<T>): Promise<[T, Record<string, unknown>[]]> {
    const seen: Record<string, unknown>[] = [];
    const unsubscribe = subscribe((message: BusMessage) => {
      if (message.kind !== "data") return;
      if (message.event.type !== "dashboard.attempt") return;
      seen.push({ ...message.event, audience: message.audience, topics: message.topics });
    });
    try {
      return [await run(), seen];
    } finally {
      unsubscribe();
    }
  }

  it("announces the attempt the moment it is created, to the staff only", async () => {
    const seed = await seedLive(db);
    const row = await applyState(db, await reload(db, seed.evaluationId), "lobby", clock.now());
    const participant = (await service.participantOf(db, row, seed.studentIds[0]!))!;

    const [attempt, events] = await published(() =>
      service.ensureAttempt(db, row, participant, clock.now()),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      evaluationId: row.id,
      userId: participant.userId,
      attemptId: attempt.id,
      state: "not_started",
      startedAt: null,
      deadlineAt: null,
      audience: "staff",
      topics: [`evaluation:${row.id}`],
    });
  });

  it("says nothing a second time: the row was already there", async () => {
    const seed = await seedLive(db);
    const row = await applyState(db, await reload(db, seed.evaluationId), "lobby", clock.now());
    const participant = (await service.participantOf(db, row, seed.studentIds[0]!))!;
    await service.ensureAttempt(db, row, participant, clock.now());

    const [, events] = await published(() =>
      service.ensureAttempt(db, row, participant, clock.now()),
    );
    expect(events).toEqual([]);
  });

  it("announces the START, with the state and the deadline the row now shows", async () => {
    const seed = await seedLive(db);
    const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    const participant = (await service.participantOf(db, row, seed.studentIds[0]!))!;
    const created = await service.ensureAttempt(db, row, participant, clock.now());

    const [attempt, events] = await published(() =>
      service.beginAttempt(db, row, created, participant, clock.now()),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: participant.userId,
      attemptId: attempt.id,
      state: "in_progress",
      startedAt: clock.now().toISOString(),
      deadlineAt: attempt.deadlineAt!.toISOString(),
      audience: "staff",
    });
  });

  it("says nothing when the start is a no-op (the attempt already runs)", async () => {
    const { evaluation, attempt, participant } = await running();
    const [, events] = await published(() =>
      service.beginAttempt(db, evaluation, attempt, participant, clock.now()),
    );
    expect(events).toEqual([]);
  });
});

describe("autosave (§4.7)", () => {
  it("keeps the highest revision when two writes race, and hands the loser the winner", async () => {
    const { evaluation, attempt, items } = await running();
    const itemId = items[0]!.id;

    const second = await service.saveAnswer(db, {
      evaluation,
      attempt,
      itemId,
      payload: "second",
      revision: 2,
      now: clock.now(),
    });
    expect(second).toMatchObject({ accepted: true, revision: 2 });

    // The late writer carries revision 1: the conditional upsert refuses it
    // and answers with the payload the client must adopt.
    const late = await service.saveAnswer(db, {
      evaluation,
      attempt,
      itemId,
      payload: "first",
      revision: 1,
      now: clock.now(),
    });
    expect(late.accepted).toBe(false);
    expect(late.revision).toBe(2);
    expect(late.payload).toBe("second");

    const third = await service.saveAnswer(db, {
      evaluation,
      attempt,
      itemId,
      payload: "third",
      revision: 3,
      now: clock.now(),
    });
    expect(third).toMatchObject({ accepted: true, revision: 3 });
    const [stored] = await db.select().from(answers).where(eq(answers.attemptId, attempt.id));
    expect(stored!.payload).toBe("third");
  });

  it("accepts a write at deadline + grace and refuses the next millisecond (F-LIVE-07)", async () => {
    const { evaluation, attempt, items } = await running();
    const deadline = attempt.deadlineAt!;

    clock.set(new Date(deadline.getTime() + GRACE_MS));
    await expect(
      service.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: items[0]!.id,
        payload: "in time",
        revision: 1,
        now: clock.now(),
      }),
    ).resolves.toMatchObject({ accepted: true });

    clock.advance(1);
    await expect(
      service.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: items[0]!.id,
        payload: "too late",
        revision: 2,
        now: clock.now(),
      }),
    ).rejects.toMatchObject({ code: "attempt_closed", reason: "deadline" });
  });

  it("gives the three 410 reasons: paused, evaluation_closed, submitted (D17)", async () => {
    const { evaluation, attempt, items } = await running();
    const write = (row: typeof evaluation, target = attempt) =>
      service.saveAnswer(db, {
        evaluation: row,
        attempt: target,
        itemId: items[0]!.id,
        payload: "x",
        revision: 9,
        now: clock.now(),
      });

    const paused = await applyState(db, evaluation, "paused", clock.now());
    await expect(write(paused)).rejects.toMatchObject({ reason: "paused" });

    const closed = await applyState(db, paused, "closed", clock.now());
    await expect(write(closed)).rejects.toMatchObject({ reason: "evaluation_closed" });

    const back = await applyState(db, closed, "running", clock.now());
    const submitted = await service.submitAttempt(db, back, attempt, clock.now());
    await expect(write(back, submitted)).rejects.toMatchObject({ reason: "submitted" });
  });

  it("never persists a payload the type refuses (422 answer_invalid)", async () => {
    const { evaluation, attempt, items } = await running();
    await expect(
      service.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: items[0]!.id,
        payload: { not: "a string" },
        revision: 1,
        now: clock.now(),
      }),
    ).rejects.toMatchObject({ code: "answer_invalid", status: 422 });
    const stored = await db.select().from(answers).where(eq(answers.attemptId, attempt.id));
    expect(stored).toHaveLength(0);
  });
});

describe("whether an attempt is still writable (invariant 5)", () => {
  /**
   * Every state an evaluation and an attempt can be in around the deadline,
   * through the four gates that decide it: the answer write (`saveAnswer`,
   * and `markDone` whose own `irreversible` comes only after the gate), the
   * lighter `isOpen`/`assertOpen` of the position and the journal, and
   * `submitAttempt`. One line per case, so a change in which error wins is a
   * visible diff of this table.
   */
  it("refuses with the same reason, in the same order, in every state", async () => {
    const { evaluation, attempt, items } = await running({
      settings: { navigation: "forward_only" },
    });
    // The first item is marked done, so un-marking it is `irreversible` once
    // past the gate; the second is free to be written.
    const itemId = items[0]!.id;
    await service.markDone(db, { evaluation, attempt, itemId, done: true, now: clock.now() });
    const deadline = new Date(clock.now().getTime() + 60_000);
    const instants = {
      before: new Date(deadline.getTime() - 1),
      at: new Date(deadline.getTime() + GRACE_MS),
      after: new Date(deadline.getTime() + GRACE_MS + 1),
    };
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

    let revision = 1;
    const lines: string[] = [];
    for (const evState of ["lobby", "running", "paused", "closed"] as const) {
      for (const atState of ["in_progress", "submitted", "expired"] as const) {
        for (const [when, now] of Object.entries(instants)) {
          const ev: EvaluationRecord = { ...evaluation, state: evState };
          const at = { ...attempt, state: atState, deadlineAt: deadline };
          const save = await outcome(() =>
            service.saveAnswer(db, {
              evaluation: ev,
              attempt: at,
              itemId: items[1]!.id,
              payload: "x",
              revision: ++revision,
              now,
            }),
          );
          const done = await outcome(() =>
            service.markDone(db, { evaluation: ev, attempt: at, itemId, done: false, now }),
          );
          const open = service.isOpen(ev, at, now) ? "open" : "shut";
          const assert = await outcome(async () => service.assertOpen(ev, at, now));
          const submit = await outcome(() => service.submitAttempt(db, ev, at, now));
          // `submitAttempt` really writes: put the row back for the next case.
          await db
            .update(attempts)
            .set({ state: "in_progress", submittedAt: null, closedAt: null, closedBy: null })
            .where(eq(attempts.id, attempt.id));
          lines.push(
            `${evState} ${atState} ${when}: save=${save} done=${done} ${open} assert=${assert} submit=${submit}`,
          );
        }
      }
    }
    expect(lines).toEqual([
      "lobby in_progress before: save=410 evaluation_closed done=410 evaluation_closed shut assert=410 evaluation_closed submit=ok",
      "lobby in_progress at: save=410 evaluation_closed done=410 evaluation_closed shut assert=410 evaluation_closed submit=ok",
      "lobby in_progress after: save=410 evaluation_closed done=410 evaluation_closed shut assert=410 evaluation_closed submit=ok",
      "lobby submitted before: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "lobby submitted at: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "lobby submitted after: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "lobby expired before: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "lobby expired at: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "lobby expired after: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "running in_progress before: save=ok done=irreversible open assert=ok submit=ok",
      "running in_progress at: save=ok done=irreversible open assert=ok submit=ok",
      "running in_progress after: save=410 deadline done=410 deadline shut assert=410 deadline submit=ok",
      "running submitted before: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "running submitted at: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "running submitted after: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "running expired before: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "running expired at: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "running expired after: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "paused in_progress before: save=410 paused done=410 paused open assert=ok submit=ok",
      "paused in_progress at: save=410 paused done=410 paused open assert=ok submit=ok",
      "paused in_progress after: save=410 paused done=410 paused shut assert=410 deadline submit=ok",
      "paused submitted before: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "paused submitted at: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "paused submitted after: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "paused expired before: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "paused expired at: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "paused expired after: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "closed in_progress before: save=410 evaluation_closed done=410 evaluation_closed shut assert=410 evaluation_closed submit=ok",
      "closed in_progress at: save=410 evaluation_closed done=410 evaluation_closed shut assert=410 evaluation_closed submit=ok",
      "closed in_progress after: save=410 evaluation_closed done=410 evaluation_closed shut assert=410 evaluation_closed submit=ok",
      "closed submitted before: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "closed submitted at: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "closed submitted after: save=410 submitted done=410 submitted shut assert=410 submitted submit=410 submitted",
      "closed expired before: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "closed expired at: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
      "closed expired after: save=410 deadline done=410 deadline shut assert=410 deadline submit=410 deadline",
    ]);
  });
});

describe("navigation enforced server-side (F-EVAL-07, F-LIVE-08)", () => {
  it("forward_only: a question marked done is closed for writing", async () => {
    const { evaluation, attempt, items } = await running({
      settings: { navigation: "forward_only" },
    });
    const itemId = items[0]!.id;
    await service.saveAnswer(db, {
      evaluation,
      attempt,
      itemId,
      payload: "answer",
      revision: 1,
      now: clock.now(),
    });
    const done = await service.markDone(db, {
      evaluation,
      attempt,
      itemId,
      done: true,
      now: clock.now(),
    });
    expect(done.nextItemId).toBe(items[1]!.id);

    // The player greys it out; the SERVER is what actually refuses.
    await expect(
      service.saveAnswer(db, {
        evaluation,
        attempt,
        itemId,
        payload: "changed my mind",
        revision: 2,
        now: clock.now(),
      }),
    ).rejects.toMatchObject({ code: "item_locked", status: 409 });

    await expect(
      service.markDone(db, { evaluation, attempt, itemId, done: false, now: clock.now() }),
    ).rejects.toMatchObject({ code: "irreversible", status: 409 });
  });

  it("milestones: everything up to the validated milestone is closed", async () => {
    const { evaluation, attempt, items } = await running({
      questions: 3,
      settings: { navigation: "milestones", shuffleItems: false },
    });
    await db
      .update((await import("../../db/schema.js")).evaluationItems)
      .set({ milestone: true })
      .where(eq((await import("../../db/schema.js")).evaluationItems.id, items[1]!.id));

    await service.markDone(db, {
      evaluation,
      attempt,
      itemId: items[1]!.id,
      done: true,
      now: clock.now(),
    });
    const view = await service.attemptView(db, evaluation, attempt, clock.now());
    expect(view.items.find((i) => i.id === items[0]!.id)!.locked).toBe(true);
    expect(view.items.find((i) => i.id === items[2]!.id)!.locked).toBe(false);
  });

  it("free navigation locks nothing", async () => {
    const { evaluation, attempt, items } = await running();
    await service.markDone(db, {
      evaluation,
      attempt,
      itemId: items[0]!.id,
      done: true,
      now: clock.now(),
    });
    const view = await service.attemptView(db, evaluation, attempt, clock.now());
    expect(view.items.every((i) => !i.locked)).toBe(true);
  });

  /** The outcome of one autosave: "ok", or the refusal's code. */
  async function tryWrite(
    evaluation: EvaluationRecord,
    attempt: service.AttemptRecord,
    itemId: string,
    revision: number,
  ): Promise<string> {
    try {
      await service.saveAnswer(db, { evaluation, attempt, itemId, payload: "x", revision, now: clock.now() });
      return "ok";
    } catch (error) {
      return (error as { code: string }).code;
    }
  }

  it("milestones + shuffle: the autosave refuses exactly the items the view shows locked", async () => {
    // Several attempts, so that a shuffled order is actually observed: the
    // lock follows the STUDENT's order, not the canonical position.
    let shuffledSeen = false;
    for (let run = 0; run < 6; run++) {
      const { evaluation, attempt, items } = await running({
        questions: 6,
        settings: { navigation: "milestones", shuffleItems: true },
      });
      for (const i of [1, 4]) {
        await db.update(evaluationItems).set({ milestone: true }).where(eq(evaluationItems.id, items[i]!.id));
      }
      const row = await reload(db, evaluation.id);
      const order = (await service.attemptView(db, row, attempt, clock.now())).items.map((i) => i.id);
      if (order.join() !== items.map((i) => i.id).join()) shuffledSeen = true;
      const target = order.find((id) => id === items[1]!.id || id === items[4]!.id)!;
      await service.markDone(db, { evaluation: row, attempt, itemId: target, done: true, now: clock.now() });
      const view = await service.attemptView(db, row, attempt, clock.now());
      const targetRank = order.indexOf(target);
      for (const [rank, id] of order.entries()) {
        const locked = rank <= targetRank;
        expect(view.items.find((i) => i.id === id)!.locked).toBe(locked);
        expect(await tryWrite(row, attempt, id, 10 + rank)).toBe(locked ? "item_locked" : "ok");
      }
    }
    expect(shuffledSeen).toBe(true);
  });

  it("forward_only + shuffle: only the item marked done is refused", async () => {
    const { evaluation, attempt, items } = await running({
      questions: 5,
      settings: { navigation: "forward_only", shuffleItems: true },
    });
    await service.markDone(db, { evaluation, attempt, itemId: items[3]!.id, done: true, now: clock.now() });
    for (const [k, item] of items.entries()) {
      expect(await tryWrite(evaluation, attempt, item.id, 5 + k)).toBe(k === 3 ? "item_locked" : "ok");
    }
  });

  it("an item of ANOTHER evaluation is a 404 in every navigation mode", async () => {
    const other = await running({ questions: 1 });
    for (const navigation of ["free", "forward_only", "milestones"] as const) {
      const { evaluation, attempt } = await running({ settings: { navigation } });
      expect(await tryWrite(evaluation, attempt, other.items[0]!.id, 1)).toBe("not_found");
    }
  });
});

describe("teacher controls (F-LIVE-11, F-LIVE-12)", () => {
  it("resuming pushes every deadline forward by the time spent paused", async () => {
    const { evaluation, attempt } = await running();
    const before = attempt.deadlineAt!;

    const paused = await service.pauseEvaluation(db, evaluation, clock.now());
    clock.advance(120_000); // two minutes of interruption
    const resumed = await service.resumeEvaluation(db, paused, clock.now());
    expect(resumed.state).toBe("running");
    expect(resumed.pausedAt).toBeNull();

    const after = (await service.attemptById(db, attempt.id))!;
    expect(after.deadlineAt!.getTime() - before.getTime()).toBe(120_000);
  });

  /**
   * Finding M8: `applyState` was an unconditional UPDATE, so two resumes on
   * the same row — a double click, or two ticker processes — each added the
   * pause to every deadline.
   */
  it("resumes once, whatever a double click says", async () => {
    const { evaluation, attempt } = await running();
    const before = attempt.deadlineAt!;
    const paused = await service.pauseEvaluation(db, evaluation, clock.now());
    clock.advance(120_000);

    // Both calls hold the row they read while it was paused.
    const [first, second] = await Promise.all([
      service.resumeEvaluation(db, paused, clock.now()),
      service.resumeEvaluation(db, paused, clock.now()),
    ]);
    expect(first.state).toBe("running");
    expect(second.state).toBe("running");

    const after = (await service.attemptById(db, attempt.id))!;
    expect(after.deadlineAt!.getTime() - before.getTime()).toBe(120_000);
    expect(after.extraS).toBe(120);
  });

  /**
   * Issue #77: a pause must stop the exam — writes refused while it lasts —
   * and freeze its clock, so that a deadline which only LOOKS past (the pause
   * has not been added to it yet) is not taken away by the ticker.
   */
  it("pause refuses writes and freezes the ticker; resume shifts the deadline and accepts writes (#77)", async () => {
    const { evaluation, attempt, items } = await running({ durationS: 600 });
    const before = attempt.deadlineAt!;
    // The attempt is re-read for every write, as the route's loader does.
    const write = async (row: EvaluationRecord, revision: number) =>
      service.saveAnswer(db, {
        evaluation: row,
        attempt: (await service.attemptById(db, attempt.id))!,
        itemId: items[0]!.id,
        payload: `r${revision}`,
        revision,
        now: clock.now(),
      });

    await write(evaluation, 1);
    const paused = await service.pauseEvaluation(db, evaluation, clock.now());
    expect(paused.state).toBe("paused");
    await expect(write(paused, 2)).rejects.toMatchObject({ status: 410, reason: "paused" });

    // The pause outlasts the whole ten minutes the student had left.
    clock.set(new Date(before.getTime() + GRACE_MS + 60_000));
    const pausedFor = clock.now().getTime() - paused.pausedAt!.getTime();
    expect(await service.expireDueAttempts(db, clock.now())).not.toContainEqual(
      expect.objectContaining({ id: attempt.id }),
    );
    expect((await service.attemptById(db, attempt.id))!.state).toBe("in_progress");
    await expect(write(paused, 3)).rejects.toMatchObject({ reason: "paused" });

    const resumed = await service.resumeEvaluation(db, paused, clock.now());
    const after = (await service.attemptById(db, attempt.id))!;
    expect(after.deadlineAt!.getTime()).toBe(before.getTime() + pausedFor);
    // The ten minutes are intact: exactly what was left when the pause began.
    expect(after.deadlineAt!.getTime() - clock.now().getTime()).toBe(
      before.getTime() - paused.pausedAt!.getTime(),
    );
    await expect(write(resumed, 4)).resolves.toMatchObject({ accepted: true });

    // Running again, the ticker closes it at the SHIFTED deadline, not before.
    clock.set(new Date(after.deadlineAt!.getTime() + GRACE_MS - 1));
    await service.expireDueAttempts(db, clock.now());
    expect((await service.attemptById(db, attempt.id))!.state).toBe("in_progress");
    clock.advance(1);
    await service.expireDueAttempts(db, clock.now());
    expect((await service.attemptById(db, attempt.id))!.state).toBe("expired");
  });

  it("a paused evaluation past closes_at is not auto-closed; the resume moves closes_at (#77)", async () => {
    const opensAt = clock.now();
    const closesAt = new Date(opensAt.getTime() + 3_600_000);
    const { evaluation, attempt } = await running({
      settings: { timing: "deadline" },
      durationS: null,
      opensAt,
      closesAt,
    });
    expect(attempt.deadlineAt!.getTime()).toBe(closesAt.getTime());

    clock.advance(30 * 60_000);
    const paused = await service.pauseEvaluation(db, evaluation, clock.now());
    // Paused for longer than the half hour that was left.
    clock.set(new Date(closesAt.getTime() + GRACE_MS + 10 * 60_000));
    const pausedFor = clock.now().getTime() - paused.pausedAt!.getTime();
    await service.expireDueAttempts(db, clock.now());
    expect(await service.autoCloseDue(db, clock.now())).not.toContainEqual(
      expect.objectContaining({ id: evaluation.id }),
    );
    expect((await reload(db, evaluation.id)).state).toBe("paused");
    expect((await service.attemptById(db, attempt.id))!.state).toBe("in_progress");

    const resumed = await service.resumeEvaluation(db, paused, clock.now());
    expect(resumed.closesAt!.getTime()).toBe(closesAt.getTime() + pausedFor);
    expect((await reload(db, evaluation.id)).closesAt!.getTime()).toBe(closesAt.getTime() + pausedFor);
    const after = (await service.attemptById(db, attempt.id))!;
    expect(after.deadlineAt!.getTime()).toBe(closesAt.getTime() + pausedFor);

    // Still running a minute later; closed once the shifted end has passed.
    clock.advance(60_000);
    await service.expireDueAttempts(db, clock.now());
    expect(await service.autoCloseDue(db, clock.now())).not.toContainEqual(
      expect.objectContaining({ id: evaluation.id }),
    );
    clock.set(new Date(after.deadlineAt!.getTime() + GRACE_MS + 1));
    await service.expireDueAttempts(db, clock.now());
    expect(await service.autoCloseDue(db, clock.now())).toContainEqual(
      expect.objectContaining({ id: evaluation.id }),
    );
  });

  it("extends every attempt, or exactly one (+1/+5/+10)", async () => {
    const seed = await seedLive(db, { students: 2 });
    const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    const started = [];
    for (const userId of seed.studentIds) {
      const participant = (await service.participantOf(db, row, userId))!;
      const created = await service.ensureAttempt(db, row, participant, clock.now());
      started.push(await service.beginAttempt(db, row, created, participant, clock.now()));
    }
    const [first, second] = started;

    const all = await service.extendTime(db, row, { minutes: 5 }, clock.now());
    expect(all).toBe(2);
    const afterAll_ = await service.attemptById(db, first!.id);
    expect(afterAll_!.deadlineAt!.getTime() - first!.deadlineAt!.getTime()).toBe(5 * 60_000);
    expect(afterAll_!.extraS).toBe(300);

    const one = await service.extendTime(db, row, { minutes: 10, attemptId: second!.id }, clock.now());
    expect(one).toBe(1);
    const onlySecond = await service.attemptById(db, second!.id);
    expect(onlySecond!.deadlineAt!.getTime() - second!.deadlineAt!.getTime()).toBe(15 * 60_000);
    // The first one did not move a second time.
    const stillFirst = await service.attemptById(db, first!.id);
    expect(stillFirst!.deadlineAt!.getTime()).toBe(afterAll_!.deadlineAt!.getTime());
  });

  /**
   * Finding H4: in `deadline` timing every attempt hangs off `closes_at`, so
   * an accommodation (F-ORG-07, legally sensitive) and every `+5 min` only
   * survive if the evaluation itself waits for them.
   */
  it("moves closes_at with everybody, and waits for the accommodated student", async () => {
    const opensAt = clock.now();
    const closesAt = new Date(opensAt.getTime() + 3_600_000);
    const seed = await seedLive(db, {
      students: 2,
      settings: { timing: "deadline" },
      durationS: null,
      opensAt,
      closesAt,
      // 25 % of the announced hour: a quarter of an hour more (decision D8).
      timeBonusPercent: 25,
    });
    const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    const started = [];
    for (const userId of seed.studentIds) {
      const participant = (await service.participantOf(db, row, userId))!;
      const created = await service.ensureAttempt(db, row, participant, clock.now());
      started.push(await service.beginAttempt(db, row, created, participant, clock.now()));
    }
    const [accommodated, ordinary] = started;
    expect(accommodated!.deadlineAt!.getTime()).toBe(closesAt.getTime() + 15 * 60_000);
    expect(ordinary!.deadlineAt!.getTime()).toBe(closesAt.getTime());

    // +10 minutes to everybody moves the end of the evaluation too.
    expect(await service.extendTime(db, row, { minutes: 10 }, clock.now())).toBe(2);
    const extended = await reload(db, seed.evaluationId);
    expect(extended.closesAt!.getTime()).toBe(closesAt.getTime() + 10 * 60_000);
    const both = await Promise.all(started.map((a) => service.attemptById(db, a!.id)));
    for (const [i, attempt] of both.entries()) {
      expect(attempt!.deadlineAt!.getTime()).toBe(started[i]!.deadlineAt!.getTime() + 10 * 60_000);
    }

    // The ordinary student's hour is over, the accommodated one's is not:
    // the ticker leaves the evaluation running.
    clock.set(new Date(extended.closesAt!.getTime() + GRACE_MS + 1));
    await service.expireDueAttempts(db, clock.now());
    expect(await service.autoCloseDue(db, clock.now())).toHaveLength(0);
    expect((await reload(db, seed.evaluationId)).state).toBe("running");
    expect((await service.attemptById(db, accommodated!.id))!.state).toBe("in_progress");
    expect((await service.attemptById(db, ordinary!.id))!.state).toBe("expired");

    // Once the last deadline plus the grace has passed, it closes.
    clock.set(new Date(both[0]!.deadlineAt!.getTime() + GRACE_MS + 1));
    await service.expireDueAttempts(db, clock.now());
    expect(await service.autoCloseDue(db, clock.now())).toHaveLength(1);
    expect((await reload(db, seed.evaluationId)).state).toBe("closed");
  });

  it("closing the evaluation expires every open attempt", async () => {
    const { evaluation, attempt } = await running();
    const closed = await service.closeEvaluation(db, evaluation, clock.now());
    expect(closed.state).toBe("closed");
    const row = (await service.attemptById(db, attempt.id))!;
    expect(row.state).toBe("expired");
    expect(row.closedBy).toBe("teacher");
  });

  it("closes and reopens ONE attempt without touching the others", async () => {
    const { evaluation, attempt } = await running();
    const closed = await service.closeAttempt(db, evaluation, attempt, clock.now());
    expect(closed.state).toBe("expired");
    clock.advance(60_000);
    const reopened = await service.reopenAttempt(db, evaluation, closed, clock.now());
    expect(reopened.state).toBe("in_progress");
    // The clock restarts from the ORIGINAL start, not from the reopening.
    expect(reopened.deadlineAt!.getTime()).toBe(attempt.deadlineAt!.getTime());
  });
});

describe("restoring an attempt (F-LIVE-06)", () => {
  it("gives back the answers, the position and a stable item order", async () => {
    const { evaluation, attempt, items } = await running({
      questions: 3,
      settings: { shuffleItems: true },
    });
    await service.saveAnswer(db, {
      evaluation,
      attempt,
      itemId: items[2]!.id,
      payload: "kept",
      revision: 4,
      now: clock.now(),
    });
    await service.setPosition(db, attempt, items[2]!.id, clock.now());

    const reloaded = (await service.attemptById(db, attempt.id))!;
    const first = await service.attemptView(db, evaluation, reloaded, clock.now());
    const second = await service.attemptView(db, evaluation, reloaded, clock.now());
    expect(first.items.map((i) => i.id)).toEqual(second.items.map((i) => i.id));
    expect(first.attempt.lastItemId).toBe(items[2]!.id);
    const restored = first.items.find((i) => i.id === items[2]!.id)!;
    expect(restored.answer).toBe("kept");
    expect(restored.revision).toBe(4);
    // `position` stays the canonical order even when the view is shuffled.
    expect([...first.items].map((i) => i.position).sort()).toEqual([0, 1, 2]);
  });

  it("never carries the answer key into a student item (invariant 4)", async () => {
    const { evaluation, attempt } = await running({ questions: 1 });
    const view = await service.attemptView(db, evaluation, attempt, clock.now());
    expect(JSON.stringify(view.items)).not.toContain("answer-q0");
  });
});

describe("running code (POST /attempts/:id/run)", () => {
  async function codeAttempt(
    cases: { name: string; args?: string[]; expected: string; visible: boolean }[] = [
      { name: "visible-1", expected: "ok", visible: true },
      { name: "hidden-1", expected: "secret-expected", visible: false },
    ],
    compare?: { ignoreCase: boolean },
  ) {
    const seed = await seedLive(db, { questions: 0 });
    const draft = await reload(db, seed.evaluationId);
    const { createQuestion, putDraft, publishQuestion } = await import("../pool/service.js");
    const questionId = await createQuestion(db, {
      poolId: seed.poolId,
      type: "code",
      internalName: "runnable",
      createdBy: seed.teacherId,
    });
    const [question] = await db
      .select()
      .from((await import("../../db/schema.js")).questions)
      .where(eq((await import("../../db/schema.js")).questions.id, questionId));
    await putDraft(db, question!, {
      config: {
        template: "int main(){}",
        runsPerMinute: 2,
        cases,
        ...(compare === undefined ? {} : { compare }),
      },
    });
    await publishQuestion(db, question!, { userId: seed.teacherId });
    const { addItems } = await import("../evaluation/service.js");
    const { loadConfig, typeOf } = await import("../pool/config.js");
    // The item goes in while the evaluation is a draft: an opened one has a
    // frozen list (issue #79).
    await addItems(
      db,
      draft,
      [questionId],
      (type, version) =>
        typeOf(type).defaultPoints(
          loadConfig(type, { config: version.config, configVersion: version.configVersion }),
        ),
      { attemptCount: 0 },
    );
    const row = await applyState(db, draft, "running", clock.now());
    const participant = (await service.participantOf(db, row, seed.studentIds[0]!))!;
    const created = await service.ensureAttempt(db, row, participant, clock.now());
    const attempt = await service.beginAttempt(db, row, created, participant, clock.now());
    const items = await itemRows(db, row.id);
    return { evaluation: row, attempt, itemId: items[0]!.id };
  }

  it("answers 503 runner_unavailable with the stub runner (decision D14)", async () => {
    const { evaluation, attempt, itemId } = await codeAttempt();
    await expect(
      service.runVisibleCases(db, {
        runner: new UnavailableRunner("not_configured"),
        evaluation,
        attempt,
        itemId,
        regions: ["return 0;"],
        now: clock.now(),
      }),
    ).rejects.toMatchObject({ code: "runner_unavailable", status: 503 });
  });

  it("sends only the VISIBLE cases and rate-limits per runsPerMinute", async () => {
    const { evaluation, attempt, itemId } = await codeAttempt();
    const seen: string[][] = [];
    const fakeRunner = {
      run: async (req: { cases: { name: string }[] }) => {
        seen.push(req.cases.map((c) => c.name));
        return {
          compile: { ok: true, stdout: "", stderr: "", ms: 1 },
          cases: req.cases.map(() => ({
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            ms: 1,
            timedOut: false,
            oom: false,
            truncated: false,
          })),
        };
      },
      health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
    };

    const first = await service.runVisibleCases(db, {
      runner: fakeRunner as never,
      evaluation,
      attempt,
      itemId,
      regions: ["return 0;"],
      now: clock.now(),
    });
    expect(seen[0]).toEqual(["visible-1"]);
    expect(first.result.status).toBe("ok");
    // The hidden case's expected output never reaches the student's result.
    expect(JSON.stringify(first.result)).not.toContain("secret-expected");

    await service.runVisibleCases(db, {
      runner: fakeRunner as never,
      evaluation,
      attempt,
      itemId,
      regions: ["return 0;"],
      now: clock.now(),
    });
    await expect(
      service.runVisibleCases(db, {
        runner: fakeRunner as never,
        evaluation,
        attempt,
        itemId,
        regions: ["return 0;"],
        now: clock.now(),
      }),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });

    // A minute later the budget is back: the window slides, it is not a quota.
    clock.advance(61_000);
    await expect(
      service.runVisibleCases(db, {
        runner: fakeRunner as never,
        evaluation,
        attempt,
        itemId,
        regions: ["return 0;"],
        now: clock.now(),
      }),
    ).resolves.toMatchObject({ result: { status: "ok" } });
  });

  it("journals the run before running it, and publishes the result on the student's topic", async () => {
    const { evaluation, attempt, itemId } = await codeAttempt();
    const frames: Record<string, unknown>[] = [];
    const unsubscribe = subscribe((message: BusMessage) => {
      if (message.kind !== "data" || message.event.type !== "runner.result") return;
      frames.push({ ...message.event, audience: message.audience, topics: message.topics });
    });
    try {
      const { requestId, result } = await service.runVisibleCases(db, {
        runner: recorder().runner,
        evaluation,
        attempt,
        itemId,
        regions: ["return 0;"],
        now: clock.now(),
      });
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ requestId, itemId, result });
      // A runner that is down still costs a run: the journal row comes first.
      await expect(
        service.runVisibleCases(db, {
          runner: new UnavailableRunner("not_configured"),
          evaluation,
          attempt,
          itemId,
          regions: ["return 0;"],
          now: clock.now(),
        }),
      ).rejects.toMatchObject({ code: "runner_unavailable" });
      expect(frames).toHaveLength(1);
      const journal = await db
        .select()
        .from(attemptEvents)
        .where(eq(attemptEvents.attemptId, attempt.id));
      expect(journal.map((e) => e.kind)).toEqual(["run", "run"]);
      expect(journal[0]!.details).toEqual({ itemId, requestId });
      expect(Object.keys(journal[1]!.details as object).sort()).toEqual(["itemId", "requestId"]);
    } finally {
      unsubscribe();
    }
  });

  /** A recording runner: it answers nothing useful, it remembers the request. */
  function recorder(): {
    requests: { cases: { name: string; args: string[]; stdin: string }[] }[];
    runner: never;
  } {
    const requests: { cases: { name: string; args: string[]; stdin: string }[] }[] = [];
    const runner = {
      run: async (req: { cases: { name: string; args: string[]; stdin: string }[] }) => {
        requests.push({ cases: req.cases });
        return {
          compile: { ok: true, stdout: "", stderr: "", ms: 1 },
          cases: req.cases.map(() => ({
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            ms: 1,
            timedOut: false,
            oom: false,
            truncated: false,
          })),
        };
      },
      health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
    };
    return { requests, runner: runner as never };
  }

  it("keeps the command line the TEACHER wrote on a visible case", async () => {
    const { evaluation, attempt, itemId } = await codeAttempt([
      { name: "visible-1", args: ["3", "4"], expected: "ok", visible: true },
      { name: "hidden-1", args: ["--secret-arg"], expected: "secret-expected", visible: false },
    ]);
    const { requests, runner } = recorder();
    const result = await service.runVisibleCases(db, {
      runner,
      evaluation,
      attempt,
      itemId,
      regions: ["return 0;"],
      // A command line in the body is for the free-stdin try only; it must not
      // touch a visible case.
      args: ["99"],
      now: clock.now(),
    });
    expect(requests[0]?.cases).toEqual([{ name: "visible-1", args: ["3", "4"], stdin: "" }]);
    expect(result.result.status).toBe("ok");
    // The hidden case's command line is as much of the key as its stdin is.
    expect(JSON.stringify(requests)).not.toContain("--secret-arg");
  });

  it("gives the free-stdin try the command line the body asked for", async () => {
    const { evaluation, attempt, itemId } = await codeAttempt();
    const { requests, runner } = recorder();
    await service.runVisibleCases(db, {
      runner,
      evaluation,
      attempt,
      itemId,
      regions: ["return 0;"],
      stdin: "7\n",
      args: ["a b", "x;y"],
      now: clock.now(),
    });
    expect(requests[0]?.cases).toEqual([
      { name: "stdin", args: ["a b", "x;y"], stdin: "7\n" },
    ]);

    // And nothing at all when the body says nothing.
    const plain = recorder();
    await service.runVisibleCases(db, {
      runner: plain.runner,
      evaluation,
      attempt,
      itemId,
      regions: ["return 0;"],
      stdin: "7\n",
      now: clock.now(),
    });
    expect(plain.requests[0]?.cases).toEqual([{ name: "stdin", args: [], stdin: "7\n" }]);
  });

  it("compiles without running anything when the body asks for compileOnly", async () => {
    const { evaluation, attempt, itemId } = await codeAttempt();
    const seen: { action: string; cases: unknown[] }[] = [];
    const runner = {
      run: async (req: { action: string; cases: unknown[] }) => {
        seen.push({ action: req.action, cases: req.cases });
        return { compile: { ok: false, stdout: "", stderr: "main.c:1: error", ms: 1 }, cases: [] };
      },
      health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
    } as never;
    const base = { runner, evaluation, attempt, itemId, regions: ["return 0;"] };
    const { requestId, result } = await service.runVisibleCases(db, {
      ...base,
      // Ignored: a compilation has no case to feed.
      stdin: "7\n",
      compileOnly: true,
      now: clock.now(),
    });
    expect(seen).toEqual([{ action: "check", cases: [] }]);
    expect(result).toEqual({
      status: "ok",
      compile: { ok: false, stderr: "main.c:1: error" },
      cases: [],
    });
    // Same journal, same budget: a compilation is a `run` event…
    const journal = await db
      .select()
      .from(attemptEvents)
      .where(eq(attemptEvents.attemptId, attempt.id));
    expect(journal.map((e) => e.details)).toEqual([{ itemId, requestId, compileOnly: true }]);
    // …so with `runsPerMinute: 2`, one more and the next run is refused.
    await service.runVisibleCases(db, { ...base, compileOnly: true, now: clock.now() });
    await expect(
      service.runVisibleCases(db, { ...base, now: clock.now() }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  /** A runner that answers every case with the same run. */
  function answering(run: Partial<RunnerOutcome["cases"][number]>): never {
    return {
      run: async (req: { cases: unknown[] }) => ({
        compile: { ok: true, stdout: "", stderr: "", ms: 1 },
        cases: req.cases.map(() => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          ms: 1,
          timedOut: false,
          oom: false,
          truncated: false,
          ...run,
        })),
      }),
      health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
    } as never;
  }

  /**
   * Audit R-06: the run route judges a visible case by the grade's own rule
   * (`caseVerdict`), with the teacher's comparison options, and a case that
   * ran out of memory fails even when it printed the right thing.
   */
  it("judges a visible case with the teacher's comparison options (R-06)", async () => {
    const cases = [{ name: "visible-1", expected: "OK", visible: true }];
    const strict = await codeAttempt(cases);
    const tolerant = await codeAttempt(cases, { ignoreCase: true });
    const input = { regions: ["return 0;"], now: clock.now() };
    const strictRun = await service.runVisibleCases(db, {
      ...strict,
      ...input,
      runner: answering({ stdout: "ok" }),
    });
    const tolerantRun = await service.runVisibleCases(db, {
      ...tolerant,
      ...input,
      runner: answering({ stdout: "ok" }),
    });
    const okOf = (r: typeof strictRun) => (r.result.status === "ok" ? r.result.cases[0]?.ok : null);
    expect(okOf(strictRun)).toBe(false);
    expect(okOf(tolerantRun)).toBe(true);
  });

  it("fails a case that ran out of memory, whatever it printed (R-06)", async () => {
    const { evaluation, attempt, itemId } = await codeAttempt();
    const { result } = await service.runVisibleCases(db, {
      runner: answering({ stdout: "ok", oom: true }),
      evaluation,
      attempt,
      itemId,
      regions: ["return 0;"],
      now: clock.now(),
    });
    expect(result.status === "ok" && result.cases[0]).toMatchObject({ ok: false, oom: true });
  });
});

describe("dashboard read model (F-DASH-01..04)", () => {
  it("is a grid of attempts by items, with pseudonyms and cell status", async () => {
    const { evaluation, attempt, items, seed } = await running({ students: 2, questions: 2 });
    await service.saveAnswer(db, {
      evaluation,
      attempt,
      itemId: items[0]!.id,
      payload: "typed",
      revision: 1,
      now: clock.now(),
    });
    await service.markDone(db, {
      evaluation,
      attempt,
      itemId: items[0]!.id,
      done: true,
      now: clock.now(),
    });

    const view = await service.dashboardView(db, evaluation, {
      now: clock.now(),
      includeAnswers: false,
      includeResults: false,
    });
    expect(view.rows).toHaveLength(2);
    expect(view.items).toHaveLength(2);
    const mine = view.rows.find((r) => r.userId === seed.studentIds[0]!)!;
    expect(mine.state).toBe("in_progress");
    expect(mine.cells.find((c) => c.itemId === items[0]!.id)!.status).toBe("done");
    expect(mine.cells.find((c) => c.itemId === items[1]!.id)!.status).toBe("empty");
    // Decision D20: a stable pseudonym per row, never the empty string.
    expect(mine.pseudonym).toMatch(/^\w+ \w+/);
    // No answer content unless it was asked for (F-DASH-02).
    expect(mine.cells.every((c) => c.summary === null)).toBe(true);

    const withAnswers = await service.dashboardView(db, evaluation, {
      now: clock.now(),
      includeAnswers: true,
      includeResults: false,
    });
    const cell = withAnswers.rows
      .find((r) => r.userId === seed.studentIds[0]!)!
      .cells.find((c) => c.itemId === items[0]!.id)!;
    expect(cell.summary).toContain("typed");
  });
});

describe("the teacher preview (§4.3)", () => {
  it("is a student view with no attempt row anywhere", async () => {
    const seed = await seedLive(db, { questions: 2 });
    const row = await reload(db, seed.evaluationId);
    const view = await service.previewView(db, row, clock.now());
    expect(view.attempt.preview).toBe(true);
    expect(view.attempt.id).toBe(service.PREVIEW_ATTEMPT_ID);
    expect(view.items).toHaveLength(2);
    expect(JSON.stringify(view.items)).not.toContain("answer-q0");
    const stored = await db.select().from(attempts).where(eq(attempts.evaluationId, row.id));
    expect(stored).toHaveLength(0);
    // Seed 0: two previews of the same evaluation are identical.
    const again = await service.previewView(db, row, clock.now());
    expect(again.items.map((i) => i.id)).toEqual(view.items.map((i) => i.id));
  });

  it("is the attempt view of a seed-0 attempt with no answer, byte for byte but the header", async () => {
    const { evaluation, attempt } = await running({
      questions: 3,
      settings: { shuffleItems: true, navigation: "forward_only" },
    });
    await db.update(attempts).set({ seed: 0 }).where(eq(attempts.id, attempt.id));
    const zero = { ...attempt, seed: 0 };
    const student = await service.attemptView(db, evaluation, zero, clock.now());
    const preview = await service.previewView(db, evaluation, clock.now());
    expect(JSON.stringify(preview.evaluation)).toBe(JSON.stringify(student.evaluation));
    expect(JSON.stringify(preview.items)).toBe(JSON.stringify(student.items));
    expect(student.attempt).toEqual({
      id: attempt.id,
      state: "in_progress",
      startedAt: attempt.startedAt!.toISOString(),
      deadlineAt: attempt.deadlineAt?.toISOString() ?? null,
      lastItemId: attempt.lastItemId,
      serverNow: clock.now().toISOString(),
      preview: false,
      readOnly: false,
    });
    expect(preview.attempt).toEqual({
      id: service.PREVIEW_ATTEMPT_ID,
      state: "in_progress",
      startedAt: clock.now().toISOString(),
      deadlineAt: null,
      lastItemId: null,
      serverNow: clock.now().toISOString(),
      preview: true,
      readOnly: false,
    });
  });
});

describe("settings round trip", () => {
  it("reads the stored jsonb through the contract schema, defaults included", async () => {
    const seed = await seedLive(db, { settings: { navigation: "forward_only" } });
    const row = await reload(db, seed.evaluationId);
    const settings = settingsOf(row);
    expect(settings.navigation).toBe("forward_only");
    expect(settings.presentation).toBe("zen");
    expect(settings.shuffleChoices).toBe(true);
  });
});

describe("the lobby tick (step 3)", () => {
  afterEach(() => presence.reset());

  it("starts an auto lobby once every student is present, never a manual or unset one", async () => {
    const auto = await seedLive(db, { settings: { lobby: "auto" } });
    const manual = await seedLive(db, { settings: { lobby: "manual" } });
    // No `lobby` key at all: the default, "manual", is what the SQL predicate
    // of the tick must read too.
    const unset = await seedLive(db, { settings: { lobby: "auto" } });
    await db
      .update(evaluations)
      .set({ settings: sql`${evaluations.settings} - 'lobby'` })
      .where(eq(evaluations.id, unset.evaluationId));
    const [stored] = await db.select().from(evaluations).where(eq(evaluations.id, unset.evaluationId));
    expect(Object.keys(stored!.settings as object)).not.toContain("lobby");
    for (const seed of [auto, manual, unset]) {
      await applyState(db, await reload(db, seed.evaluationId), "lobby", clock.now());
    }
    const ours = new Set([auto.evaluationId, manual.evaluationId, unset.evaluationId]);
    const tick = async () =>
      (await service.autoStartFullLobbies(db, clock.now()))
        .map((row) => row.id)
        .filter((id) => ours.has(id));

    // Nobody in the room, then half of it: nothing starts.
    expect(await tick()).toEqual([]);
    presence.join(auto.evaluationId, auto.studentIds[0]!, clock.now());
    for (const seed of [manual, unset]) {
      for (const id of seed.studentIds) presence.join(seed.evaluationId, id, clock.now());
    }
    expect(await tick()).toEqual([]);

    // The whole class of the auto lobby: it starts; the full manual one and
    // the full one without the key wait.
    for (const id of auto.studentIds) presence.join(auto.evaluationId, id, clock.now());
    expect(await tick()).toEqual([auto.evaluationId]);
    expect((await reload(db, auto.evaluationId)).state).toBe("running");
    expect((await reload(db, manual.evaluationId)).state).toBe("lobby");
    expect((await reload(db, unset.evaluationId)).state).toBe("lobby");
  });
});
