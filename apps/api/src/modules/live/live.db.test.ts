/**
 * The `live` module against the real migrations (PLAN-MVP §8, WP5).
 *
 * Every instant in this file comes from a {@link TestClock}: the deadline
 * boundary, the three-second grace and the pause shift are asserted by MOVING
 * the clock, never by waiting for it. That is the whole point of taking `now`
 * as a parameter (invariant 5).
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GRACE_MS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { TestClock } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers, attempts, evaluations } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { UnavailableRunner } from "../runner/unavailable.js";
import { applyState, itemRows, settingsOf } from "../evaluation/service.js";
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
  async function codeAttempt() {
    const seed = await seedLive(db, { questions: 0 });
    const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
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
        cases: [
          { name: "visible-1", expected: "ok", visible: true },
          { name: "hidden-1", expected: "secret-expected", visible: false },
        ],
      },
    });
    await publishQuestion(db, question!, { userId: seed.teacherId });
    const { addItems } = await import("../evaluation/service.js");
    const { loadConfig, typeOf } = await import("../pool/config.js");
    await addItems(
      db,
      row,
      [questionId],
      (type, version) =>
        typeOf(type).defaultPoints(
          loadConfig(type, { config: version.config, configVersion: version.configVersion }),
        ),
      { attemptCount: 0 },
    );
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
