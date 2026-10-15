/**
 * Targeted revision by concept (ADR-115, F-DRILL-08), over HTTP and the real
 * migrations: what a round holds and in what order, the passes and the
 * relearning step, the drill's day, what it never writes (a review, a card),
 * how it holds the daily session back, who may revise, the retention and the
 * cascades — and the leak test of 05 §5.7 for its exits: question content
 * through the daily serve's own `studentView`, concept labels through the
 * drill module's student list only.
 *
 * Fixture, around Alice in classroom A: a validated concept the course
 * declares ("Pointers") with a validated narrower concept and a proposed
 * narrower one that it does not; a proposed concept the course declares; a
 * validated concept it does not; a second declared concept and an idle one.
 * An exercise of fifteen questions carrying them, with internal names,
 * explanations and statements; an exam on "Pointers" released then withdrawn
 * (its cards suspended) and one never released (no card); Bob's cards; and
 * Alice's card of classroom B.
 */
import { randomUUID } from "node:crypto";

import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrillSession, RevisionAnswerResult, RevisionRoundStart, RevisionServed, StudentRevisionConcepts, StudentRevisionRound, type RevisionRound } from "@quiz/contracts";
import { revisionNext, type RevisionAnswer } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import {
  classrooms,
  conceptRelations,
  concepts,
  drillCards,
  drillReviews,
  drillRevisionAnswers,
  drillRevisionRounds,
  enrollments,
  questionConcepts,
  questionVersions,
  users,
} from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { sessionOf, testServer, type Payload, type TestServer } from "../../test/http.js";
import { kioskStation } from "../../test/kiosk.js";
import { handIn, publishQuestion, reload, seedLive, type Seeded } from "../../test/live.js";
import { addItems, applyState, byId, createEvaluation, setAllowDrill } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { FORBIDDEN_STUDENT_KEYS } from "../live/studentView.js";
import { setDrillOptOut } from "../org/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { releaseResults, unreleaseResults } from "../results/service.js";
import { purgeExpiredDrill } from "./service.js";

type Headers = Record<string, string>;
type Session = Awaited<ReturnType<TestServer["signIn"]>>;
type Card = typeof drillCards.$inferSelect;

let server: TestServer;
let restore: () => void;
let seed: Seeded;
let other: Seeded;
let teacher: Session;
let admin: Session;
let alice: Session;
let bob: Session;
let outsider: Session;

/** 09:00 in Zurich on a Friday; the drill's day ends at 23:00 UTC. */
const T0 = "2026-11-20T08:00:00.000Z";
const db = () => server.app.db;

const ids = {
  course: randomUUID(),
  narrow: randomUUID(),
  proposedNarrow: randomUUID(),
  proposed: randomUUID(),
  foreign: randomUUID(),
  second: randomUUID(),
  idle: randomUUID(),
};
const LABELS = {
  course: "Pointers",
  narrow: "Narrower secret label",
  proposedNarrow: "Proposed narrower secret",
  proposed: "Proposed secret label",
  foreign: "Foreign secret label",
  second: "Recursion",
  idle: "Idle concept",
};
/** The questions, by role; `main` carry "Pointers" itself. */
const Q = {
  main: [] as string[],
  narrow: "",
  proposedNarrow: "",
  proposed: "",
  foreign: "",
  second: "",
  withdrawn: "",
  never: "",
  otherRoom: "",
};
const KEY = new Map<string, string>();
/** Every body a student caller received, and the one key its root may carry beyond the list: what the leak test searches. */
const seen: { body: string; root: string | null }[] = [];

const inject = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, headers: Headers, payload?: Payload) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
async function as(headers: Headers, method: "GET" | "POST", url: string, payload?: Payload) {
  const res = await inject(method, url, headers, payload);
  // The key after an answer (`studentSolutionView`), and the concepts exit's own list (ADR-098, ADR-115).
  const root = url.endsWith("/answer") ? "solution" : url.endsWith("/revision/concepts") ? "concepts" : null;
  if (res.statusCode < 300 && res.body) seen.push({ body: res.body, root });
  return res;
}
const conceptsUrl = (room = seed.classroomId) => `/app/api/student/classrooms/${room}/revision/concepts`;
const roundsUrl = (room = seed.classroomId) => `/app/api/student/classrooms/${room}/revision/rounds`;
const serveUrl = (round: string, card: string) => `/app/api/student/revision/rounds/${round}/serve/${card}`;
const answerUrl = (round: string, card: string) => `/app/api/student/revision/rounds/${round}/cards/${card}/answer`;
const endUrl = (round: string) => `/app/api/student/revision/rounds/${round}/end`;

