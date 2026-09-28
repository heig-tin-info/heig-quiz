/**
 * The notifications a user's action raises are BEST-EFFORT (ADR-030 §h,
 * #198 steps 5 to 8): when `notifyMany` fails, the publication, the grading,
 * the move of an exercise and the correction of a released grade it would
 * have announced are still written, and
 * nothing is thrown at the caller — the ticker included, and its deadline
 * scan, whose markers stay claimed (not retried).
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  attempts,
  deadlineReminders,
  evaluations,
  gradings,
  poolMembers,
  questions,
  users,
} from "../../db/schema.js";
import { seedCodeEvaluation } from "../../test/codeFixture.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { runEvaluationGrading } from "../grading/jobs.js";
import * as grading from "../grading/service.js";
import { releaseResults } from "../results/service.js";
import * as live from "../live/service.js";
import * as poolService from "../pool/service.js";
import { sendDeadlineReminders } from "./deadline.js";
import { notifyMany } from "./service.js";

vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service.js")>()),
  notifyMany: vi.fn(async () => {
    throw new Error("the outbox is down");
  }),
}));

let db: Db;
const restores: (() => void)[] = [];
const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

beforeAll(async () => {
  restores.push(registerForTests(fakeShort), registerForTests(fakeRunnableCode));
  db = await testDb();
});
afterAll(() => {
  for (const restore of restores.reverse()) restore();
  quiet.mockRestore();
});

describe("a failing notification", () => {
  it("never fails a publication: the version is written and returned", async () => {
    const seed = await seedLive(db, { students: 0, questions: 0 });
    const colleague = randomUUID();
    await db.insert(users).values({ id: colleague, oidcSub: `s-${colleague}`, email: `c-${colleague.slice(0, 8)}@heig.test`, role: "teacher" });
    await db.insert(poolMembers).values({ poolId: seed.poolId, userId: colleague, role: "owner" });
    const { id } = await poolService.createQuestion(db, {
      poolId: seed.poolId,
      type: "short",
      internalName: "best-effort",
      createdBy: seed.teacherId,
    });
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    await poolService.putDraft(db, question!, { config: { statement: "S", answer: "a" } });

    vi.mocked(notifyMany).mockClear();
    const version = await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
    expect(notifyMany).toHaveBeenCalledTimes(1);
    expect(version.number).toBe(1);
    expect((await poolService.listVersions(db, id)).map((v) => v.number)).toContain(1);
  });

  it("never fails a grading pass: its gradings are written", async () => {
    const app = await testApp(db);
    const fixture = await seedCodeEvaluation(db, app.clock.now());
    vi.mocked(notifyMany).mockClear();
    await expect(
      runEvaluationGrading(app, { evaluationId: fixture.evaluationId, announce: true }),
    ).resolves.toBeUndefined();
    const rows = await db
      .select({ state: gradings.state })
      .from(gradings)
      .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
      .where(eq(attempts.evaluationId, fixture.evaluationId));
    expect(notifyMany).toHaveBeenCalledTimes(1);
    // The stub runner leaves a proposal: exactly what grading_ready would announce.
    expect(rows).toEqual([{ state: "proposed" }]);
  });

  it("never fails the move of an exercise: scheduled, then opened by the ticker", async () => {
    const opensAt = new Date(Date.now() + 3_600_000);
    const seed = await seedLive(db, { mode: "exercise", opensAt, settings: { lobby: "skip" } });
    vi.mocked(notifyMany).mockClear();
    const scheduled = await evaluationService.transition(
      db,
      await reload(db, seed.evaluationId),
      "scheduled",
      new Date(),
    );
    expect(scheduled.state).toBe("scheduled");
    const opened = await live.autoOpenScheduled(db, new Date(opensAt.getTime() + 1000));
    expect(opened.map((r) => r.id)).toContain(seed.evaluationId);
    expect((await reload(db, seed.evaluationId)).state).toBe("running");
    // Both announcements were attempted, and both failed.
    expect(vi.mocked(notifyMany).mock.calls.map(([, d]) => d[0]?.payload.kind)).toEqual(
      expect.arrayContaining(["activity_scheduled", "activity_available"]),
    );
  });

  it("never fails the deadline scan: every evaluation is tried, and the markers stay claimed", async () => {
    const closesAt = new Date("2027-03-01T12:00:00.000Z");
    const due = new Date(closesAt.getTime() - 3_600_000);
    const seeds: Seeded[] = [];
    for (let i = 0; i < 2; i++) {
      const seed = await seedLive(db, { mode: "exercise", closesAt });
      await db
        .update(evaluations)
        .set({ state: "running", startedAt: new Date(closesAt.getTime() - 7 * 86_400_000) })
        .where(eq(evaluations.id, seed.evaluationId));
      seeds.push(seed);
    }
    vi.mocked(notifyMany).mockClear();
    const claimed = await sendDeadlineReminders(db, due);
    const told = vi.mocked(notifyMany).mock.calls.map(([, d]) => d[0]?.payload);
    for (const seed of seeds) {
      expect(claimed.filter((c) => c.evaluationId === seed.evaluationId)).toHaveLength(2);
      // The first fan-out failing did not stop the second one.
      expect(told).toContainEqual(expect.objectContaining({ evaluationId: seed.evaluationId }));
      const markers = await db
        .select()
        .from(deadlineReminders)
        .where(eq(deadlineReminders.evaluationId, seed.evaluationId));
      expect(markers).toHaveLength(2);
    }
    // Best-effort: a claimed reminder whose delivery failed is not sent again.
    vi.mocked(notifyMany).mockClear();
    const again = await sendDeadlineReminders(db, due);
    expect(again.filter((c) => seeds.some((s) => s.evaluationId === c.evaluationId))).toEqual([]);
  });

  it("never fails a correction after the release: the override is written", async () => {
    const app = await testApp(db);
    const seed = await seedLive(db, { students: 1, questions: 1 });
    let evaluation = await evaluationService.applyState(
      db,
      await reload(db, seed.evaluationId),
      "running",
      app.clock.now(),
    );
    const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());
    const [item] = await evaluationService.joinedItems(db, evaluation.id);
    const cell = { attemptId: attempt.id, itemId: item!.item.id, answerId: null, maxPoints: item!.item.points };
    await grading.manualOverride(db, cell, { points: 0, comment: "blank" }, seed.teacherId, app.clock.now());
    // The release's own `results_released` is not under test here.
    vi.mocked(notifyMany).mockResolvedValueOnce([]);
    await releaseResults(db, await reload(db, evaluation.id), app.clock.now());

    vi.mocked(notifyMany).mockClear();
    const row = await grading.manualOverride(
      db,
      cell,
      { points: item!.item.points, comment: "re-read" },
      seed.teacherId,
      app.clock.now(),
    );
    expect(vi.mocked(notifyMany).mock.calls.map(([, d]) => d[0]?.payload.kind)).toEqual([
      "results_updated",
    ]);
    const [standing] = await db.select().from(gradings).where(eq(gradings.id, row.id));
    expect(standing).toMatchObject({ state: "validated", points: item!.item.points });
  });
});
