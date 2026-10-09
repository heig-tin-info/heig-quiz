/**
 * The integrity journal (ADR-088) against the real migrations: who may write
 * it, its default by mode, its deletion at the release in the release's
 * transaction, the six-month backstop of the scheduled catalog, and the
 * one-off migration that dropped what a switched-off evaluation had stored.
 *
 * What it pins above all: only `INTEGRITY_EVENT_KINDS` ever go. `run` rows
 * carry the Run rate limit, and the sitting's own history (`reconnect`,
 * `ip_change`, `time_added`, `paused`, `resumed`) stays.
 */
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AttemptEventKind, type EvaluationMode, type EvaluationSettings } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { attemptEvents, evaluations } from "../../db/schema.js";
import { testApp, testDatabase } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { enterStarted, reload, seedLive } from "../../test/live.js";
import { applyState, createEvaluation, settingsOf } from "../evaluation/service.js";
import * as results from "../results/service.js";
import { SCHEDULED_TASKS } from "../system/catalog.js";
import * as live from "./service.js";

const MIGRATION = new URL("../../../drizzle/0094_integrity_journal_off_purge.sql", import.meta.url);
const ALL_KINDS = AttemptEventKind.options;
const KEPT = ["reconnect", "ip_change", "time_added", "paused", "resumed", "run"];

let db: Db;
let client: PGlite;
let restore: () => void;
let app: Awaited<ReturnType<typeof testApp>>;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  ({ db, client } = await testDatabase());
  app = await testApp(db);
  app.clock.set("2026-03-02T09:00:00.000Z");
});
afterAll(() => restore());

/** A running evaluation with one student inside it, and that student's attempt. */
async function sitting(mode: EvaluationMode = "exam", settings: Partial<EvaluationSettings> = {}) {
  const seed = await seedLive(db, { students: 1, mode, settings: { timing: "manual", lobby: "skip", ...settings } });
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
  const { attempt } = await enterStarted(db, { evaluation, participant, now: app.clock.now() });
  return { seed, evaluation, attempt };
}

/** One row of every kind the journal knows, on `attemptId`. */
async function everyKind(attemptId: string): Promise<void> {
  for (const kind of ALL_KINDS) await live.logAttemptEvent(db, attemptId, kind, null, app.clock.now());
}

async function kindsOf(attemptId: string): Promise<string[]> {
  const rows = await db.select().from(attemptEvents).where(eq(attemptEvents.attemptId, attemptId));
  return rows.map((r) => r.kind).sort();
}

describe("the switch's default follows the mode (ADR-088 §2)", () => {
  it("is on for an exam and off for an exercise, whatever the preset", async () => {
    const { seed } = await sitting();
    const home = { classroomId: seed.classroomId, createdBy: seed.teacherId };
    const exam = await createEvaluation(db, { ...home, title: "E", mode: "exam" });
    const exercise = await createEvaluation(db, { ...home, title: "X", mode: "exercise" });
    const timedExercise = await createEvaluation(db, { ...home, title: "T", mode: "exercise", preset: "exam" });
    const openExam = await createEvaluation(db, { ...home, title: "O", mode: "exam", preset: "exercise" });
    expect(settingsOf(exam).logVisibility).toBe(true);
    expect(settingsOf(exercise).logVisibility).toBe(false);
    expect(settingsOf(timedExercise).logVisibility).toBe(false);
    expect(settingsOf(openExam).logVisibility).toBe(true);
  });
});

describe("what is stored (ADR-088 §3)", () => {
  it("keeps the student's own session, never a delegated one", async () => {
    const { evaluation } = await sitting("exam", { logVisibility: true });
    expect(live.storesIntegrityEvent(evaluation, { actorUserId: null })).toBe(true);
    // Somebody acting as the student (ADR-034).
    expect(live.storesIntegrityEvent(evaluation, { actorUserId: "someone" })).toBe(false);
  });
});