/** A published question on `conceptIds`, its internal name, explanation and statement marked. */
async function question(poolId: string, name: string, conceptIds: string[], excluded: boolean) {
  const statement = excluded ? `EXCLUDED-statement-${name}` : `Visible statement ${name}`;
  const answer = `key-${name}`;
  const id = await publishQuestion(db(), poolId, teacher.id, excluded ? `EXCLUDED-internal-${name}` : `INTERNAL-${name}`, {
    type: "short",
    config: { statement, answer },
  });
  await db().update(questionVersions).set({ explanation: `EXPLANATION-SECRET-${name}` }).where(eq(questionVersions.questionId, id));
  await db().insert(questionConcepts).values(conceptIds.map((conceptId) => ({ questionId: id, conceptId })));
  KEY.set(id, answer);
  return id;
}

async function addTo(evaluationId: string, questionIds: string[]) {
  await addItems(
    db(),
    (await byId(db(), evaluationId))!,
    questionIds,
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
}

/** An exam of classroom A on one question, sat by Alice and Bob and closed; released then withdrawn when `withdrawn`. */
async function exam(questionId: string, withdrawn: boolean) {
  const now = server.clock.now();
  const created = await createEvaluation(db(), { classroomId: seed.classroomId, title: `Exam ${questionId}`, mode: "exam", createdBy: teacher.id });
  await addTo(created.id, [questionId]);
  await setAllowDrill(db(), await reload(db(), created.id), true, now);
  const evaluation = await applyState(db(), await reload(db(), created.id), "running", now);
  for (const userId of [alice.id, bob.id]) {
    const participant = (await live.participantOf(db(), evaluation, userId))!;
    await live.beginAttempt(db(), evaluation, await live.ensureAttempt(db(), evaluation, participant, now), participant, now);
  }
  await live.closeEvaluation(db(), evaluation, now);
  if (withdrawn) {
    await releaseResults(db(), await reload(db(), created.id), now);
    await unreleaseResults(db(), await reload(db(), created.id), now);
  }
}

async function cardOf(userId: string, questionId: string): Promise<Card> {
  const [card] = await db()
    .select()
    .from(drillCards)
    .where(and(eq(drillCards.userId, userId), eq(drillCards.questionId, questionId)));
  return card!;
}
const keyOf = async (cardId: string) => {
  const [card] = await db().select().from(drillCards).where(eq(drillCards.id, cardId));
  return KEY.get(card!.questionId)!;
};

/** The state the scheduler left: reviewed `daysAgo` days before T0, due the day after. */
async function setState(cardId: string, stability: number, daysAgo: number) {
  const lastReviewAt = new Date(new Date(T0).getTime() - daysAgo * 86_400_000);
  await db()
    .update(drillCards)
    .set({ stability, difficulty: 5, reps: 2, lastReviewAt, dueAt: new Date(lastReviewAt.getTime() + 86_400_000) })
    .where(eq(drillCards.id, cardId));
}

const aliceCards = () => db().select().from(drillCards).where(eq(drillCards.userId, alice.id)).orderBy(drillCards.id);
const aliceReviews = async () =>
  (
    await db()
      .select({ n: count() })
      .from(drillReviews)
      .innerJoin(drillCards, eq(drillCards.id, drillReviews.cardId))
      .where(eq(drillCards.userId, alice.id))
  )[0]!.n;
const roundRow = async (id: string) => (await db().select().from(drillRevisionRounds).where(eq(drillRevisionRounds.id, id)))[0]!;

async function start(headers: Headers, conceptId: string, room = seed.classroomId) {
  const res = await as(headers, "POST", roundsUrl(room), { conceptId });
  expect(res.statusCode, res.body).toBe(200);
  return RevisionRoundStart.parse(res.json()).round;
}
async function serve(round: string, card: string, headers = alice.headers) {
  const res = await as(headers, "POST", serveUrl(round, card));
  expect(res.statusCode, res.body).toBe(200);
  return RevisionServed.parse(res.json());
}
async function answer(round: string, card: string, given: string, headers = alice.headers) {
  const res = await as(headers, "POST", answerUrl(round, card), { answer: given });
  expect(res.statusCode, res.body).toBe(200);
  return RevisionAnswerResult.parse(res.json());
}

let snapshot: Card[];
let reviewsBefore: number;
let dailyBefore: DrillSession;
/** The card ids of Alice's cards, by role. */
const C = { narrow: "", proposedNarrow: "", main: [] as string[], newOnes: [] as string[] };
/** Cards no round of Alice's may ever hold. */
const excludedCards: string[] = [];

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set(T0);
  teacher = await server.signIn("teacher");
  admin = await server.signIn("admin");
  alice = await server.signIn("student");
  bob = await server.signIn("student");
  outsider = await server.signIn("student");
  seed = await seedLive(db(), { teacherId: teacher.id, studentIds: [alice.id, bob.id], mode: "exercise", questions: 0 });
  other = await seedLive(db(), { teacherId: teacher.id, studentIds: [alice.id], mode: "exercise", questions: 0 });
  // The teacher also sits classroom A on a staff seat (ADR-018).
  await db().insert(enrollments).values({
    id: randomUUID(),
    classroomId: seed.classroomId,
    nom: "Teacher",
    prenom: "Seated",
    email: "seated@heig.test",
    userId: teacher.id,
    claimedAt: new Date(),
    staff: true,
  });

  const at = new Date(T0);
  const concept = (id: string, status: "validated" | "proposed", en: string, fr: string | null = null) => ({
    id,
    status,
    labelEn: en,
    keyEn: en.toLowerCase(),
    labelFr: fr,
    keyFr: fr?.toLowerCase() ?? null,
    createdAt: at,
    updatedAt: at,
  });
  await db().insert(concepts).values([
    concept(ids.course, "validated", LABELS.course, "Pointeurs"),
    concept(ids.narrow, "validated", LABELS.narrow),
    concept(ids.proposedNarrow, "proposed", LABELS.proposedNarrow),
    concept(ids.proposed, "proposed", LABELS.proposed),
    concept(ids.foreign, "validated", LABELS.foreign),
    concept(ids.second, "validated", LABELS.second),
    concept(ids.idle, "validated", LABELS.idle),
  ]);
  await db().insert(conceptRelations).values([
    { conceptId: ids.narrow, targetId: ids.course, kind: "broader" },
    { conceptId: ids.proposedNarrow, targetId: ids.course, kind: "broader" },
  ]);
  for (const [courseId, list] of [
    [seed.courseId, [ids.course, ids.proposed, ids.second, ids.idle]],
    [other.courseId, [ids.course]],
  ] as const) {
    const put = await inject("PUT", `/app/api/courses/${courseId}/concepts`, teacher.headers, { conceptIds: [...list] });
    expect(put.statusCode, put.body).toBe(200);
  }

  for (let i = 0; i < 9; i++) Q.main.push(await question(seed.poolId, `main${i}`, [ids.course], false));
  Q.narrow = await question(seed.poolId, "narrow", [ids.narrow], false);
  Q.proposedNarrow = await question(seed.poolId, "proposedNarrow", [ids.proposedNarrow], false);
  Q.proposed = await question(seed.poolId, "proposed", [ids.proposed], true);
  Q.foreign = await question(seed.poolId, "foreign", [ids.foreign], true);
  Q.second = await question(seed.poolId, "second", [ids.second], true);
  Q.withdrawn = await question(seed.poolId, "withdrawn", [ids.course], true);
  Q.never = await question(seed.poolId, "never", [ids.course], true);
  Q.otherRoom = await question(other.poolId, "otherRoom", [ids.course], true);
  await addTo(seed.evaluationId, [...Q.main, Q.narrow, Q.proposedNarrow, Q.proposed, Q.foreign, Q.second]);
  await addTo(other.evaluationId, [Q.otherRoom]);

  for (const s of [seed, other]) {
    const on = await inject("PUT", `/app/api/classrooms/${s.classroomId}/drill`, teacher.headers, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    await handIn(db(), s, server.clock.now());
  }
  await exam(Q.withdrawn, true);
  await exam(Q.never, false);

  C.narrow = (await cardOf(alice.id, Q.narrow)).id;
  C.proposedNarrow = (await cardOf(alice.id, Q.proposedNarrow)).id;
  for (const q of Q.main) C.main.push((await cardOf(alice.id, q)).id);
  // The weakest first: the narrower concept's card, then the proposed narrower's, then main1, then main0.
  await setState(C.narrow, 0.5, 40);
  await setState(C.proposedNarrow, 2, 40);
  await setState(C.main[1]!, 5, 10);
  await setState(C.main[0]!, 1000, 1);
  C.newOnes = C.main.slice(2).sort();

  excludedCards.push(
    (await cardOf(alice.id, Q.withdrawn)).id,
    (await cardOf(alice.id, Q.proposed)).id,
    (await cardOf(alice.id, Q.foreign)).id,
    (await cardOf(alice.id, Q.second)).id,
    (await cardOf(alice.id, Q.otherRoom)).id,
    ...(await db().select().from(drillCards).where(eq(drillCards.userId, bob.id))).map((c) => c.id),
  );
  // The never-released exam made no card at all.
  expect(await db().select().from(drillCards).where(eq(drillCards.questionId, Q.never))).toHaveLength(0);

  snapshot = await aliceCards();
  reviewsBefore = await aliceReviews();
  const daily = await inject("GET", "/app/api/drill/session", alice.headers);
  dailyBefore = DrillSession.parse(daily.json());
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("targeted revision: the concepts on offer", () => {
  it("offers the course's validated concepts, by label, in the reader's language", async () => {
    const res = await as(alice.headers, "GET", conceptsUrl());
    expect(res.statusCode).toBe(200);
    expect(StudentRevisionConcepts.parse(res.json())).toEqual({
      available: true,
      concepts: [
        { id: ids.idle, label: LABELS.idle, qualifier: "" },
        { id: ids.course, label: LABELS.course, qualifier: "" },
        { id: ids.second, label: LABELS.second, qualifier: "" },
      ],
    });
    const fr = await as({ ...alice.headers, "accept-language": "fr" }, "GET", conceptsUrl());
    expect(StudentRevisionConcepts.parse(fr.json()).concepts.find((c) => c.id === ids.course)!.label).toBe("Pointeurs");
  });
});

let round1: RevisionRound;
let round2: RevisionRound;

describe("targeted revision: a round", () => {
  it("answers null, and writes nothing, when no card of the caller covers the concept", async () => {
    expect(await start(alice.headers, ids.idle)).toBeNull();
    expect(await db().select().from(drillRevisionRounds)).toHaveLength(0);
  });

  it("refuses a concept not on offer with a 404, and a body off the contract with a 400", async () => {
    for (const conceptId of [ids.proposed, ids.narrow, ids.foreign, ids.proposedNarrow, randomUUID()]) {
      expect((await inject("POST", roundsUrl(), alice.headers, { conceptId })).statusCode).toBe(404);
    }
    expect((await inject("POST", roundsUrl(), alice.headers, { conceptId: ids.course, size: 3 })).statusCode).toBe(400);
    expect((await inject("POST", roundsUrl(), alice.headers, { conceptId: "nope" })).statusCode).toBe(400);
    expect(await db().select().from(drillRevisionRounds)).toHaveLength(0);
  });

  it("holds ten of the caller's own cards on the concept and its narrower ones, the weakest reviewed first, then the new", async () => {
    round1 = (await start(alice.headers, ids.course))!;
    expect(round1.concept).toEqual({ id: ids.course, label: LABELS.course, qualifier: "" });
    expect(round1.startedAt).toBe(T0);
    const order = round1.cards.map((c) => c.id);
    // The proposed narrower concept counts under the validated declared one (ADR-115, by assumption).
    expect(order).toEqual([C.narrow, C.proposedNarrow, C.main[1], C.main[0], ...C.newOnes.slice(0, 6)]);
    expect(round1.cards.map((c) => c.isNew)).toEqual([false, false, false, false, true, true, true, true, true, true]);
    expect(round1.cards[0]).toMatchObject({ type: "short", courseCode: `PRG-${seed.courseId}` });
    for (const id of excludedCards) expect(order).not.toContain(id);
    expect((await roundRow(round1.id)).cardIds).toEqual(order);
  });

  it("serves a card at its first pass through the student view, the same seed on a reload", async () => {
    const first = await serve(round1.id, C.narrow);
    expect(first).toEqual({ cardId: C.narrow, type: "short", student: { statement: "Visible statement narrow" }, pass: 1 });
    expect(await serve(round1.id, C.narrow)).toEqual(first);
    const rows = await db().select().from(drillRevisionAnswers).where(eq(drillRevisionAnswers.cardId, C.narrow));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pass: 1, servedAt: new Date(T0), answeredAt: null, correctness: null, timeMs: null });
  });

  it("takes a card served in a round out of today's daily session: the daily serve and answer are 404s", async () => {
    expect(dailyBefore.cards.map((c) => c.id)).toContain(C.narrow);
    const daily = DrillSession.parse((await inject("GET", "/app/api/drill/session", alice.headers)).json());
    expect(daily.cards.map((c) => c.id)).not.toContain(C.narrow);
    expect((await inject("POST", `/app/api/drill/cards/${C.narrow}/serve`, alice.headers)).statusCode).toBe(404);
    const review = await inject("POST", `/app/api/drill/cards/${C.narrow}/answer`, alice.headers, { answer: "x", deviceClass: "fine" });
    expect(review.statusCode).toBe(404);
  });

  it("refuses a confidence or a device class in the answer (400), and an answer before the serve (409)", async () => {
    for (const extra of [{ confidence: 3 }, { deviceClass: "fine" }]) {
      const res = await inject("POST", answerUrl(round1.id, C.narrow), alice.headers, { answer: "x", ...extra });
      expect(res.statusCode).toBe(400);
    }
    const early = await inject("POST", answerUrl(round1.id, C.main[0]!), alice.headers, { answer: "x" });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: "drill_not_served" });
  });

  it("brings a wrong first pass back once: requeued, the key shown, a second pass, then no pass left", async () => {
    server.clock.set(new Date(new Date(T0).getTime() + 5_000));
    const wrong = await answer(round1.id, C.narrow, "nope");
    expect(wrong).toEqual({ correctness: "wrong", points: 0, maxPoints: 1, solution: { answer: "key-narrow" }, requeued: true });
    const [pass1] = await db().select().from(drillRevisionAnswers).where(eq(drillRevisionAnswers.cardId, C.narrow));
    expect(pass1).toMatchObject({ correctness: "wrong", timeMs: 5_000 });
    expect((await inject("POST", answerUrl(round1.id, C.narrow), alice.headers, { answer: "x" })).statusCode).toBe(409);

    expect((await serve(round1.id, C.narrow)).pass).toBe(2);
    expect(await answer(round1.id, C.narrow, "key-narrow")).toMatchObject({ correctness: "right", points: 1, requeued: false });
    const none = await inject("POST", serveUrl(round1.id, C.narrow), alice.headers);
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ error: "revision_answered" });
  });

  it("measures the time on the server's clock, capped at the idle cap", async () => {
    await serve(round1.id, C.proposedNarrow);
    server.clock.set(new Date(server.clock.now().getTime() + 3_600_000));
    await answer(round1.id, C.proposedNarrow, "key-proposedNarrow");
    const [row] = await db().select().from(drillRevisionAnswers).where(eq(drillRevisionAnswers.cardId, C.proposedNarrow));
    expect(row!.timeMs).toBe(600_000);
  });

  it("ends the round once nothing is left to answer, with its two counters", async () => {
    const order = round1.cards.map((c) => c.id);
    const given: RevisionAnswer[] = [
      { cardId: C.narrow, pass: 1, correctness: "wrong" },
      { cardId: C.narrow, pass: 2, correctness: "right" },
      { cardId: C.proposedNarrow, pass: 1, correctness: "right" },
    ];
    for (let next = revisionNext({ order, answers: given }); next !== null; next = revisionNext({ order, answers: given })) {
      expect(next.pass).toBe(1);
      expect((await roundRow(round1.id)).endedAt).toBeNull();
      await serve(round1.id, next.cardId);
      expect((await answer(round1.id, next.cardId, await keyOf(next.cardId))).requeued).toBe(false);
      given.push({ ...next, correctness: "right" });
    }
    expect(await roundRow(round1.id)).toMatchObject({ endedAt: server.clock.now(), cardsServed: 10, cardsCorrect: 9 });
    expect((await inject("POST", serveUrl(round1.id, C.main[0]!), alice.headers)).statusCode).toBe(404);
  });

  it("writes no review and leaves every card as it was", async () => {
    expect(await aliceReviews()).toBe(reviewsBefore);
    expect(await aliceCards()).toEqual(snapshot);
  });

  it("puts the cards practised today last in another round", async () => {
    round2 = (await start(alice.headers, ids.course))!;
    const order = round2.cards.map((c) => c.id);
    expect(order).toHaveLength(10);
    expect(order[0]).toBe(C.newOnes[6]);
    expect(order.slice(1, 5)).toEqual([C.narrow, C.proposedNarrow, C.main[1], C.main[0]]);
    await serve(round2.id, order[0]!);
    expect((await answer(round2.id, order[0]!, "nope")).requeued).toBe(true);
  });

  it("ends a round on request, again harmlessly, and only the caller's", async () => {
    expect((await inject("POST", endUrl(round2.id), bob.headers)).statusCode).toBe(404);
    expect((await inject("POST", endUrl(randomUUID()), alice.headers)).statusCode).toBe(404);
    expect((await inject("POST", endUrl(round2.id), alice.headers)).statusCode).toBe(204);
    const ended = (await roundRow(round2.id)).endedAt;
    expect(ended).not.toBeNull();
    server.clock.set(new Date(server.clock.now().getTime() + 1_000));
    expect((await inject("POST", endUrl(round2.id), alice.headers)).statusCode).toBe(204);
    expect((await roundRow(round2.id)).endedAt).toEqual(ended);
    expect((await inject("POST", serveUrl(round2.id, round2.cards[0]!.id), alice.headers)).statusCode).toBe(404);
  });

  it("lists the caller's rounds with a card answered, newest first, as the teacher sees them", async () => {
    const idle = (await start(alice.headers, ids.course))!;
    const res = await as(alice.headers, "GET", roundsUrl());
    expect(res.statusCode).toBe(200);
    const rounds = (res.json() as unknown[]).map((r) => StudentRevisionRound.parse(r));
    const pointers = { id: ids.course, label: LABELS.course, qualifier: "" };
    expect(rounds).toEqual([
      { id: round2.id, concept: pointers, startedAt: round2.startedAt, endedAt: expect.any(String), cardsServed: 1, cardsCorrect: 0 },
      { id: round1.id, concept: pointers, startedAt: T0, endedAt: expect.any(String), cardsServed: 10, cardsCorrect: 9 },
    ]);
    expect(rounds.map((r) => r.id)).not.toContain(idle.id);
    expect((await as(bob.headers, "GET", roundsUrl())).json()).toEqual([]);
  });

  it("names a merged concept by its winner, and no concept once it leaves the course's list", async () => {
    const merged = randomUUID();
    const at = new Date(T0);
    await db().insert(concepts).values({ id: merged, status: "validated", labelEn: "Merged away", keyEn: "merged away", createdAt: at, updatedAt: at });
    const id = randomUUID();
    await db().insert(drillRevisionRounds).values({ id, userId: alice.id, classroomId: seed.classroomId, conceptId: merged, cardIds: [C.narrow], startedAt: at, cardsServed: 1 });
    await db().update(concepts).set({ status: "merged", mergedInto: ids.course }).where(eq(concepts.id, merged));
    const named = async () =>
      ((await as(alice.headers, "GET", roundsUrl())).json() as StudentRevisionRound[]).find((r) => r.id === id)!.concept;
    expect(await named()).toEqual({ id: ids.course, label: LABELS.course, qualifier: "" });
    const put = (list: string[]) => inject("PUT", `/app/api/courses/${seed.courseId}/concepts`, teacher.headers, { conceptIds: list });
    expect((await put([ids.proposed, ids.second, ids.idle])).statusCode).toBe(200);
    expect(await named()).toBeNull();
    expect((await put([ids.course, ids.proposed, ids.second, ids.idle])).statusCode).toBe(200);
    await db().delete(drillRevisionRounds).where(eq(drillRevisionRounds.id, id));
  });
});

