/**
 * Results, CSV and student feedback against the real migrations (PLAN-MVP §8,
 * WP6).
 *
 * The grade table is checked against the fixtures of §7.1 through the WHOLE
 * chain — points in `gradings`, scale in `evaluations.grading_scale`,
 * conversion in `@quiz/domain` — rather than against `gradeFromPoints` alone,
 * which `packages/domain` already covers.
 */
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { RunnerOutcome, RunnerService } from "@quiz/core/server";
import type { ReleasedGrades } from "@quiz/contracts";
import { codeServer } from "@quiz/qt-code/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { evaluationItems, evaluations, gradings, notifications } from "../../db/schema.js";
import { testApp, testDatabase } from "../../test/db.js";
import { seedCodeEvaluation } from "../../test/codeFixture.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { evaluationRows } from "../../test/grades.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, isLegalTransition, joinedItems } from "../evaluation/service.js";
import { runEvaluationGrading } from "../grading/jobs.js";
import * as grading from "../grading/service.js";
import * as live from "../live/service.js";
import { listNotifications } from "../notifications/service.js";
import { BOM, resultsCsv } from "./csv.js";
import * as service from "./service.js";

let client: PGlite;
let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  ({ db, client } = await testDatabase());
});
afterAll(() => restore());

async function appFor() {
  const app = await testApp(db);
  app.clock.set("2026-09-20T09:00:00.000Z");
  return app;
}

/** The rows of the student's Grades page (`GET /student/results`), every classroom's. */
async function gradeRows(studentId: string, now: Date) {
  return evaluationRows(await live.studentGrades(db, studentId, now));
}

/**
 * A closed evaluation worth `total` points spread over one item, with two
 * students: the first has an attempt, the second never showed up.
 */
async function evaluationWorth(total: number) {
  const app = await appFor();
  const seed = await seedLive(db, { students: 2, questions: 1 });
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const items = await joinedItems(db, evaluation.id);
  await db
    .update(evaluationItems)
    .set({ points: total })
    .where(eq(evaluationItems.id, items[0]!.item.id));

  const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
  const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
  const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
  evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());
  return { app, seed, evaluation, itemId: items[0]!.item.id, attempt };
}

/** Puts exactly `points` on the single item of the evaluation. */
async function award(
  app: Awaited<ReturnType<typeof appFor>>,
  built: Awaited<ReturnType<typeof evaluationWorth>>,
  points: number,
  details: unknown = { manual: true },
) {
  await grading.writeGrading(db, {
    attemptId: built.attempt.id,
    itemId: built.itemId,
    answerId: null,
    points,
    maxPoints: (await joinedItems(db, built.evaluation.id))[0]!.item.points,
    source: "manual",
    state: "validated",
    details,
    comment: "teacher note",
    now: app.clock.now(),
  });
}

describe("the grade table (§7.1, F-RES-01)", () => {
  it("converts points to the Swiss scale, with the evaluation's rounding", async () => {
    const built = await evaluationWorth(7);
    await award(built.app, built, 3);

    const nearest = await service.resultsView(db, await reload(db, built.evaluation.id));
    expect(nearest.totalPoints).toBe(7);
    // 3 / 7 -> 1 + 5 * 0.428… = 3.14…
    expect(nearest.rows.find((r) => r.attemptId !== null)!.grade).toBe(3.1);

    await db
      .update(evaluations)
      .set({ gradingScale: { kind: "linear", rounding: "up" } })
      .where(eq(evaluations.id, built.evaluation.id));
    const up = await service.resultsView(db, await reload(db, built.evaluation.id));
    expect(up.rows.find((r) => r.attemptId !== null)!.grade).toBe(3.2);
  });

  it("gives the absent student a row, zero points and a 1.0", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 20);

    const view = await service.resultsView(db, await reload(db, built.evaluation.id));
    expect(view.rows).toHaveLength(2);
    const absent = view.rows.find((r) => r.attemptId === null)!;
    expect(absent.state).toBe("absent");
    expect(absent.points).toBe(0);
    expect(absent.grade).toBe(1);
    expect(view.rows.find((r) => r.attemptId !== null)!.grade).toBe(6);
    // Both rows count in the statistics.
    expect(view.stats.count).toBe(2);
    expect(view.stats.min).toBe(1);
    expect(view.stats.max).toBe(6);
    expect(view.stats.histogram.at(-1)).toEqual({ bucket: 6, count: 1 });
  });
});

