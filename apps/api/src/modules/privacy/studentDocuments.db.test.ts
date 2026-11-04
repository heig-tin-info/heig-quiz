/**
 * The student's two documents (ADR-112 amendment of 2026-11-03, ADR-125
 * §18, F-EXP-06), over the real application: their own copy of a handed-in
 * attempt and the blank print of a past series.
 *
 * The copy is the feedback page as a file: searched in the three forms of
 * 05 §5.7 (ADR-125 §19) — the document tree, its rendered Typst source and
 * the PDF's text — under three policies: the key, the explanation and the
 * teacher's comment absent, then present; the student's own answers absent
 * under `showAnswer: false`. The record's student shapes pass the forbidden
 * keys. The blank print is the hand-out of a past series: the statements
 * only, in the paper's order, no seed, its images exactly as the player's.
 * For both, who reaches them (the caller's own portal session, invariant 6),
 * the shared hourly bucket apart from the personal export's, and the audit,
 * neither of which a refusal or a PDF the server cannot make touches.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FeedbackPolicy, HandoutRecord, PERSONAL_DATA_EXPORT_PATH, StudentCopyRecord } from "@quiz/contracts";
import { findStudentLeaks } from "@quiz/core/testing";
import { EN_LABELS, FR_LABELS, type Document } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";
import { renderTypst } from "@quiz/docexport/typst";

import { answers, auditLog, classrooms, enrollments, evaluations, questions } from "../../db/schema.js";
import { type Payload, sessionOf, testServer, type TestServer } from "../../test/http.js";
import { kioskStation } from "../../test/kiosk.js";
import { reload, seedLive } from "../../test/live.js";
import { publishParameterized } from "../../test/parameterized.js";
import { pdfText, pdfTools, typstProbe } from "../../test/pdf.js";
import { addItems, applyState, handout, handoutTree } from "../evaluation/service.js";
import { writeGrading } from "../grading/service.js";
import { findOwnAttempt } from "../guards.js";
import * as live from "../live/service.js";
import { storeAsset } from "../pool/assets.js";
import { typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { studentCopyDocument, studentCopyRecord } from "../results/service.js";
import { STUDENT_DOCUMENTS_PER_HOUR } from "./documents.js";

/** One question of each printable type, every secret a marker the search finds. */
const QUESTIONS = {
  mcq: {
    configVersion: 2,
    prompt: "Pick MCQ_PROMPT.",
    mode: "single",
    shuffleChoices: true,
    choices: [
      { text: "MCQ_KEY_CHOICE", correct: true },
      { text: "MCQ_OTHER_ONE", correct: false },
      { text: "MCQ_OTHER_TWO", correct: false },
    ],
  },
  short: {
    configVersion: 3,
    prompt: "Name SHORT_PROMPT.",
    kind: "text",
    matchers: [{ kind: "exact", value: "SHORT_KEY_SECRET" }],
  },
  cloze: { configVersion: 2, text: "CLOZE_PROMPT {{CLOZE_KEY_SECRET}} end." },
  rich: {
    configVersion: 2,
    prompt: "Explain RICH_PROMPT.",
    rubric: "- 2 pts: RICH_RUBRIC_SECRET",
    reference: "RICH_REFERENCE_SECRET",
    maxChars: 3000,
    format: "markdown",
  },
  math: {
    configVersion: 1,
    prompt: "Expand MATH_PROMPT.",
    symbols: [{ name: "x", min: 1, max: 10 }],
    answers: [{ value: "x^3+11x", points: 1 }],
  },
} as const;

const PROMPTS = ["MCQ_PROMPT", "SHORT_PROMPT", "CLOZE_PROMPT", "RICH_PROMPT", "MATH_PROMPT"];

/**
 * What the key publishes, by value. The mcq's key choice is printed in every
 * statement (it is one of the choices): its key is the "Answer key"
 * part, searched by its heading in both languages ({@link KEY_HEADINGS}), and
 * its box, never ticked on a copy whose key is hidden ({@link tickedKey}).
 */