describe("the release deletes the integrity journal (ADR-088 §8)", () => {
  it("deletes only the listed kinds, in the release, and counts them", async () => {
    const { evaluation, attempt } = await sitting();
    await everyKind(attempt.id);
    const other = await sitting();
    await everyKind(other.attempt.id);

    const submitted = await live.submitAttempt(db, evaluation, attempt, app.clock.now());
    await live.gradeAtHandIn(app, evaluation, [submitted.id]);
    const closed = await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now(), "teacher", app);
    const released = await results.releaseResults(db, closed, app.clock.now());

    expect(released.journalPurged).toBe(3); // visibility, focus, paste
    expect(await kindsOf(attempt.id)).toEqual([...KEPT].sort());
    // Another evaluation's journal is not this release's.
    expect(await kindsOf(other.attempt.id)).toEqual([...ALL_KINDS].sort());

    // A re-release finds nothing left.
    const again = await results.releaseResults(db, await reload(db, evaluation.id), app.clock.now());
    expect(again.journalPurged).toBe(0);
  });
});

describe("the six-month backstop (ADR-088 §8)", () => {
  const task = SCHEDULED_TASKS.find((t) => t.key === "integrity.purge")!;
  const now = new Date("2026-10-09T03:00:00.000Z");

  /** A sitting closed at `closedAt`, released when asked, with every kind journalled. */
  async function closedAt(at: string, released = false) {
    const { evaluation, attempt } = await sitting();
    await everyKind(attempt.id);
    await db
      .update(evaluations)
      .set({ state: released ? "released" : "closed", closedAt: new Date(at), releasedAt: released ? new Date(at) : null })
      .where(eq(evaluations.id, evaluation.id));
    return attempt.id;
  }

  it("deletes the journal of an evaluation closed six months ago and never released", async () => {
    expect(task.defaultIntervalMinutes).toBe(24 * 60);
    const old = await closedAt("2026-04-08T03:00:00.000Z");
    const recent = await closedAt("2026-04-10T03:00:00.000Z");
    const releasedOld = await closedAt("2026-01-01T00:00:00.000Z", true);
    const stillRunning = (await sitting()).attempt.id;
    await everyKind(stillRunning);

    const message = await task.run({ db, clock: { now: () => now } } as unknown as FastifyInstance, {} as AppConfig);

    expect(message).toMatch(/integrity journal rows deleted$/);
    expect(await kindsOf(old)).toEqual([...KEPT].sort());
    expect(await kindsOf(recent)).toEqual([...ALL_KINDS].sort());
    // A released evaluation lost its journal at the release; its rows here
    // stand for any written since, which are not the backstop's to judge.
    expect(await kindsOf(releasedOld)).toEqual([...ALL_KINDS].sort());
    expect(await kindsOf(stillRunning)).toEqual([...ALL_KINDS].sort());
  });
});

describe("the one-off migration (0094_integrity_journal_off_purge)", () => {
  // It predates `paste`: no paste row existed then, and it names none.
  it("drops the visibility and focus rows of a switched-off evaluation and of a poll, nothing else", async () => {
    const off = await sitting("exam", { logVisibility: false });
    const on = await sitting("exam", { logVisibility: true });
    const legacy = await sitting();
    const { logVisibility: _dropped, ...withoutField } = settingsOf(legacy.evaluation);
    await db.update(evaluations).set({ settings: withoutField }).where(eq(evaluations.id, legacy.evaluation.id));
    const poll = await sitting("exam", { logVisibility: true });
    await db.update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, poll.evaluation.id));
    const ids = [off, on, legacy, poll].map((s) => s.attempt.id);
    for (const id of ids) await everyKind(id);

    for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) {
      await client.exec(statement);
    }

    expect(await kindsOf(off.attempt.id)).toEqual([...KEPT, "paste"].sort());
    expect(await kindsOf(poll.attempt.id)).toEqual([...KEPT, "paste"].sort());
    expect(await kindsOf(on.attempt.id)).toEqual([...ALL_KINDS].sort());
    expect(await kindsOf(legacy.attempt.id)).toEqual([...ALL_KINDS].sort());
    expect(await db.select().from(attemptEvents).where(inArray(attemptEvents.attemptId, ids))).toHaveLength(
      ids.length * ALL_KINDS.length - 4,
    );
  });
});