describe("targeted revision: the drill's day", () => {
  it("serves and answers a round only within the day it started on", async () => {
    server.clock.set("2026-11-20T22:58:00.000Z");
    const late = (await start(alice.headers, ids.course))!;
    const card = late.cards[0]!.id;
    await serve(late.id, card);
    server.clock.set("2026-11-20T23:00:30.000Z");
    expect((await inject("POST", serveUrl(late.id, card), alice.headers)).statusCode).toBe(404);
    expect((await inject("POST", answerUrl(late.id, card), alice.headers, { answer: "x" })).statusCode).toBe(404);
  });

  it("gives the card back to the daily session the next day", async () => {
    const daily = DrillSession.parse((await inject("GET", "/app/api/drill/session", alice.headers)).json());
    expect(daily.cards.map((c) => c.id)).toContain(C.narrow);
  });
});

describe("targeted revision: who may revise", () => {
  let open: RevisionRound;
  const closedTo = async () => {
    expect(StudentRevisionConcepts.parse((await as(alice.headers, "GET", conceptsUrl())).json())).toEqual({ available: false, concepts: [] });
    expect((await inject("POST", roundsUrl(), alice.headers, { conceptId: ids.course })).statusCode).toBe(404);
    expect((await inject("POST", serveUrl(open.id, open.cards[0]!.id), alice.headers)).statusCode).toBe(404);
  };

  beforeAll(async () => {
    open = (await start(alice.headers, ids.course))!;
  });

  it("is closed to a student who opted out, and open again when they come back", async () => {
    await setDrillOptOut(db(), seed.classroomId, alice.id, true, server.clock.now());
    await closedTo();
    await setDrillOptOut(db(), seed.classroomId, alice.id, false, server.clock.now());
    expect(StudentRevisionConcepts.parse((await as(alice.headers, "GET", conceptsUrl())).json()).available).toBe(true);
  });

  it("is closed while the classroom's drill is off, or the classroom archived", async () => {
    await db().update(classrooms).set({ drillEnabledAt: null }).where(eq(classrooms.id, seed.classroomId));
    await closedTo();
    await db().update(classrooms).set({ drillEnabledAt: new Date(T0), archivedAt: new Date(T0) }).where(eq(classrooms.id, seed.classroomId));
    await closedTo();
    await db().update(classrooms).set({ archivedAt: null }).where(eq(classrooms.id, seed.classroomId));
    expect((await serve(open.id, open.cards[0]!.id)).pass).toBe(1);
  });

  it("is closed to a teacher in the student view, whose staff seat holds no card", async () => {
    const concepts = await as(teacher.headers, "GET", conceptsUrl());
    expect(concepts.json()).toEqual({ available: false, concepts: [] });
    expect((await as(teacher.headers, "GET", roundsUrl())).json()).toEqual([]);
    expect((await inject("POST", roundsUrl(), teacher.headers, { conceptId: ids.course })).statusCode).toBe(404);
  });

  it("lets an impersonation session read what the student reads, and write nothing", async () => {
    const as_ = await sessionOf(db(), alice.id, { kind: "impersonation", actorUserId: admin.id });
    for (const url of [conceptsUrl(), roundsUrl()]) {
      expect((await as(as_, "GET", url)).body).toBe((await inject("GET", url, alice.headers)).body);
    }
    for (const [url, payload] of [
      [roundsUrl(), { conceptId: ids.course }],
      [serveUrl(open.id, open.cards[0]!.id), undefined],
      [answerUrl(open.id, open.cards[0]!.id), { answer: "x" }],
      [endUrl(open.id)],
    ] as [string, Payload | undefined][]) {
      const res = await inject("POST", url, as_, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "impersonation_read_only" });
    }
  });

  it("refuses a seb and a kiosk session with a 401", async () => {
    const seb = await sessionOf(db(), alice.id, { kind: "seb", evaluationId: seed.evaluationId });
    const station = await kioskStation(server.app);
    const kiosk = await sessionOf(db(), alice.id, { kind: "kiosk", evaluationId: seed.evaluationId, deviceId: station.deviceId });
    for (const headers of [seb, { ...kiosk, cookie: `${kiosk.cookie}; ${station.cookie}` }]) {
      expect((await inject("GET", conceptsUrl(), headers)).statusCode).toBe(401);
      expect((await inject("GET", roundsUrl(), headers)).statusCode).toBe(401);
      expect((await inject("POST", serveUrl(open.id, open.cards[0]!.id), headers)).statusCode).toBe(401);
    }
  });

  it("is the 404 of a missing thing to an outsider, another student and for foreign ids", async () => {
    expect((await inject("GET", conceptsUrl(), outsider.headers)).statusCode).toBe(404);
    expect((await inject("GET", roundsUrl(), outsider.headers)).statusCode).toBe(404);
    expect((await inject("POST", roundsUrl(), outsider.headers, { conceptId: ids.course })).statusCode).toBe(404);
    expect((await inject("GET", conceptsUrl(randomUUID()), alice.headers)).statusCode).toBe(404);
    const card = open.cards[0]!.id;
    for (const who of [bob, outsider]) {
      expect((await inject("POST", serveUrl(open.id, card), who.headers)).statusCode).toBe(404);
      expect((await inject("POST", answerUrl(open.id, card), who.headers, { answer: "x" })).statusCode).toBe(404);
      expect((await inject("POST", endUrl(open.id), who.headers)).statusCode).toBe(404);
    }
    expect((await inject("POST", serveUrl(randomUUID(), card), alice.headers)).statusCode).toBe(404);
    // Her own card, outside the round.
    expect((await inject("POST", serveUrl(open.id, excludedCards[3]!), alice.headers)).statusCode).toBe(404);
    expect((await inject("POST", serveUrl(open.id, "nope"), alice.headers)).statusCode).toBe(404);
  });

  it("keeps each classroom's rounds to its own cards", async () => {
    const own = (await start(alice.headers, ids.course, other.classroomId))!;
    expect(own.cards.map((c) => c.id)).toEqual([excludedCards[4]]);
    await db().delete(enrollments).where(and(eq(enrollments.classroomId, other.classroomId), eq(enrollments.userId, alice.id)));
    expect((await inject("GET", conceptsUrl(other.classroomId), alice.headers)).statusCode).toBe(404);
    expect((await inject("POST", serveUrl(own.id, excludedCards[4]!), alice.headers)).statusCode).toBe(404);
  });
});