describe("the CSV export (F-RES-02)", () => {
  it("starts with a UTF-8 BOM, separates with ';' and carries every student", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 12);
    const view = await service.resultsView(db, await reload(db, built.evaluation.id));
    const csv = resultsCsv(view);

    const bytes = Buffer.from(csv, "utf8");
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.startsWith(BOM)).toBe(true);

    const lines = csv.slice(BOM.length).trimEnd().split("\r\n");
    expect(lines[0]!.split(";").slice(0, 3)).toEqual(["email", "last_name", "first_name"]);
    expect(lines[0]!.endsWith(";total;grade")).toBe(true);
    // Header, plus one row per student — the absent one included.
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.endsWith(";12;4.0"))).toBe(true);
    expect(lines.some((l) => l.endsWith(";;0;1.0"))).toBe(true);
    expect(csv.includes(",")).toBe(false);
  });
});

describe("release (F-RES-04, F-GRADE-09)", () => {
  it("freezes the grades once and stays idempotent", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 10);

    const first = await service.releaseResults(
      db,
      await reload(db, built.evaluation.id),
      built.app.clock.now(),
    );
    const stored = await reload(db, built.evaluation.id);
    expect(stored.state).toBe("released");
    expect(stored.releasedGrades).toMatchObject({ totalPoints: 20 });

    built.app.clock.advance(3_600_000);
    const second = await service.releaseResults(
      db,
      stored,
      built.app.clock.now(),
    );
    // The date the students were told about does not move.
    expect(second.releasedAt.toISOString()).toBe(first.releasedAt.toISOString());
    expect(second.rows).toBe(first.rows);

    await service.unreleaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    const withdrawn = await reload(db, built.evaluation.id);
    expect(withdrawn.releasedAt).toBeNull();
    expect(withdrawn.releasedGrades).toBeNull();
    expect(withdrawn.state).toBe("closed");
    // Finding L7: the withdrawal goes through the state table like every
    // other move, instead of writing `closed` behind its back.
    expect(isLegalTransition("released", "closed")).toBe(true);
  });

  it("tells the students who sat it, once, with ids and a title only, and withdraws the bell", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 10);
    const [present, absent] = built.seed.studentIds as [string, string];

    await service.releaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    const inbox = await listNotifications(db, present);
    const told = inbox.items.filter((n) => n.payload.kind === "results_released");
    expect(told.map((n) => n.payload)).toEqual([
      {
        kind: "results_released",
        evaluationId: built.evaluation.id,
        evaluationTitle: built.evaluation.title,
        attemptId: built.attempt.id,
      },
    ]);
    // No grade, no points: the payload leaves the platform by e-mail too.
    expect(JSON.stringify(told)).not.toMatch(/grade|points/i);
    // The student who never showed up has no feedback page to be sent to.
    expect((await listNotifications(db, absent)).items).toHaveLength(0);

    // A re-release keeps the original date, and tells nobody again.
    await service.releaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    expect(
      (await listNotifications(db, present)).items.filter((n) => n.payload.kind === "results_released"),
    ).toHaveLength(1);

    // Withdrawn: the bell would open a page that shows nothing.
    await service.unreleaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    const left = await db
      .select()
      .from(notifications)
      .where(eq(notifications.evaluationId, built.evaluation.id));
    expect(left).toHaveLength(0);
  });

  it("refuses to release an evaluation that is still running", async () => {
    const app = await appFor();
    const seed = await seedLive(db, { students: 1, questions: 1 });
    const running = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
    await expect(service.releaseResults(db, running, app.clock.now())).rejects.toThrow(
      service.NotReleasable,
    );
  });
});