const KEYS = ["SHORT_KEY_SECRET", "CLOZE_KEY_SECRET", "RICH_REFERENCE_SECRET", "x^3+11x"];
const KEY_HEADINGS = [EN_LABELS.answerKey, FR_LABELS.answerKey];
const EXPLANATIONS = ["EXPLANATION_SECRET"];
const COMMENT = "TEACHER_COMMENT_SECRET";
/** What a student never reads, whatever the policy. */
const ALWAYS_SECRET = ["RICH_RUBRIC_SECRET", "INTERNAL_NAME"];
/** The student's answers: none of them a key. */
const STUDENT_ANSWERS = ["STUDENT_SHORT_ANSWER", "STUDENT_CLOZE_ANSWER", "STUDENT_RICH_ANSWER"];

/** Each policy, what it must hide and what it shows. */
const POLICIES = [
  {
    name: "key, explanation and comment hidden",
    policy: { showKey: false, showExplanation: false, showTeacherComment: false },
    absent: [...KEYS, ...KEY_HEADINGS, ...EXPLANATIONS, COMMENT, ...ALWAYS_SECRET],
    present: STUDENT_ANSWERS,
  },
  {
    name: "key, explanation and comment shown",
    policy: { showKey: true, showExplanation: true, showTeacherComment: true },
    absent: ALWAYS_SECRET,
    present: [...KEYS, ...EXPLANATIONS, COMMENT, ...STUDENT_ANSWERS],
  },
  {
    name: "the student's answers hidden",
    policy: { showAnswer: false, showKey: false, showExplanation: false, showTeacherComment: false },
    absent: [...STUDENT_ANSWERS, ...KEYS, ...KEY_HEADINGS, COMMENT, ...ALWAYS_SECRET],
    present: [] as string[],
  },
] as const;

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
let stranger: { id: string; headers: Record<string, string> };
let admin: { id: string; headers: Record<string, string> };
/** The exam, sat by the student and by the teacher on their staff seat, closed and released. */
let exam: Awaited<ReturnType<typeof sitExam>>;

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  stranger = await server.signIn("student");
  admin = await server.signIn("admin");
  exam = await sitExam({ release: true });
});
afterAll(async () => {
  await server.close();
});

const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: Payload) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });
const copyUrl = (attemptId: string, ext: "json" | "pdf") => `/app/api/attempts/${attemptId}/copy.${ext}`;
const printUrl = (evaluationId: string) => `/app/api/student/evaluations/${evaluationId}/handout.pdf`;

/** A fresh hour for the bucket of the student's documents. */
const nextHour = () => server.clock.advance(3_600_000);

/** A document's Typst source, escapes undone (`typstText` writes `A_B` as `A\_B`), as the registry's leak test reads it. */
const typstOf = (tree: Document) => renderTypst(tree).source.replace(/\\(.)/g, "$1");
/** The task-list lines of `tree` that tick the mcq key choice: a ticked key box is the key, shown. */
const tickedKey = (tree: Document): string[] =>
  markdownBody(tree).split("\n").filter((line) => line.startsWith("- [x]") && line.includes("MCQ_KEY_CHOICE"));

/** The `privacy.export` rows of `userId` since `since`. */
const exportsOf = async (userId: string, since: Date) =>
  (
    await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "privacy.export"), eq(auditLog.subjectId, userId)))
  ).filter((r) => r.createdAt >= since);

/** A published question of `type`, with its explanation and internal name markers. */
async function publish(poolId: string, type: string, config: unknown): Promise<string> {
  const db = server.app.db;
  const { id } = await poolService.createQuestion(db, { poolId, type, internalName: `INTERNAL_NAME_${type}`, createdBy: teacher.id });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  const saved = await poolService.putDraft(db, question!, { config, explanation: `EXPLANATION_SECRET_${type}` });
  if (!saved.valid) throw new Error(`${type} is not publishable: ${JSON.stringify(saved.issues)}`);
  await poolService.publishQuestion(db, question!, { userId: teacher.id });
  return id;
}

/**
 * An evaluation of `questions` (by default the five printable types, plus
 * `extra`), the student and the teacher's staff seat in its classroom.
 */