describe("targeted revision: the leak test (05 §5.7)", () => {
  it("never carries a forbidden key, nor a name, explanation, excluded card, other concept or other student", async () => {
    expect(seen.length).toBeGreaterThan(20);
    /** Every key of `value`, but `root` at its top (walked on its own below). */
    const keys = (value: unknown, root: string | null, out = new Set<string>()): Set<string> => {
      if (Array.isArray(value)) value.forEach((v) => keys(v, null, out));
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          if (k === root) continue;
          out.add(k);
          keys(v, null, out);
        }
      }
      return out;
    };
    const needles = [
      "INTERNAL-",
      "EXPLANATION-SECRET",
      "EXCLUDED-",
      ...Object.values(Q).flat(),
      ...excludedCards.filter((id) => id !== excludedCards[4]),
      ids.narrow,
      ids.proposedNarrow,
      ids.proposed,
      ids.foreign,
      LABELS.narrow,
      LABELS.proposedNarrow,
      LABELS.proposed,
      LABELS.foreign,
      bob.id,
      "Nom1",
      "Prenom1",
      // Bob's roster and account addresses.
      ...(await db().select({ email: enrollments.email }).from(enrollments).where(eq(enrollments.userId, bob.id))).map((r) => r.email),
      ...(await db().select({ email: users.email }).from(users).where(eq(users.id, bob.id))).map((r) => r.email),
    ];
    expect(needles.filter((n) => n.includes("@"))).toHaveLength(2);
    for (const { body, root } of seen) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const found = keys(parsed, root);
      if (root !== null) keys(parsed[root], null, found);
      for (const key of FORBIDDEN_STUDENT_KEYS) expect(found.has(key), `${key} in ${body}`).toBe(false);
      for (const needle of needles) expect(body, needle).not.toContain(needle);
    }
  });
});