describe("student feedback (F-RES-04, docs/05 §5.7)", () => {
  it("shows nothing at all before the release", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 20);
    const attempt = (await live.attemptById(db, built.attempt.id))!;

    const before = await service.studentFeedback(
      db,
      await reload(db, built.evaluation.id),
      attempt,
      built.app.clock.now(),
    );
    expect(before).toEqual({
      available: false,
      reason: "results_pending",
      evaluation: { id: built.evaluation.id, title: built.evaluation.title },
    });
    // No question content, no points, no key: the payload is three fields.
    expect(JSON.stringify(before)).not.toContain("answer-q0");
  });

  it("applies the policy field by field once released", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 20);
    await service.releaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    const attempt = (await live.attemptById(db, built.attempt.id))!;

    // The default policy: the answer yes, the key no, no explanation.
    const closed = await service.studentFeedback(
      db,
      await reload(db, built.evaluation.id),
      attempt,
      built.app.clock.now(),
    );
    expect(closed.available).toBe(true);
    if (!closed.available) throw new Error("unreachable");
    expect(closed.grade).toBe(6);
    expect(closed.points).toBe(20);
    expect(closed.items[0]!.solution).toBeNull();
    expect(closed.items[0]!.explanation).toBeNull();
    expect(closed.items[0]!.comment).toBe("teacher note");
    expect(JSON.stringify(closed)).not.toContain("answer-q0");

    await db
      .update(evaluations)
      .set({
        feedbackPolicy: {
          when: "on_release",
          showAnswer: true,
          showKey: true,
          showExplanation: true,
          showHiddenCaseNames: true,
          showTeacherComment: false,
        },
      })
      .where(eq(evaluations.id, built.evaluation.id));
    const open = await service.studentFeedback(db, await reload(db, built.evaluation.id), attempt, built.app.clock.now());
    if (!open.available) throw new Error("unreachable");
    expect(open.items[0]!.solution).toMatchObject({ answer: "answer-q0" });
    expect(open.items[0]!.comment).toBeNull();

    await db
      .update(evaluations)
      .set({
        feedbackPolicy: {
          when: "none",
          showAnswer: true,
          showKey: true,
          showExplanation: true,
          showHiddenCaseNames: true,
          showTeacherComment: true,
        },
      })
      .where(eq(evaluations.id, built.evaluation.id));
    const silent = await service.studentFeedback(
      db,
      await reload(db, built.evaluation.id),
      attempt,
      built.app.clock.now(),
    );
    expect(silent).toMatchObject({ available: false, reason: "no_feedback" });
  });
});

describe("`released_grades` is the cache of the grade (docs/01 §5, audit D-06)", () => {
  /** The frozen snapshot with the one attempt's grade replaced by `grade`. */
  async function tamper(evaluationId: string, grade: number) {
    const stored = await reload(db, evaluationId);
    const snapshot = stored.releasedGrades as ReleasedGrades;
    await db
      .update(evaluations)
      .set({
        releasedGrades: {
          ...snapshot,
          rows: snapshot.rows.map((r) => (r.attemptId === null ? r : { ...r, grade })),
        },
      })
      .where(eq(evaluations.id, evaluationId));
  }

  async function studentGrades(built: Awaited<ReturnType<typeof evaluationWorth>>) {
    const evaluation = await reload(db, built.evaluation.id);
    const studentId = built.seed.studentIds[0]!;
    const attempt = (await live.attemptById(db, built.attempt.id))!;
    const feedback = await service.studentFeedback(db, evaluation, attempt, built.app.clock.now());
    if (!feedback.available) throw new Error("unreachable");
    const [card] = await gradeRows(studentId, built.app.clock.now());
    const home = await live.studentHome(db, studentId, built.app.clock.now());
    return {
      feedback: feedback.grade,
      card: card!.score!.grade,
      home: home.past.find((c) => c.id === built.evaluation.id)!.grade,
    };
  }

  it("serves the frozen grade while nothing changed since the release", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 10);
    await service.releaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    expect(await studentGrades(built)).toEqual({ feedback: 3.5, card: 3.5, home: 3.5 });

    // A snapshot that says something else than the gradings is what the
    // three student surfaces show: they read it, they do not recompute.
    await tamper(built.evaluation.id, 5.5);
    expect(await studentGrades(built)).toEqual({ feedback: 5.5, card: 5.5, home: 5.5 });
  });

  it("falls through to the gradings once a correction landed after the release", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 10);
    await service.releaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    await tamper(built.evaluation.id, 5.5);

    // F-GRADE-09: the correction reaches the students at once.
    await award(built.app, built, 20);
    await service.markModifiedAfterRelease(
      db,
      await reload(db, built.evaluation.id),
      built.app.clock.now(),
    );
    expect(await studentGrades(built)).toEqual({ feedback: 6, card: 6, home: 6 });

    // Re-releasing refreezes the snapshot and the cache serves it again.
    await service.releaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    const stored = await reload(db, built.evaluation.id);
    expect(stored.modifiedAfterRelease).toBe(false);
    expect(await studentGrades(built)).toEqual({ feedback: 6, card: 6, home: 6 });
  });
});

