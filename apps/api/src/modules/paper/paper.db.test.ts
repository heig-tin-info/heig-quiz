/**
 * The paper attempt (ADR-125 §9–§16, F-PAPER-01..05), over the real
 * application: every refusal of the submission; the one transaction that
 * ends and replaces a digital attempt and inserts the paper one on the paper
 * seed; its answers read through the student save's path; its grading (now
 * on a closed exam, at the close on a running one, an untyped essay
 * proposed at zero); its scan; who reaches what (invariant 6); what the
 * student reads of it (invariant 4); and the cascade of an evaluation that
 * holds a replaced attempt and its replacement (N-DATA-03).
 */
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AttemptView,
  DashboardView,
  EvaluationDetail,
  PaperItems,
  PaperSheet,
  ResultsView,
  type StaffCopy,
} from "@quiz/contracts";
import { findStudentLeaks } from "@quiz/core/testing";

import {
  answers,
  attempts,
  auditLog,
  enrollments,
  evaluations,
  gradings,
  paperSheets,
  questions,
} from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { addItems, isLatestAttempt } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { poolQuestionStats } from "../stats/service.js";
import { conflictOf, PaperError, sweepOrphanScans } from "./service.js";

const MCQ = {
  configVersion: 2,
  prompt: "Pick MCQ_PROMPT.",
  mode: "single",
  shuffleChoices: true,
  choices: [
    { text: "MCQ_KEY_CHOICE", correct: true },
    { text: "MCQ_OTHER_ONE", correct: false },
    { text: "MCQ_OTHER_TWO", correct: false },
    { text: "MCQ_OTHER_THREE", correct: false },
  ],
};
const CLOZE = { configVersion: 2, text: "CLOZE_PROMPT {{CLOZE_KEY_SECRET}} end." };
const RICH = {
  configVersion: 2,
  prompt: "Explain RICH_PROMPT.",
  rubric: "- 2 pts: RICH_RUBRIC_SECRET",
  reference: "RICH_REFERENCE_SECRET",
  maxChars: 3000,
  format: "markdown",
};
const CODE = {
  configVersion: 1,
  prompt: "Return CODE_PROMPT.",
  language: "c",
  runtime: "backend",
  template: "int main(void) { return 0; }\n",
  referenceSolution: "int main(void) { return 1; }",
  tests: { mode: "io", cases: [{ name: "one", stdin: "", expected: "", visible: true, points: 1 }] },
};
const SECRETS = ["CLOZE_KEY_SECRET", "RICH_RUBRIC_SECRET", "RICH_REFERENCE_SECRET", "EXPLANATION_SECRET", "INTERNAL_NAME"];

/** The smallest PDF and PNG the sniffer accepts. */
const PDF = Buffer.from("%PDF-1.4\n%paper scan\n%%EOF\n", "latin1");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
]);

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let other: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
let second: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  server = await testServer({ PAPER_SCAN_MAX_BYTES: "4096" });
  teacher = await server.signIn("teacher");
  other = await server.signIn("teacher");
  student = await server.signIn("student");
  second = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
});

const db = () => server.app.db;
const now = () => server.clock.now();
const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload: unknown) =>
  server.app.inject({ method: "POST", url, headers, payload: payload as object });

async function publish(poolId: string, type: string, config: unknown): Promise<string> {
  const { id } = await poolService.createQuestion(db(), {
    poolId,
    type,
    internalName: `INTERNAL_NAME_${type}`,
    createdBy: teacher.id,
  });
  const [question] = await db().select().from(questions).where(eq(questions.id, id));
  const saved = await poolService.putDraft(db(), question!, { config, explanation: `EXPLANATION_SECRET_${type}` });
  if (!saved.valid) throw new Error(`${type}: ${JSON.stringify(saved.issues)}`);
  await poolService.publishQuestion(db(), question!, { userId: teacher.id });
  return id;
}

