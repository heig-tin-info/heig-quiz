/**
 * The student's concept mastery (ADR-098, #599 step 9b), over HTTP and the
 * real migrations: the bands and the threshold, what counts (a validated
 * course concept, a card whose key the student may see), who reaches it, and
 * the leak test of 05 §5.7 for this exit — forbidden keys, then a search of
 * the serialized answer for what must never be in it, for a student, a
 * teacher in the student view and an impersonation session.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CSRF_COOKIE, StudentConceptMastery, type SessionKind } from "@quiz/contracts";
import { drillRetrievability } from "@quiz/domain/drillSchedule";
import { registerForTests } from "@quiz/registry/server";

import { SESSION_COOKIE, createSession } from "../../auth/session.js";
import { classrooms, concepts, drillCards, enrollments, evaluations, questionConcepts } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { kioskStation } from "../../test/kiosk.js";
import { publishQuestion, reload, seedLive, type Seeded } from "../../test/live.js";
import { addItems, applyState, byId, createEvaluation, setAllowDrill } from "../evaluation/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { releaseResults, unreleaseResults } from "../results/service.js";
import * as live from "../live/service.js";

type Headers = Record<string, string>;
type Session = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let seed: Seeded;
let teacher: Session;
let admin: Session;
let alice: Session;
let bob: Session;
let outsider: Session;

const NOW = "2026-11-20T10:00:00.000Z";
const url = (id = seed.classroomId) => `/app/api/student/classrooms/${id}/drill/mastery`;
const get = (path: string, headers: Headers) => server.app.inject({ method: "GET", url: path, headers });

const ids = { solid: randomUUID(), few: randomUUID(), idle: randomUUID(), proposed: randomUUID(), foreign: randomUUID() };
const LABELS = {
  solid: "Pointers",
  few: "Recursion",
  idle: "Idle concept",
  proposed: "Proposed secret label",
  foreign: "Foreign secret label",
};
/** The exam of ADR-098 §7: its questions and its cards, never to appear in an answer. */
const exam = { questionIds: [] as string[], cardIds: [] as string[] };
/** The raw numbers the answer must not contain. */
const raw: number[] = [];