describe("every validated write after the release raises the flag (D-06 review)", () => {
  it("flips `modified_after_release` from inside `writeGradings`, so the card shows the live grade", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 10);
    await service.releaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    expect((await reload(db, built.evaluation.id)).modifiedAfterRelease).toBe(false);

    // The batched writer itself, with no `markModifiedAfterRelease` after it:
    // the grading pass and the runner job call nothing else.
    await grading.writeGradings(db, [
      {
        attemptId: built.attempt.id,
        itemId: built.itemId,
        answerId: null,
        points: 20,
        maxPoints: 20,
        source: "auto",
        state: "validated",
        now: built.app.clock.now(),
      },
    ]);
    expect((await reload(db, built.evaluation.id)).modifiedAfterRelease).toBe(true);
    const [card] = await gradeRows(built.seed.studentIds[0]!, built.app.clock.now());
    expect(card!.score).toMatchObject({ points: 20, grade: 6 });
  });

  it("leaves an unreleased evaluation alone and ignores a proposal", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 10);
    expect((await reload(db, built.evaluation.id)).modifiedAfterRelease).toBe(false);

    await service.releaseResults(db, await reload(db, built.evaluation.id), built.app.clock.now());
    await grading.writeGradings(db, [
      {
        attemptId: built.attempt.id,
        itemId: built.itemId,
        answerId: null,
        points: 0,
        maxPoints: 20,
        source: "auto",
        state: "proposed",
        now: built.app.clock.now(),
      },
    ]);
    // A proposal changes no grade: the frozen snapshot is still the truth.
    expect((await reload(db, built.evaluation.id)).modifiedAfterRelease).toBe(false);
  });

  it("flips it when the runner job validates a proposal after the release", async () => {
    const restore = registerForTests(fakeRunnableCode);
    try {
      const app = await appFor();
      const fixture = await seedCodeEvaluation(db, app.clock.now());
      // Under the stub the cell ends as a proposal worth zero (D14)…
      await runEvaluationGrading(app, { evaluationId: fixture.evaluationId });
      await service.releaseResults(db, await reload(db, fixture.evaluationId), app.clock.now());
      const [frozen] = await gradeRows(fixture.studentId, app.clock.now());
      expect(frozen!.score!.grade).toBe(1);

      // …then a real runner comes back and the job validates it.
      const outcome: RunnerOutcome = {
        compile: { ok: true, stdout: "", stderr: "", ms: 1 },
        cases: [
          { exitCode: 0, stdout: "ok", stderr: "", ms: 2, timedOut: false, oom: false, truncated: false },
        ],
      };
      const runner: RunnerService = {
        run: async () => outcome,
        health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
      };
      (app as unknown as { runner: RunnerService }).runner = runner;
      app.clock.advance(60_000);
      await runEvaluationGrading(app, { evaluationId: fixture.evaluationId });

      expect((await reload(db, fixture.evaluationId)).modifiedAfterRelease).toBe(true);
      const [card] = await gradeRows(fixture.studentId, app.clock.now());
      expect(card!.score!.points).toBeGreaterThan(0);
      expect(card!.score!.grade).toBeGreaterThan(1);
    } finally {
      restore();
    }
  });
});