/** An exam of `types` for the two students, items and choices shuffled. */
async function exam(types: Record<string, unknown> = { mcq: MCQ, cloze: CLOZE, rich: RICH }) {
  const seed = await seedLive(db(), {
    teacherId: teacher.id,
    studentIds: [student.id, second.id],
    questions: 0,
    settings: { shuffleItems: true, shuffleChoices: true },
  });
  const ids = [];
  for (const [type, config] of Object.entries(types)) ids.push(await publish(seed.poolId, type, config));
  await addItems(db(), await reload(db(), seed.evaluationId), ids, (type, version) =>
    typeOf(type).defaultPoints(poolService.exampleConfig(type, version)), { attemptCount: 0 });
  return { ...seed, evaluation: await reload(db(), seed.evaluationId) };
}

const started = async (id: string) => live.startEvaluation(db(), await reload(db(), id), now());
const closed = async (id: string) => live.closeEvaluation(db(), await reload(db(), id), now(), "teacher", server.app);

/** The entry page's paper, as the teacher reads it. */
async function paperOf(evaluationId: string, userId: string): Promise<PaperItems> {
  const res = await get(`/app/api/evaluations/${evaluationId}/paper/items?user=${userId}`, teacher.headers);
  expect(res.statusCode, res.body).toBe(200);
  return PaperItems.parse(res.json());
}

/** The copy answering the key of the mcq, the cloze's blank, and nothing for the essay. */
function keyAnswers(paper: PaperItems): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of paper.view.items) {
    if (item.type === "mcq") {
      const choices = (item.student as { choices: { id: number; text: string }[] }).choices;
      out[item.id] = { selected: [choices.findIndex((c) => c.text === "MCQ_KEY_CHOICE")] };
    }
    if (item.type === "cloze") out[item.id] = { blanks: ["CLOZE_KEY_SECRET"] };
  }
  return out;
}

const enter = (evaluationId: string, body: unknown, headers = teacher.headers) =>
  post(`/app/api/evaluations/${evaluationId}/paper`, headers, body);

const body = (userId: string, answersOf: Record<string, unknown> = {}) => ({
  userId,
  examDate: "2026-11-02",
  answers: answersOf,
  coordinates: "position",
});

const attemptsOf = (evaluationId: string, userId: string) =>
  db()
    .select()
    .from(attempts)
    .where(and(eq(attempts.evaluationId, evaluationId), eq(attempts.userId, userId)))
    .orderBy(attempts.attemptNumber);