describe("targeted revision: retention and cascades", () => {
  it("purges a round five years after it started, its answers with it", async () => {
    const old = randomUUID();
    const sixYears = new Date("2020-10-01T08:00:00.000Z");
    await db().insert(drillRevisionRounds).values({ id: old, userId: alice.id, classroomId: seed.classroomId, conceptId: ids.course, cardIds: [C.narrow], startedAt: sixYears, cardsServed: 1 });
    await db().insert(drillRevisionAnswers).values({ id: randomUUID(), roundId: old, cardId: C.narrow, pass: 1, servedAt: sixYears, serveSeed: 1 });
    const before = (await db().select().from(drillRevisionRounds)).length;
    expect((await purgeExpiredDrill(db(), server.clock.now())).rounds).toBe(1);
    expect(await db().select().from(drillRevisionRounds)).toHaveLength(before - 1);
    expect(await db().select().from(drillRevisionAnswers).where(eq(drillRevisionAnswers.roundId, old))).toHaveLength(0);
  });

  it("keeps a round's counters when the teacher removes the cards it served", async () => {
    const removed = await inject("DELETE", `/app/api/evaluations/${seed.evaluationId}/drill/cards`, teacher.headers);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await db().select().from(drillRevisionAnswers).where(eq(drillRevisionAnswers.roundId, round1.id))).toHaveLength(0);
    expect(await roundRow(round1.id)).toMatchObject({ cardsServed: 10, cardsCorrect: 9 });
  });
});