async function series(
  mode: "exam" | "exercise",
  extra: (poolId: string) => Promise<string[]> = async () => [],
  configs: Record<string, unknown> = QUESTIONS,
) {
  const db = server.app.db;
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 0,
    mode,
    settings: { shuffleItems: true, shuffleChoices: true },
  });
  // ADR-018: the teacher's own staff seat, to sit it as a student would.
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId: seed.classroomId,
    nom: "Teacher",
    prenom: "Test",
    email: `staff-${seed.classroomId.slice(0, 6)}@heig.test`,
    userId: teacher.id,
    claimedAt: new Date(),
    staff: true,
  });
  const ids = [];
  for (const [type, config] of Object.entries(configs)) ids.push(await publish(seed.poolId, type, config));
  ids.push(...(await extra(seed.poolId)));
  await addItems(db, await reload(db, seed.evaluationId), ids, (type, version) =>
    typeOf(type).defaultPoints(poolService.exampleConfig(type, version)), { attemptCount: 0 });
  return seed;
}

/** `who` enters the running evaluation and answers every item, through the routes. */
async function sit(evaluationId: string, who: { headers: Record<string, string> }) {
  const entered = await post(`/app/api/evaluations/${evaluationId}/attempt/start`, who.headers, {});
  expect(entered.statusCode).toBe(200);
  const view = entered.json().view as { attempt: { id: string }; items: { id: string; type: string; student: unknown }[] };
  const payloads: Record<string, unknown> = {
    short: { text: "STUDENT_SHORT_ANSWER" },
    cloze: { blanks: ["STUDENT_CLOZE_ANSWER"] },
    rich: { text: "STUDENT_RICH_ANSWER" },
    math: { latex: "x^2" },
  };
  for (const item of view.items) {
    const choices = (item.student as { choices?: { id: number; text: string }[] }).choices;
    const payload = item.type === "mcq" ? { selected: [choices!.find((c) => c.text === "MCQ_OTHER_ONE")!.id] } : payloads[item.type];
    const saved = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${view.attempt.id}/answers/${item.id}`,
      headers: who.headers,
      payload: { payload, revision: 1, coordinates: "position", clientTs: server.clock.now().toISOString() },
    });
    expect(saved.statusCode).toBe(200);
  }
  return { attemptId: view.attempt.id, richItemId: view.items.find((i) => i.type === "rich")!.id };
}

/** The exam, sat by the student and the teacher (staff seat), the essay graded with a comment, closed; released on demand. */
async function sitExam({ release }: { release: boolean }) {
  const db = server.app.db;
  const seed = await series("exam");
  await post(`/app/api/evaluations/${seed.evaluationId}/start`, teacher.headers, { confirm: true });
  const { attemptId, richItemId } = await sit(seed.evaluationId, student);
  const { attemptId: staffAttemptId } = await sit(seed.evaluationId, teacher);
  await post(`/app/api/evaluations/${seed.evaluationId}/close`, teacher.headers, { confirm: true });
  // The teacher grades the essay by hand, with a comment for the student.
  const [answer] = await db
    .select()
    .from(answers)
    .where(and(eq(answers.attemptId, attemptId), eq(answers.itemId, richItemId)));
  await writeGrading(db, {
    attemptId,
    itemId: richItemId,
    answerId: answer!.id,
    points: 1,
    maxPoints: 2,
    source: "manual",
    state: "validated",
    comment: COMMENT,
    gradedBy: teacher.id,
    now: server.clock.now(),
  });
  if (release) {
    const released = await post(`/app/api/evaluations/${seed.evaluationId}/release`, teacher.headers, { confirm: true });
    expect(released.statusCode).toBe(200);
  }
  return { seed, evaluationId: seed.evaluationId, attemptId, staffAttemptId };
}

async function setPolicy(evaluationId: string, patch: Partial<FeedbackPolicy>): Promise<void> {
  await server.app.db
    .update(evaluations)
    .set({ feedbackPolicy: FeedbackPolicy.parse(patch) })
    .where(eq(evaluations.id, evaluationId));
}

/** An exercise over and open to practice, of the five printable types (plus `extra`) or of `configs`. */
async function pastSeries(extra?: (poolId: string) => Promise<string[]>, configs?: Record<string, unknown>) {
  const db = server.app.db;
  const seed = await series("exercise", extra, configs);
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
  await live.closeEvaluation(db, evaluation, server.clock.now());
  return seed;
}

describe("the student's own copy (F-EXP-06)", () => {
  it("is refused before the feedback page shows anything", async () => {
    const pending = await sitExam({ release: false });
    nextHour();
    for (const ext of ["json", "pdf"] as const) {
      const res = await get(copyUrl(pending.attemptId, ext), student.headers);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "feedback_pending", reason: "results_pending" });
      expect(res.body).not.toContain("PROMPT");
    }
  });

  for (const { name, policy, absent, present } of POLICIES) {
    it(`holds only what the page shows (${name}): the record, the tree and its Typst source`, async () => {
      await setPolicy(exam.evaluationId, policy);
      nextHour();
      const res = await get(copyUrl(exam.attemptId, "json"), student.headers);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9-]+-my-copy\.json"$/);
      expect(res.headers["cache-control"]).toBe("no-store");
      const record = StudentCopyRecord.parse(res.json());
      expect(record).toMatchObject({ kind: "student-copy", version: 1, attemptId: exam.attemptId });
      expect(record.items).toHaveLength(5);
      // The page's actions are not part of the file.
      expect(res.json()).not.toHaveProperty("available");
      // The student shapes pass the forbidden keys (the details, while the key
      // is hidden: it is the key's to show, H1); the whole file, the secrets.
      for (const item of record.items) {
        const shapes = policy.showKey ? [item.student, item.answer] : [item.student, item.answer, item.details];
        expect(findStudentLeaks(shapes, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS })).toEqual([]);
        expect(item.solution === null).toBe(!policy.showKey);
      }
      const values = absent.filter((s) => !KEY_HEADINGS.includes(s));
      expect(values.filter((secret) => res.body.includes(secret))).toEqual([]);
      for (const secret of present) expect(res.body).toContain(secret);

      // The first and second forms (05 §5.7): the tree and its Typst source, in both languages.
      const evaluation = await reload(server.app.db, exam.evaluationId);
      const { attempt } = (await findOwnAttempt(server.app.db, student.id, exam.attemptId))!;
      const found = await studentCopyRecord(server.app.db, evaluation, attempt, { now: server.clock.now() });
      for (const lang of ["en", "fr"] as const) {
        const tree = studentCopyDocument(found, lang);
        expect(findStudentLeaks(tree, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS, secrets: absent })).toEqual([]);
        // The key choice's box is ticked only by the key, and only when the policy shows it.
        expect(tickedKey(tree)).toHaveLength(policy.showKey ? 1 : 0);
        const source = typstOf(tree);
        expect(absent.filter((secret) => source.includes(secret))).toEqual([]);
        for (const secret of present) expect(source).toContain(secret);
        for (const prompt of PROMPTS) expect(source).toContain(prompt);
      }
    });

    // The third form: the PDF's text, as a printer receives it.
    it.skipIf(!pdfTools)(`holds only what the page shows (${name}): the PDF's text`, async () => {
      await setPolicy(exam.evaluationId, policy);
      nextHour();
      const res = await get(copyUrl(exam.attemptId, "pdf"), { ...student.headers, "accept-language": "fr-CH" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toMatch(/-my-copy\.pdf"$/);
      const text = await pdfText(res.rawPayload);
      for (const prompt of PROMPTS) expect(text).toContain(prompt);
      expect(absent.filter((secret) => text.includes(secret))).toEqual([]);
      for (const secret of present) expect(text).toContain(secret);
      // Worded in the reader's language.
      if (!("showAnswer" in policy)) expect(text).toContain("Votre réponse");
    });
  }

  it("serves a teacher their own staff test attempt, through the student view's rule", async () => {
    await setPolicy(exam.evaluationId, { showKey: false });
    nextHour();
    const res = await get(copyUrl(exam.staffAttemptId, "json"), teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(StudentCopyRecord.parse(res.json()).attemptId).toBe(exam.staffAttemptId);
    expect([...KEYS, ...ALWAYS_SECRET].filter((secret) => res.body.includes(secret))).toEqual([]);
    // The student's attempt is not the teacher's: the 404 of a missing one.
    expect((await get(copyUrl(exam.attemptId, "json"), teacher.headers)).statusCode).toBe(404);
  });

  it("is the 404 of a missing attempt for anyone else, and refused to any session but the caller's own portal", async () => {
    nextHour();
    for (const ext of ["json", "pdf"] as const) {
      expect((await get(copyUrl(exam.attemptId, ext), stranger.headers)).statusCode).toBe(404);
      expect((await get(copyUrl(randomUUID(), ext), student.headers)).statusCode).toBe(404);
    }
    const station = await kioskStation(server.app);
    const kiosk = await sessionOf(server.app.db, student.id, { kind: "kiosk", evaluationId: exam.evaluationId, deviceId: station.deviceId });
    const refused = [
      // An impersonation (ADR-034): 403 session_required, as for the personal export.
      { headers: await sessionOf(server.app.db, student.id, { kind: "impersonation", actorUserId: admin.id }), status: 403 },
      { headers: await sessionOf(server.app.db, student.id, { kind: "seb", evaluationId: exam.evaluationId }) },
      { headers: { ...kiosk, cookie: `${kiosk["cookie"]}; ${station.cookie}` } },
    ];
    for (const { headers, status } of refused) {
      for (const ext of ["json", "pdf"] as const) {
        const res = await get(copyUrl(exam.attemptId, ext), headers);
        if (status !== undefined) expect(res.statusCode).toBe(status);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.body).not.toContain("PROMPT");
      }
    }
  });

  it("is refused for a practice attempt (ADR-122 §10)", async () => {
    const db = server.app.db;
    const seed = await pastSeries();
    const evaluation = await reload(db, seed.evaluationId);
    const participant = (await live.participantOf(db, evaluation, student.id))!;
    const { row } = await live.startPractice(db, { evaluation, participant, archived: false, now: server.clock.now() });
    expect(row.afterDue).toBe(true);
    nextHour();
    for (const ext of ["json", "pdf"] as const) {
      const res = await get(copyUrl(row.id, ext), student.headers);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "practice_attempt" });
    }
  });
});