/** A multipart body of one file, as a browser's `FormData` sends it. */
function multipart(bytes: Buffer, filename: string, mime: string) {
  const boundary = `----paper${randomUUID()}`;
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const putScan = (evaluationId: string, attemptId: string, bytes: Buffer, mime: string, headers = teacher.headers) => {
  const form = multipart(bytes, "scan", mime);
  return server.app.inject({
    method: "PUT",
    url: `/app/api/evaluations/${evaluationId}/attempts/${attemptId}/paper/scan`,
    headers: { ...headers, ...form.headers },
    payload: form.payload,
  });
};

describe("the refusals (F-PAPER-05, invariant 6)", () => {
  it("is the 404 of a missing evaluation for a stranger", async () => {
    const { evaluation } = await exam();
    await started(evaluation.id);
    expect((await enter(evaluation.id, body(student.id), other.headers)).statusCode).toBe(404);
    expect((await get(`/app/api/evaluations/${evaluation.id}/paper/items?user=${student.id}`, other.headers)).statusCode).toBe(404);
    expect((await enter(randomUUID(), body(student.id))).statusCode).toBe(404);
  });

  it("refuses an exam that never ran, an exercise, and a released exam", async () => {
    const { evaluation } = await exam();
    let res = await enter(evaluation.id, body(student.id));
    expect([res.statusCode, res.json().error]).toEqual([409, "paper_not_started"]);
    res = await get(`/app/api/evaluations/${evaluation.id}/paper/items?user=${student.id}`, teacher.headers);
    expect([res.statusCode, res.json().error]).toEqual([409, "paper_not_started"]);

    await started(evaluation.id);
    await db().update(evaluations).set({ mode: "exercise" }).where(eq(evaluations.id, evaluation.id));
    res = await enter(evaluation.id, body(student.id));
    expect([res.statusCode, res.json().error]).toEqual([409, "paper_mode"]);

    await db().update(evaluations).set({ mode: "exam", state: "released" }).where(eq(evaluations.id, evaluation.id));
    res = await enter(evaluation.id, body(student.id));
    expect([res.statusCode, res.json().error]).toEqual([409, "paper_released"]);
    expect(await attemptsOf(evaluation.id, student.id)).toEqual([]);
  });

  it("refuses an exam that does not print, with the hand-out's refusal", async () => {
    const { evaluation } = await exam({ mcq: MCQ, code: CODE });
    await started(evaluation.id);
    const res = await enter(evaluation.id, body(student.id));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_printable", reason: "type", types: ["code"] });
    // The same rule, published for the screens' row action.
    const detail = EvaluationDetail.parse((await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers)).json());
    expect(detail.exports.paper).toBe("not_printable");
  });

  it("publishes the rule the submission applies (`exports.paper`)", async () => {
    const { evaluation } = await exam();
    const paperOf = async () =>
      EvaluationDetail.parse((await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers)).json()).exports.paper;
    expect(await paperOf()).toBe("paper_not_started");
    await started(evaluation.id);
    expect(await paperOf()).toBeNull();
  });

  it("refuses a person with no claimed student seat: a stranger, a staff seat", async () => {
    const { evaluation, classroomId } = await exam();
    await started(evaluation.id);
    const stranger = await server.signIn("student");
    await db().insert(enrollments).values({
      id: randomUUID(),
      classroomId,
      nom: "Staff",
      prenom: "Seat",
      email: `staff-${randomUUID()}@heig.test`,
      userId: other.id,
      staff: true,
      claimedAt: now(),
    });
    for (const userId of [stranger.id, other.id, randomUUID()]) {
      const res = await enter(evaluation.id, body(userId));
      expect([res.statusCode, res.json().error]).toEqual([422, "paper_no_seat"]);
    }
  });

  it("refuses the whole copy for one malformed answer, or an item the exam does not hold", async () => {
    const { evaluation } = await exam();
    await started(evaluation.id);
    const paper = await paperOf(evaluation.id, student.id);
    const mcq = paper.view.items.find((i) => i.type === "mcq")!;
    for (const answersOf of [
      { ...keyAnswers(paper), [mcq.id]: { selected: "first" } },
      { ...keyAnswers(paper), [mcq.id]: { selected: [0, 1] } }, // a `single` question takes one
      { ...keyAnswers(paper), [randomUUID()]: { text: "x" } },
    ]) {
      const res = await enter(evaluation.id, body(student.id, answersOf));
      expect([res.statusCode, res.json().error]).toEqual([422, "answer_invalid"]);
    }
    expect(await attemptsOf(evaluation.id, student.id)).toEqual([]);
    expect(await db().select().from(paperSheets)).not.toContainEqual(expect.objectContaining({ examDate: "2026-11-02" }));
  });
});