async function sessionOf(userId: string, auth: { kind: SessionKind; actorUserId?: string; evaluationId?: string; deviceId?: string }) {
  const session = await createSession(server.app.db, userId, 8, {
    kind: auth.kind,
    actorUserId: auth.actorUserId ?? null,
    evaluationId: auth.evaluationId ?? null,
    deviceId: auth.deviceId ?? null,
    projectId: null,
  });
  return { cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrf}`, "x-csrf-token": session.csrf };
}

async function cardOf(userId: string, question: number) {
  const [card] = await server.app.db
    .select()
    .from(drillCards)
    .where(and(eq(drillCards.userId, userId), eq(drillCards.questionId, seed.questionIds[question]!)));
  return card!;
}

/** The state the scheduler left: reviewed `daysAgo` days before NOW with this stability (null: never). */
async function setState(userId: string, question: number, stability: number, daysAgo: number | null) {
  const lastReviewAt = daysAgo === null ? null : new Date(new Date(NOW).getTime() - daysAgo * 86_400_000);
  const card = await cardOf(userId, question);
  await server.app.db
    .update(drillCards)
    .set({ stability, difficulty: 5, reps: 2, lastReviewAt })
    .where(eq(drillCards.id, card.id));
  return drillRetrievability({ ...card, stability, difficulty: 5, reps: 2, lastReviewAt }, new Date(NOW));
}

const putConcepts = (conceptIds: string[]) =>
  server.app.inject({
    method: "PUT",
    url: `/app/api/courses/${seed.courseId}/concepts`,
    headers: teacher.headers,
    payload: { conceptIds },
  });
const ALL = () => [ids.few, ids.idle, ids.proposed, ids.solid];

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  admin = await server.signIn("admin");
  alice = await server.signIn("student");
  bob = await server.signIn("student");
  outsider = await server.signIn("student");
  const db = server.app.db;
  seed = await seedLive(db, { teacherId: teacher.id, studentIds: [alice.id, bob.id], mode: "exercise", questions: 6 });
  // The teacher also sits the classroom on a staff seat (ADR-018).
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId: seed.classroomId,
    nom: "Teacher",
    prenom: "Seated",
    email: "seated@heig.test",
    userId: teacher.id,
    claimedAt: new Date(),
    staff: true,
  });
  const on = await server.app.inject({
    method: "PUT",
    url: `/app/api/classrooms/${seed.classroomId}/drill`,
    headers: teacher.headers,
    payload: { enabled: true },
  });
  expect(on.statusCode).toBe(200);
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
  for (const userId of seed.studentIds) {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, server.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, server.clock.now());
    await live.submitAttempt(db, evaluation, attempt, server.clock.now());
  }

  const at = new Date(NOW);
  const concept = (id: string, status: "validated" | "proposed", en: string, fr: string | null) => ({
    id,
    status,
    labelEn: en,
    keyEn: en.toLowerCase(),
    labelFr: fr,
    keyFr: fr?.toLowerCase() ?? null,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(concepts).values([
    concept(ids.solid, "validated", LABELS.solid, "Pointeurs"),
    concept(ids.few, "validated", LABELS.few, null),
    concept(ids.idle, "validated", LABELS.idle, null),
    concept(ids.proposed, "proposed", LABELS.proposed, null),
    concept(ids.foreign, "validated", LABELS.foreign, null),
  ]);
  const q = seed.questionIds;
  await db.insert(questionConcepts).values([
    // Five cards on `solid`, four on `few`, and the proposed one rides on five.
    ...[0, 1, 2, 3, 4].map((i) => ({ questionId: q[i]!, conceptId: ids.solid })),
    ...[0, 1, 2, 3].map((i) => ({ questionId: q[i]!, conceptId: ids.few })),
    ...[0, 1, 2, 3, 4].map((i) => ({ questionId: q[i]!, conceptId: ids.proposed })),
    // The sixth question belongs to a concept the course does not declare.
    { questionId: q[5]!, conceptId: ids.foreign },
  ]);
  expect((await putConcepts(ALL())).statusCode).toBe(200);

  // Alice: strong everywhere. Bob: weak (long ago, a short memory).
  for (let i = 0; i < 6; i++) {
    raw.push(await setState(alice.id, i, 1000, 1));
    raw.push(await setState(bob.id, i, 0.5, 40));
  }
  server.clock.set(NOW);
});

afterAll(async () => {
  await server.close();
  restore();
});

const read = async (headers: Headers, lang = "en") => {
  const res = await get(url(), { ...headers, "accept-language": lang });
  expect(res.statusCode).toBe(200);
  return { body: StudentConceptMastery.parse(res.json()), text: res.body };
};
const levelOf = (body: StudentConceptMastery, id: string) => body.concepts.find((c) => c.concept.id === id)!;

describe("the student's concept mastery: the rule", () => {
  it("gives a band from five cards, 'no data' below, in label order, validated concepts only", async () => {
    const { body } = await read(alice.headers);
    expect(body.declared).toBe(true);
    expect(body.concepts.map((c) => [c.concept.label, c.level, c.cards])).toEqual([
      [LABELS.idle, null, 0],
      [LABELS.solid, "solid", 5],
      [LABELS.few, null, 4],
    ]);
  });

  it("is the caller's own level: Bob's weak cards give Bob 'to work on'", async () => {
    const { body } = await read(bob.headers);
    expect(levelOf(body, ids.solid)).toMatchObject({ level: "work", cards: 5 });
  });

  it("labels in the reader's language", async () => {
    const { body } = await read(alice.headers, "fr");
    expect(levelOf(body, ids.solid).concept.label).toBe("Pointeurs");
    expect(levelOf(body, ids.few).concept.label).toBe(LABELS.few);
  });

  it("counts reviewed cards only", async () => {
    await setState(alice.id, 4, 5, null);
    expect(levelOf((await read(alice.headers)).body, ids.solid)).toMatchObject({ cards: 4, level: null });
    await setState(alice.id, 4, 1000, 1);
  });

  it("leaves out a card whose key the student may not see (a suspended or unreleased one)", async () => {
    const db = server.app.db;
    const [before] = await db.select().from(evaluations).where(eq(evaluations.id, seed.evaluationId));
    try {
      await db
        .update(evaluations)
        .set({ feedbackPolicy: { ...(before!.feedbackPolicy as object), showKey: false } })
        .where(eq(evaluations.id, seed.evaluationId));
      const { body } = await read(alice.headers);
      expect(body.declared).toBe(true);
      expect(body.concepts.every((c) => c.cards === 0 && c.level === null)).toBe(true);
    } finally {
      await db.update(evaluations).set({ feedbackPolicy: before!.feedbackPolicy }).where(eq(evaluations.id, seed.evaluationId));
    }
    expect((await read(alice.headers)).body.concepts.some((c) => c.cards > 0)).toBe(true);
  });

  it("shows nothing when the drill is off, or the course lists no validated concept", async () => {
    const db = server.app.db;
    const nothing = { declared: false, concepts: [] };
    await db.update(classrooms).set({ drillEnabledAt: null }).where(eq(classrooms.id, seed.classroomId));
    expect((await read(alice.headers)).body).toEqual(nothing);
    await db.update(classrooms).set({ drillEnabledAt: new Date(NOW) }).where(eq(classrooms.id, seed.classroomId));
    expect((await putConcepts([ids.proposed])).statusCode).toBe(200);
    expect((await read(alice.headers)).body).toEqual(nothing);
    expect((await putConcepts([])).statusCode).toBe(200);
    expect((await read(alice.headers)).body).toEqual(nothing);
    expect((await putConcepts(ALL())).statusCode).toBe(200);
  });
});

describe("the student's concept mastery: an exam on a course concept (ADR-098 §7)", () => {
  /** The cards of the exam's questions for Alice and Bob, reviewed a day ago and strong. */
  async function reviewExamCards() {
    const db = server.app.db;
    for (const userId of [alice.id, bob.id]) {
      for (const questionId of exam.questionIds) {
        const [card] = await db
          .select()
          .from(drillCards)
          .where(and(eq(drillCards.userId, userId), eq(drillCards.questionId, questionId)));
        exam.cardIds.push(card!.id);
        await db
          .update(drillCards)
          .set({ stability: 1000, difficulty: 5, reps: 2, lastReviewAt: new Date(new Date(NOW).getTime() - 86_400_000) })
          .where(eq(drillCards.id, card!.id));
      }
    }
  }
  const idle = async () => levelOf((await read(alice.headers)).body, ids.idle);

  it("counts nothing until its results are released, then five cards, and nothing again once the release is withdrawn", async () => {
    const db = server.app.db;
    const now = server.clock.now();
    for (let i = 0; i < 5; i++) {
      exam.questionIds.push(await publishQuestion(db, seed.poolId, teacher.id, `exam-secret-${i}`));
    }
    await db.insert(questionConcepts).values(exam.questionIds.map((questionId) => ({ questionId, conceptId: ids.idle })));
    const created = await createEvaluation(db, {
      classroomId: seed.classroomId,
      title: "Exam on a course concept",
      mode: "exam",
      createdBy: teacher.id,
    });
    await addItems(
      db,
      (await byId(db, created.id))!,
      exam.questionIds,
      (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
      { attemptCount: 0 },
    );
    await setAllowDrill(db, await reload(db, created.id), true, now);
    let evaluation = await applyState(db, await reload(db, created.id), "running", now);
    for (const userId of [alice.id, bob.id]) {
      const participant = (await live.participantOf(db, evaluation, userId))!;
      const attempt = await live.beginAttempt(db, evaluation, await live.ensureAttempt(db, evaluation, participant, now), participant, now);
      expect(attempt).toBeTruthy();
    }
    evaluation = await live.closeEvaluation(db, evaluation, now);

    // Closed, not released: no card, no count.
    expect(await idle()).toMatchObject({ cards: 0, level: null });

    await releaseResults(db, await reload(db, created.id), now);
    await reviewExamCards();
    expect(await idle()).toMatchObject({ cards: 5, level: "solid" });

    // Withdrawn: the cards stay, suspended, and count for nothing.
    await unreleaseResults(db, await reload(db, created.id), now);
    expect(await idle()).toMatchObject({ cards: 0, level: null });
  });
});

const FORBIDDEN_KEYS = [
  "retrievability",
  "stability",
  "difficulty",
  "dueAt",
  "reviewedAt",
  "lastReviewAt",
  "questionId",
  "cardId",
  "internalName",
  "statement",
  "explanation",
  "tags",
  "status",
  "aliases",
  "userId",
  "students",
  "confidence",
  "average",
  "rank",
];

describe("the student's concept mastery: the leak test (05 §5.7)", () => {
  const callers: [string, () => Promise<Headers>][] = [
    ["a claimed student", async () => alice.headers],
    ["a teacher in the student view", async () => teacher.headers],
    ["an impersonation session", () => sessionOf(alice.id, { kind: "impersonation", actorUserId: admin.id })],
  ];

  it.each(callers)("%s reads nothing but the course's validated concepts, a band and a count", async (_name, headers) => {
    const { body, text } = await read(await headers());
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(JSON.parse(text));
    expect([...keys].sort()).toEqual(["cards", "concept", "concepts", "declared", "id", "label", "level", "qualifier"]);
    for (const key of FORBIDDEN_KEYS) expect(keys.has(key)).toBe(false);
    expect(body.concepts.map((c) => c.concept.id).sort()).toEqual([ids.few, ids.idle, ids.solid].sort());

    // (a) the non-course concept, (b) the proposed course concept.
    for (const needle of [ids.foreign, LABELS.foreign, ids.proposed, LABELS.proposed]) expect(text).not.toContain(needle);
    // (c) the questions of the cards: statements, answers, internal names, ids; the cards' ids.
    expect(text).not.toMatch(/Statement of|answer-q/);
    for (let i = 0; i < 6; i++) expect(text).not.toContain(`q${i}`);
    for (const id of seed.questionIds) expect(text).not.toContain(id);
    for (const userId of seed.studentIds) {
      for (let i = 0; i < 6; i++) expect(text).not.toContain((await cardOf(userId, i)).id);
    }
    // The exam's cards, unreleased then withdrawn (ADR-098 §7, §9): their questions, names and cards, and no effect on a level.
    expect(exam.questionIds).toHaveLength(5);
    expect(text).not.toContain("exam-secret");
    for (const id of [...exam.questionIds, ...exam.cardIds]) expect(text).not.toContain(id);
    expect(body.concepts.map((c) => [c.concept.id, c.cards])).toEqual(
      expect.arrayContaining([[ids.idle, 0]]),
    );
    // An impersonation session reads exactly what the student reads.
    if (_name === "an impersonation session") expect(text).toBe((await read(alice.headers)).text);
    // (d) the raw numbers of retrievability.
    expect(raw.length).toBeGreaterThan(0);
    for (const r of raw) expect(text).not.toContain(String(r).slice(0, 6));
    // (e) another student's evidence: Bob's identity.
    for (const needle of [bob.id, "Nom1", "Prenom1"]) expect(text).not.toContain(needle);
  });

  it("gives the teacher's seat the student shape for its own cards, not the class's", async () => {
    const { body } = await read(teacher.headers);
    expect(body.concepts.every((c) => c.cards === 0 && c.level === null)).toBe(true);
  });

});

describe("the student's concept mastery: access", () => {
  it("is a 404 for someone off the classroom or a missing classroom, a 401 without a session", async () => {
    expect((await get(url(), outsider.headers)).statusCode).toBe(404);
    expect((await get(url(randomUUID()), alice.headers)).statusCode).toBe(404);
    expect((await get(url(), {})).statusCode).toBe(401);
  });

  it("refuses a seb and a kiosk session with a 401 (portal sessions only)", async () => {
    const seb = await sessionOf(alice.id, { kind: "seb", evaluationId: seed.evaluationId });
    expect((await get(url(), seb)).statusCode).toBe(401);
    // A kiosk session counts for nothing without its station's cookie beside it, and nothing with it.
    const station = await kioskStation(server.app);
    const kiosk = await sessionOf(alice.id, { kind: "kiosk", evaluationId: seed.evaluationId, deviceId: station.deviceId });
    expect((await get(url(), { ...kiosk, cookie: `${kiosk.cookie}; ${station.cookie}` })).statusCode).toBe(401);
  });

  it("is a 404 to an impersonation of a student with no seat in the classroom", async () => {
    const as = await sessionOf(outsider.id, { kind: "impersonation", actorUserId: admin.id });
    expect((await get(url(), as)).statusCode).toBe(404);
  });
});