describe("the blank print of a past series (ADR-122 §9)", () => {
  it("is served to the student and to a teacher in the student view, audited, the paper seed drawn", async () => {
    const seed = await pastSeries();
    // A past series of the student's home.
    const home = await get("/app/api/student/home", student.headers);
    expect(home.json().practice.map((card: { id: string }) => card.id)).toContain(seed.evaluationId);
    nextHour();
    const since = server.clock.now();
    for (const who of [student, teacher]) {
      const res = await get(printUrl(seed.evaluationId), who.headers);
      // Without Typst here, the one 503 of `sendExport`, and nothing counted (below).
      expect(res.statusCode).toBe(typstProbe.available ? 200 : 503);
      expect((await exportsOf(who.id, since)).map((r) => r.payload)).toEqual(
        typstProbe.available ? [{ kind: "handout", evaluationId: seed.evaluationId }] : [],
      );
    }
    expect((await reload(server.app.db, seed.evaluationId)).paperSeed).toEqual(expect.any(Number));
  });

  it("holds no secret, no answer and no seed in its tree and its Typst source", async () => {
    const seed = await pastSeries();
    const found = await handout(server.app.db, await reload(server.app.db, seed.evaluationId), { now: server.clock.now() });
    const paperSeed = (await reload(server.app.db, seed.evaluationId)).paperSeed!;
    const secrets = [...KEYS, ...KEY_HEADINGS, ...EXPLANATIONS, ...ALWAYS_SECRET];
    for (const lang of ["en", "fr"] as const) {
      const tree = handoutTree(found, lang);
      expect(findStudentLeaks(tree, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS, secrets })).toEqual([]);
      const source = typstOf(tree);
      expect(secrets.filter((secret) => source.includes(secret))).toEqual([]);
      for (const prompt of PROMPTS) expect(source).toContain(prompt);
      expect(new RegExp(`(?<![\\w-])${paperSeed}(?![\\w])`).test(source)).toBe(false);
    }
  });

  it.skipIf(!pdfTools)("prints the statements in the paper's order, its text holding no secret and no seed", async () => {
    const seed = await pastSeries();
    nextHour();
    const res = await get(printUrl(seed.evaluationId), { ...student.headers, "accept-language": "fr-CH" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9-]+-handout\.pdf"$/);
    const text = await pdfText(res.rawPayload);
    expect(text).toContain("Prénom");
    for (const secret of [...KEYS, ...KEY_HEADINGS, ...EXPLANATIONS, ...ALWAYS_SECRET, ...STUDENT_ANSWERS]) {
      expect(text).not.toContain(secret);
    }
    const paperSeed = (await reload(server.app.db, seed.evaluationId)).paperSeed!;
    expect(new RegExp(`(?<![\\w-])${paperSeed}(?![\\w])`).test(text)).toBe(false);
    // The paper's order: the staff hand-out's, drawn from the same seed.
    const staff = HandoutRecord.parse((await get(`/app/api/evaluations/${seed.evaluationId}/handout.json`, teacher.headers)).json());
    const promptOf = (type: string) => PROMPTS.find((p) => p.toLowerCase().startsWith(type))!;
    const printed = [...PROMPTS].sort((a, b) => text.indexOf(a) - text.indexOf(b));
    expect(printed).toEqual(staff.items.map((i) => promptOf(i.type)));
  });

  /*
   * The images of a blank print are drawn for the reader by the asset
   * route's own rule (`readableAssets` → `mayReadAsset`), never wider: a
   * student who never sat the series does not get its images, exactly as the
   * asset route refuses them; once they open it to practise (a practice
   * attempt in progress, ADR-122), both give it. A teacher, both always.
   */
  it("draws a statement's image exactly when the player would show it to the reader", async () => {
    const db = server.app.db;
    let imageId = "";
    // One short question whose statement shows an image of its pool.
    const seed = await pastSeries(async (poolId) => {
      const { row } = await storeAsset(db, server.assetsDir, {
        bytes: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
        facts: { mime: "image/png", width: 1, height: 1 },
        ownerId: teacher.id,
        poolId,
      });
      imageId = row.id;
      return [await publish(poolId, "short", { ...QUESTIONS.short, prompt: `![figure](asset:${row.id}) Name SHORT_PROMPT.` })];
    }, {});
    const image = { id: imageId };

    const found = await handout(db, await reload(db, seed.evaluationId), { now: server.clock.now() });
    const drawn = renderTypst(handoutTree(found, "en")).assets.map((a) => a.id);
    expect(drawn).toEqual([image.id]);
    const pdfReads = (who: { id: string }, role: string) =>
      poolService.readableAssets(db, server.assetsDir, drawn, { id: who.id, role }).then((read) => read.map((a) => a.id));
    const routeReads = async (who: { headers: Record<string, string> }) =>
      (await get(`/app/api/assets/${image.id}`, who.headers)).statusCode;

    // Never sat, never practised: the asset route refuses it, the PDF leaves it out.
    expect(await routeReads(student)).toBe(404);
    expect(await pdfReads(student, "student")).toEqual([]);
    // A teacher (in the student view or not): both.
    expect(await routeReads(teacher)).toBe(200);
    expect(await pdfReads(teacher, "teacher")).toEqual([image.id]);

    // Opened to practise: the player shows it, the PDF draws it.
    const evaluation = await reload(db, seed.evaluationId);
    const participant = (await live.participantOf(db, evaluation, student.id))!;
    await live.startPractice(db, { evaluation, participant, archived: false, now: server.clock.now() });
    expect(await routeReads(student)).toBe(200);
    expect(await pdfReads(student, "student")).toEqual([image.id]);
  });

  it("is the 404 of a missing one for a draft, an evaluation not over, an exam, another classroom, an archived one", async () => {
    const db = server.app.db;
    const draft = await series("exercise");
    const running = await series("exercise");
    await applyState(db, await reload(db, running.evaluationId), "running", server.clock.now());
    const past = await pastSeries();
    nextHour();
    // The exam: closed and released, never a past series.
    for (const id of [draft.evaluationId, running.evaluationId, exam.evaluationId, randomUUID()]) {
      const res = await get(printUrl(id), student.headers);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
    expect((await get(printUrl(past.evaluationId), stranger.headers)).statusCode).toBe(404);
    await db.update(classrooms).set({ archivedAt: server.clock.now() }).where(eq(classrooms.id, past.classroomId));
    expect((await get(printUrl(past.evaluationId), student.headers)).statusCode).toBe(404);
    // No refusal drew a seed.
    for (const seed of [draft, running, past]) expect((await reload(db, seed.evaluationId)).paperSeed).toBeNull();
  });

  it("refuses a series that does not print (ADR-125 §5), and any session but the caller's own portal", async () => {
    const parameterized = await pastSeries((poolId) =>
      publishParameterized(server.app.db, { poolId, teacherId: teacher.id, type: "mcq" }).then((id) => [id]),
    );
    nextHour();
    const res = await get(printUrl(parameterized.evaluationId), student.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_printable", reason: "parameterized" });

    const seed = await pastSeries();
    const impersonation = await sessionOf(server.app.db, student.id, { kind: "impersonation", actorUserId: admin.id });
    expect((await get(printUrl(seed.evaluationId), impersonation)).statusCode).toBe(403);
    const seb = await sessionOf(server.app.db, student.id, { kind: "seb", evaluationId: seed.evaluationId });
    expect((await get(printUrl(seed.evaluationId), seb)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await reload(server.app.db, seed.evaluationId)).paperSeed).toBeNull();
  });
});

describe("the bucket and the audit of the student's documents", () => {
  it("counts both documents together, 20 an hour, apart from the personal export", async () => {
    const past = await pastSeries();
    nextHour();
    for (let i = 0; i < STUDENT_DOCUMENTS_PER_HOUR; i++) {
      expect((await get(copyUrl(exam.attemptId, "json"), student.headers)).statusCode).toBe(200);
    }
    const limited = await get(copyUrl(exam.attemptId, "json"), student.headers);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // The blank print of a real past series shares the bucket.
    const print = await get(printUrl(past.evaluationId), student.headers);
    expect(print.statusCode).toBe(429);
    expect(Number(print.headers["retry-after"])).toBeGreaterThan(0);
    // The personal export keeps its own.
    expect((await get(PERSONAL_DATA_EXPORT_PATH, student.headers)).statusCode).toBe(200);
    // Another person's bucket is theirs.
    expect((await get(copyUrl(exam.staffAttemptId, "json"), teacher.headers)).statusCode).toBe(200);
  });

  it("neither counts nor audits a refusal: 20 refused downloads leave the hour whole", async () => {
    const pending = await sitExam({ release: false });
    nextHour();
    const since = server.clock.now();
    for (let i = 0; i < STUDENT_DOCUMENTS_PER_HOUR + 1; i++) {
      expect((await get(copyUrl(pending.attemptId, "json"), student.headers)).statusCode).toBe(409);
    }
    expect(await exportsOf(student.id, since)).toEqual([]);
    expect((await get(copyUrl(exam.attemptId, "json"), student.headers)).statusCode).toBe(200);
    expect((await exportsOf(student.id, since)).map((r) => ({ subjectType: r.subjectType, payload: r.payload }))).toEqual([
      { subjectType: "user", payload: { kind: "student-copy", attemptId: exam.attemptId } },
    ]);
    // Nor somebody else's refused read.
    await get(copyUrl(exam.attemptId, "json"), stranger.headers);
    expect(await exportsOf(stranger.id, since)).toEqual([]);
  });
});

/*
 * A server whose Typst binary is missing (ADR-125 §3): the PDF is
 * `503 pdf_unavailable`, which neither counts in the bucket nor writes an
 * audit row; the JSON is served.
 */
describe("a PDF the server cannot make", () => {
  let bare: TestServer;
  beforeAll(async () => {
    bare = await testServer({ TYPST_BIN: "/nonexistent/typst" });
  });
  afterAll(async () => {
    await bare.close();
  });

  it("answers 503, counts no slot and audits nothing", async () => {
    const reader = await bare.signIn("student");
    const db = bare.app.db;
    const seed = await seedLive(db, { studentIds: [reader.id], questions: 0, mode: "exercise" });
    const { id } = await poolService.createQuestion(db, { poolId: seed.poolId, type: "short", internalName: "q", createdBy: seed.teacherId });
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    await poolService.putDraft(db, question!, { config: QUESTIONS.short });
    await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
    await addItems(db, await reload(db, seed.evaluationId), [id], () => 1, { attemptCount: 0 });
    const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", bare.clock.now());
    await live.closeEvaluation(db, evaluation, bare.clock.now());

    const since = bare.clock.now();
    for (let i = 0; i < STUDENT_DOCUMENTS_PER_HOUR + 1; i++) {
      const res = await bare.app.inject({ method: "GET", url: printUrl(seed.evaluationId), headers: reader.headers });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "pdf_unavailable" });
    }
    const rows = (await db.select().from(auditLog).where(eq(auditLog.action, "privacy.export"))).filter((r) => r.createdAt >= since);
    expect(rows).toEqual([]);
  });
});