describe("the paper attempt (F-PAPER-01..03)", () => {
  it("replaces a digital attempt in one transaction, on the paper seed, and counts alone", async () => {
    const { evaluation } = await exam();
    const running = await started(evaluation.id);
    // The student's computer died mid-exam: an attempt in progress.
    const participant = (await live.participantOf(db(), running, student.id))!;
    const digital = await live.beginAttempt(db(), running, await live.ensureAttempt(db(), running, participant, now()), participant, now());

    const paper = await paperOf(evaluation.id, student.id);
    expect(paper.replaces).toEqual({ attemptId: digital.id, state: "in_progress", origin: "digital" });
    expect(paper.student.displayName).toBe("Prenom0 Nom0");
    // The hand-out's order, item for item (ADR-125 §8).
    const handout = (await get(`/app/api/evaluations/${evaluation.id}/handout.json`, teacher.headers)).json();
    expect(paper.view.items.map((i) => i.id)).toEqual(handout.items.map((i: { id: string }) => i.id));
    // The key beside each item, never in the student views.
    expect(Object.keys(paper.solutions).sort()).toEqual(paper.view.items.map((i) => i.id).sort());
    for (const item of paper.view.items) {
      expect(findStudentLeaks(item.student, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS, secrets: SECRETS })).toEqual([]);
    }

    server.clock.advance(60_000);
    const res = await enter(evaluation.id, body(student.id, keyAnswers(paper)));
    expect(res.statusCode, res.body).toBe(201);
    const { attemptId, supersededAttemptId } = res.json();
    expect(supersededAttemptId).toBe(digital.id);

    const seed = (await reload(db(), evaluation.id)).paperSeed;
    const [old, row] = await attemptsOf(evaluation.id, student.id);
    expect(old).toMatchObject({ id: digital.id, state: "expired", closedBy: "teacher", supersededBy: attemptId, origin: "digital" });
    expect(row).toMatchObject({
      id: attemptId,
      attemptNumber: 2,
      seed,
      state: "submitted",
      closedBy: "teacher",
      origin: "paper",
      startedAt: null,
      deadlineAt: null,
      afterDue: false,
      displayTracked: false,
      supersededBy: null,
    });
    expect(row!.submittedAt).toEqual(now());

    // Canonical answers, as a student's save would store them (ADR-097):
    // the key of the mcq is its first choice, whatever the paper's order.
    const stored = await db().select().from(answers).where(eq(answers.attemptId, attemptId));
    const byType = new Map(paper.view.items.map((i) => [i.id, i.type]));
    expect(Object.fromEntries(stored.map((a) => [byType.get(a.itemId), a.payload]))).toEqual({
      mcq: { selected: [0] },
      cloze: { blanks: ["CLOZE_KEY_SECRET"] },
    });
    const [sheet] = await db().select().from(paperSheets).where(eq(paperSheets.attemptId, attemptId));
    expect(sheet).toMatchObject({ examDate: "2026-11-02", enteredBy: teacher.id, scanSha256: null });

    // The paper attempt is the student's current, latest and only official one.
    expect((await live.attemptOf(db(), evaluation.id, student.id))!.id).toBe(attemptId);
    const latest = await db()
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.userId, student.id), isLatestAttempt));
    expect(latest).toEqual([{ id: attemptId }]);
    const dashboard = DashboardView.parse(
      (await get(`/app/api/evaluations/${evaluation.id}/dashboard`, teacher.headers)).json(),
    );
    expect(dashboard.rows.find((r) => r.userId === student.id)).toMatchObject({
      attemptId,
      state: "submitted",
      origin: "paper",
      attemptCount: 1,
    });
    expect(dashboard.rows.find((r) => r.userId === second.id)?.origin).toBe("digital");

    // A running exam grades it at its close, like any hand-in.
    expect(await db().select().from(gradings).where(eq(gradings.attemptId, attemptId))).toEqual([]);

    // The replaced attempt: never the student's again, still the staff's, marked.
    expect((await get(`/app/api/attempts/${digital.id}`, student.headers)).statusCode).toBe(404);
    expect((await get(`/app/api/attempts/${attemptId}`, student.headers)).statusCode).toBe(200);
    const inspect = await get(`/app/api/evaluations/${evaluation.id}/attempts/${digital.id}`, teacher.headers);
    expect(inspect.json().attempt).toMatchObject({ origin: "digital", supersededBy: attemptId });
    // Neither goes back to a screen.
    for (const id of [digital.id, attemptId]) {
      const reopen = await post(`/app/api/evaluations/${evaluation.id}/attempts/${id}/reopen`, teacher.headers, {});
      expect([reopen.statusCode, reopen.json().error]).toEqual([409, "not_reopenable"]);
    }

    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "paper.enter"), eq(auditLog.subjectId, attemptId)));
    expect(audit).toMatchObject({
      actorUserId: teacher.id,
      subjectType: "attempt",
      payload: { evaluationId: evaluation.id, userId: student.id, examDate: "2026-11-02", supersededAttemptId: digital.id },
    });

    // The close grades it: the typed answers by their grader, the essay
    // nobody typed in proposed at zero (ADR-125 §14) — no model, no grader.
    await closed(evaluation.id);
    const graded = await db().select().from(gradings).where(eq(gradings.attemptId, attemptId));
    const byItem = new Map(graded.map((g) => [byType.get(g.itemId), g]));
    expect(byItem.get("mcq")).toMatchObject({ state: "validated", source: "auto" });
    expect(byItem.get("mcq")!.points).toBeGreaterThan(0);
    expect(byItem.get("cloze")).toMatchObject({ state: "validated" });
    expect(byItem.get("rich")).toMatchObject({ state: "proposed", points: 0, details: { reason: "paper_free_zone" } });

    // The results count it; its duration is unknown (no start on paper).
    const results = ResultsView.parse((await get(`/app/api/evaluations/${evaluation.id}/results`, teacher.headers)).json());
    expect(results.rows.find((r) => r.userId === student.id)).toMatchObject({
      attemptId,
      origin: "paper",
      state: "submitted",
      durationS: null,
    });
    const copy = (await get(`/app/api/evaluations/${evaluation.id}/results/attempts/${attemptId}`, teacher.headers)).json() as StaffCopy;
    expect(copy).toMatchObject({ origin: "paper", supersededBy: null });
  });

  it("grades a copy entered on a closed exam at once, and a paper copy replaces a paper copy", async () => {
    const { evaluation } = await exam();
    await started(evaluation.id);
    await closed(evaluation.id);
    const paper = await paperOf(evaluation.id, second.id);
    expect(paper.replaces).toBeNull();
    const first = (await enter(evaluation.id, body(second.id, {}))).json();
    expect(first.supersededAttemptId).toBeNull();
    // Graded now: an untouched exam is zero, settled — the essay proposed.
    const graded = await db().select().from(gradings).where(eq(gradings.attemptId, first.attemptId));
    expect(graded).toHaveLength(3);
    expect(graded.filter((g) => g.state === "proposed").map((g) => g.details)).toEqual([{ reason: "paper_free_zone" }]);

    const again = (await enter(evaluation.id, body(second.id, keyAnswers(paper)))).json();
    expect(again.supersededAttemptId).toBe(first.attemptId);
    const rows = await attemptsOf(evaluation.id, second.id);
    expect(rows.map((r) => [r.attemptNumber, r.origin, r.supersededBy])).toEqual([
      [1, "paper", again.attemptId],
      [2, "paper", null],
    ]);
  });

  it("hands two copies of one student entered at once in one after the other", async () => {
    const { evaluation } = await exam();
    await started(evaluation.id);
    const [a, b] = await Promise.all([enter(evaluation.id, body(second.id)), enter(evaluation.id, body(second.id))]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const rows = await attemptsOf(evaluation.id, second.id);
    expect(rows.map((r) => r.attemptNumber)).toEqual([1, 2]);
    expect(rows.filter((r) => r.supersededBy === null)).toHaveLength(1);
  });

  it("tells a race the seat's lock missed as 409 paper_conflict", () => {
    // PGlite runs one connection, so two entries can never interleave there:
    // the unique violation the lock guards against is built by hand, wrapped
    // in `cause` as Drizzle wraps the driver's error.
    const violation = new Error("insert failed", {
      cause: { code: "23505", constraint: "attempts_evaluation_user_number_uq" },
    });
    const mapped = conflictOf(violation);
    expect(mapped).toBeInstanceOf(PaperError);
    expect(mapped).toMatchObject({ code: "paper_conflict", status: 409 });
    const other = new Error("other", { cause: { code: "23505", constraint: "attempts_evaluation_user_open_uq" } });
    expect(conflictOf(other)).toBe(other);
  });

  it("serves the student their paper copy after the release, in the paper's order, with no key", async () => {
    const { evaluation } = await exam({ mcq: MCQ, cloze: CLOZE });
    const running = await started(evaluation.id);
    // The digital attempt the paper copy replaces, ended at the close.
    const participant = (await live.participantOf(db(), running, student.id))!;
    const digital = await live.beginAttempt(db(), running, await live.ensureAttempt(db(), running, participant, now()), participant, now());
    await closed(evaluation.id);
    const paper = await paperOf(evaluation.id, student.id);
    const { attemptId, supersededAttemptId } = (await enter(evaluation.id, body(student.id, keyAnswers(paper)))).json();
    expect(supersededAttemptId).toBe(digital.id);
    const release = await post(`/app/api/evaluations/${evaluation.id}/release`, teacher.headers, { confirm: true });
    expect(release.statusCode, release.body).toBe(200);

    const res = await get(`/app/api/attempts/${attemptId}`, student.headers);
    expect(res.statusCode).toBe(200);
    const view = AttemptView.parse(res.json().view ?? res.json());
    expect(view.items.map((i) => i.id)).toEqual(paper.view.items.map((i) => i.id));
    for (const item of view.items) {
      expect(findStudentLeaks(item.student, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS, secrets: SECRETS })).toEqual([]);
    }
    expect((await get(`/app/api/attempts/${attemptId}/feedback`, student.headers)).statusCode).toBe(200);

    // The replaced attempt is never the student's again (ADR-125 §12): the 404 of a miss on every route.
    expect((await get(`/app/api/attempts/${digital.id}`, student.headers)).statusCode).toBe(404);
    expect((await get(`/app/api/attempts/${digital.id}/feedback`, student.headers)).statusCode).toBe(404);
    const journal = await post(`/app/api/attempts/${digital.id}/events`, student.headers, {
      kind: "visibility",
      details: { state: "hidden" },
    });
    expect(journal.statusCode, journal.body).toBe(404);
    // The student's grades read the paper copy.
    const grades = (await get("/app/api/student/results", student.headers)).body;
    expect(grades).toContain(attemptId);
    expect(grades).not.toContain(digital.id);
  });
});