describe("the student's pages read in a fixed number of statements (audit D-05)", () => {
  it("draws the home and the Grades page of three released evaluations in one statement each", async () => {
    const app = await appFor();
    let studentId: string | undefined;
    const expected = new Map<string, { points: number; totalPoints: number; grade: number; pendingCount: number }>();
    // Three evaluations of three classrooms, each worth 2 × 5 points; the
    // student scores 10, 5 and 0 of them.
    for (const [i, score] of [10, 5, 0].entries()) {
      const seed = await seedLive(db, {
        questions: 2,
        ...(studentId ? { studentIds: [studentId] } : { students: 1 }),
      });
      studentId = seed.studentIds[0]!;
      let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
      const items = await joinedItems(db, evaluation.id);
      await db
        .update(evaluationItems)
        .set({ points: 5 })
        .where(eq(evaluationItems.evaluationId, evaluation.id));
      const participant = (await live.participantOf(db, evaluation, studentId))!;
      const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
      const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
      evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());
      for (const [k, item] of items.entries()) {
        await grading.writeGrading(db, {
          attemptId: attempt.id,
          itemId: item.item.id,
          answerId: null,
          points: k === 0 ? Math.min(score, 5) : Math.max(score - 5, 0),
          maxPoints: 5,
          source: "manual",
          state: "validated",
          now: app.clock.now(),
        });
      }
      await service.releaseResults(db, await reload(db, evaluation.id), app.clock.now());
      expected.set(evaluation.id, { points: score, totalPoints: 10, grade: [6, 3.5, 1][i]!, pendingCount: 0 });
      app.clock.advance(60_000);
    }

    // Every statement drizzle sends goes through the PGlite client's `query`.
    const statements = vi.spyOn(client, "query");
    try {
      // One: every row is served from `released_grades` (D-06), so the two
      // grouped queries of the live computation have nothing to read.
      const rows = await gradeRows(studentId!, app.clock.now());
      expect(statements).toHaveBeenCalledTimes(1);
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row.score).toEqual(expected.get(row.evaluationId));

      statements.mockClear();
      const home = await live.studentHome(db, studentId!, app.clock.now());
      // The same `releasedGradesOf` as the Grades page: one statement too.
      expect(statements).toHaveBeenCalledTimes(1);
      expect(new Map(home.past.map((c) => [c.id, c.grade]))).toEqual(
        new Map([...expected].map(([id, e]) => [id, e.grade])),
      );
    } finally {
      statements.mockRestore();
    }
  });
});