describe("the question statistics (ADR-125 §12, ADR-038)", () => {
  it("count a paper copy once, and never the attempt it replaced", async () => {
    // Ten students: the statistics show from QUESTION_STATS_MIN_N answers on.
    const students = [];
    for (let i = 0; i < 10; i++) students.push(await server.signIn("student"));
    const seed = await seedLive(db(), {
      teacherId: teacher.id,
      studentIds: students.map((s) => s.id),
      questions: 0,
      settings: { shuffleChoices: true },
    });
    const questionId = await publish(seed.poolId, "mcq", MCQ);
    await addItems(db(), await reload(db(), seed.evaluationId), [questionId], (type, version) =>
      typeOf(type).defaultPoints(poolService.exampleConfig(type, version)), { attemptCount: 0 });
    const running = await started(seed.evaluationId);
    // The first student's computer died: a digital attempt, left blank, ended
    // at the close and graded zero.
    const participant = (await live.participantOf(db(), running, students[0]!.id))!;
    const digital = await live.beginAttempt(db(), running, await live.ensureAttempt(db(), running, participant, now()), participant, now());
    await closed(seed.evaluationId);
    expect(await db().select().from(gradings).where(eq(gradings.attemptId, digital.id))).toHaveLength(1);

    // Every student's paper copy, the key ticked: graded at once.
    for (const s of students) {
      const paper = await paperOf(seed.evaluationId, s.id);
      const res = await enter(seed.evaluationId, body(s.id, keyAnswers(paper)));
      expect(res.statusCode, res.body).toBe(201);
    }

    const { items } = await poolQuestionStats(db(), seed.poolId);
    const entry = items.find((i) => i.questionId === questionId);
    // Ten answers, all right: the replaced zero is in neither count.
    expect(entry).toMatchObject({ n: 10, p: 1 });
    // No time on paper: no dwell was measured.
    expect(entry?.time).toBeNull();
  });
});

describe("the scan (F-PAPER-04)", () => {
  it("is attached, replaced, served to the staff only, and swept with its attempt", async () => {
    const { evaluation } = await exam();
    await started(evaluation.id);
    const { attemptId } = (await enter(evaluation.id, body(student.id))).json();
    const sheetUrl = `/app/api/evaluations/${evaluation.id}/attempts/${attemptId}/paper`;
    expect(PaperSheet.parse((await get(sheetUrl, teacher.headers)).json())).toEqual({
      attemptId,
      examDate: "2026-11-02",
      scan: null,
    });
    expect((await get(`${sheetUrl}/scan`, teacher.headers)).statusCode).toBe(404);

    let res = await putScan(evaluation.id, attemptId, PDF, "application/pdf");
    expect(res.statusCode, res.body).toBe(200);
    expect(PaperSheet.parse(res.json()).scan).toMatchObject({ mime: "application/pdf", bytes: PDF.length });
    const dir = join(server.assetsDir, "paper", attemptId);
    expect(await readdir(dir)).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.pdf$/)]);

    res = await putScan(evaluation.id, attemptId, PNG, "application/pdf"); // the bytes decide
    expect(PaperSheet.parse(res.json()).scan).toMatchObject({ mime: "image/png", bytes: PNG.length });
    expect(await readdir(dir)).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.png$/)]);

    res = await get(`${sheetUrl}/scan`, teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="paper-.+\.png"$/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.rawPayload.equals(PNG)).toBe(true);

    // Refused: text (415), too big (413), a stranger (404), a student (403).
    expect((await putScan(evaluation.id, attemptId, Buffer.from("plain text"), "application/pdf")).statusCode).toBe(415);
    expect((await putScan(evaluation.id, attemptId, Buffer.alloc(8192, 0x25), "application/pdf")).statusCode).toBe(413);
    expect((await get(`${sheetUrl}/scan`, other.headers)).statusCode).toBe(404);
    expect((await putScan(evaluation.id, attemptId, PDF, "application/pdf", other.headers)).statusCode).toBe(404);
    expect((await get(`${sheetUrl}/scan`, student.headers)).statusCode).toBe(403);

    // A digital attempt has no sheet.
    const participant = (await live.participantOf(db(), evaluation, second.id))!;
    const digital = await live.ensureAttempt(db(), await reload(db(), evaluation.id), participant, now());
    expect((await get(`/app/api/evaluations/${evaluation.id}/attempts/${digital.id}/paper`, teacher.headers)).statusCode).toBe(404);

    const actions = await db()
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.subjectId, attemptId));
    expect(actions.filter((a) => a.action === "paper.scan_upload")).toHaveLength(2);
    expect(actions.filter((a) => a.action === "paper.scan_read")).toEqual([
      { action: "paper.scan_read", payload: { evaluationId: evaluation.id } },
    ]);

    // An evaluation deleted with a replaced attempt and its replacement: one
    // cascade (NO ACTION is checked at the end of the statement), then the
    // scan swept with it.
    const replacement = (await enter(evaluation.id, body(student.id))).json();
    expect(replacement.supersededAttemptId).toBe(attemptId);
    await db().delete(evaluations).where(eq(evaluations.id, evaluation.id));
    expect(await attemptsOf(evaluation.id, student.id)).toEqual([]);
    expect(await sweepOrphanScans(db(), server.assetsDir)).toBeGreaterThanOrEqual(1);
    await expect(stat(dir)).rejects.toThrow();
  });
});