describe("the per-question debrief (F-RES-03, ADR-033)", () => {
  /**
   * A class of eight on one question of the fake `short` type: what each
   * student hands in (`undefined`: enters and answers nothing; `null`: never
   * shows up), graded by the real pass, then overridden where the scenario
   * says so.
   */
  async function classOf(given: readonly (string | null | undefined)[]) {
    const app = await appFor();
    const seed = await seedLive(db, { students: given.length, questions: 1 });
    let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
    const [item] = await joinedItems(db, evaluation.id);
    const attempts: (live.AttemptRecord | null)[] = [];
    for (const [index, text] of given.entries()) {
      if (text === null) {
        attempts.push(null);
        continue;
      }
      const participant = (await live.participantOf(db, evaluation, seed.studentIds[index]!))!;
      const { attempt } = await live.enterEvaluation(db, { evaluation, participant, now: app.clock.now() });
      if (text !== undefined) {
        await live.saveAnswer(db, {
          evaluation,
          attempt,
          itemId: item!.item.id,
          payload: text,
          revision: 1,
          now: app.clock.now(),
        });
      }
      attempts.push(await live.submitAttempt(db, evaluation, attempt, app.clock.now()));
    }
    evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const regrade = async (index: number, points: number, state: "validated" | "proposed") => {
      app.clock.advance(1000);
      await grading.writeGrading(db, {
        attemptId: attempts[index]!.id,
        itemId: item!.item.id,
        answerId: null,
        points,
        maxPoints: 1,
        source: "manual",
        state,
        details: { manual: true },
        comment: "override",
        now: app.clock.now(),
      });
    };
    return { app, evaluation, attempts, regrade };
  }

  it("counts the outcomes over the attempts, and judges each answer group by its gradings", async () => {
    const { evaluation, attempts, regrade } = await classOf([
      "answer-q0", // correct
      "nope", // wrong
      "nope", // wrong, then overridden to full marks: the group is mixed
      "four", // wrong
      "half", // overridden to half a point: partial
      undefined, // entered, answered nothing: blank
      "   ", // nothing that counts as an answer: blank
      "answer-q0", // only a proposal, not validated yet: counted nowhere
      null, // absent: counted nowhere
    ]);
    await regrade(2, 1, "validated");
    await regrade(4, 0.5, "validated");
    await db.delete(gradings).where(eq(gradings.attemptId, attempts[7]!.id));
    await regrade(7, 1, "proposed");

    const [q] = await service.byQuestion(db, await reload(db, evaluation.id));
    expect(q!.outcomes).toEqual({ correct: 2, partial: 1, wrong: 2, blank: 2 });
    // Over the same seven attempts: (1 + 0 + 1 + 0 + 0.5 + 0 + 0) / 7.
    expect(q!.successRate).toBe(0.36);
    // By count; groups of one tie, in the order the attempts are read, which
    // no query fixes (they share a timestamp): compared by label.
    const groups = q!.distribution.map((d) => [d.label, d.count, d.correct, d.part] as const);
    expect(groups[0]).toEqual(["nope", 2, null, null]);
    expect([...groups].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["nope", 2, null, null],
      ["answer-q0", 1, true, null],
      ["four", 1, false, null],
      ["half", 1, null, null],
    ]);
  });

  it("names a hidden test case as a student reads it, unless the policy shows hidden names", async () => {
    // The fake `code` of the fixture, with the REAL `code` aggregate: the
    // label comes from qt-code's own student filter.
    const restore = registerForTests({ ...fakeRunnableCode, aggregate: codeServer.aggregate! });
    try {
      const app = await appFor();
      const fixture = await seedCodeEvaluation(db, app.clock.now());
      const run = (name: string, visible: boolean) => ({
        name,
        visible,
        points: 1,
        ok: visible,
        exitCode: 0,
        ms: 1,
        timedOut: false,
        oom: false,
      });
      await grading.writeGrading(db, {
        attemptId: fixture.attemptId,
        itemId: fixture.itemId,
        answerId: null,
        points: 1,
        maxPoints: 2,
        source: "auto",
        state: "validated",
        details: {
          runner: "ok",
          compile: null,
          cases: [run("visible-1", true), run("hidden-overflow", false)],
          earned: 1,
          total: 2,
          sourceSha256: null,
        },
        now: app.clock.now(),
      });
      const labels = async (showHiddenCaseNames: boolean) => {
        const evaluation = await reload(db, fixture.evaluationId);
        await db
          .update(evaluations)
          .set({ feedbackPolicy: { ...(evaluation.feedbackPolicy as object), showHiddenCaseNames } })
          .where(eq(evaluations.id, fixture.evaluationId));
        const [q] = await service.byQuestion(db, await reload(db, fixture.evaluationId));
        return q!.casePassRate.map((c) => [c.name, c.label]);
      };
      // The wall reads `label`; `name` stays for the staff's own tab.
      expect(await labels(false)).toEqual([
        ["visible-1", "visible-1"],
        ["hidden-overflow", "#2"],
      ]);
      expect(await labels(true)).toEqual([
        ["visible-1", "visible-1"],
        ["hidden-overflow", "hidden-overflow"],
      ]);
    } finally {
      restore();
    }
  });

  it("is refused before the evaluation is over: a projected key would reach a student still answering", async () => {
    const app = await appFor();
    const seed = await seedLive(db, { students: 1, questions: 1 });
    const running = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
    await expect(service.byQuestion(db, running)).rejects.toMatchObject({ code: "not_over", status: 409 });
  });
});
